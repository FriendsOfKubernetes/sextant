import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind, WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { kindFromApiVersion, resetClusterKinds } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches, setWatchLinger } from "../resource-map/watches";
import { resetAutoscalingTaps } from "./hooks";
import "./index";
import {
  CONFIG_MAP,
  DEPLOYMENT,
  EVENT,
  HPA,
  NODE,
  NODE_CLAIM,
  NODE_POOL,
  POD,
  PVC,
  SCALED_JOB,
  SCALED_OBJECT,
  TRIGGER_AUTHENTICATION,
  CLUSTER_TRIGGER_AUTHENTICATION,
  EC2_NODE_CLASS,
} from "./model";

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const BUILT_IN = [served(POD), served(NODE, false), served(DEPLOYMENT), served(HPA), served(EVENT), served(CONFIG_MAP), served(PVC)];
const KEDA = [served(SCALED_OBJECT), served(SCALED_JOB), served(TRIGGER_AUTHENTICATION), served(CLUSTER_TRIGGER_AUTHENTICATION, false)];
const KARPENTER = [served(NODE_POOL, false), served(NODE_CLAIM, false), served(EC2_NODE_CLASS, false)];

let wb: WatchBackend;
let discovery: ResourceKind[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetAutoscalingTaps();
  setWatchLinger(0);
  discovery = [...BUILT_IN, ...KEDA, ...KARPENTER];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery);
});

afterEach(() => {
  resetAutoscalingTaps();
  resetSharedWatches();
  setWatchLinger(null);
  resetProblemSources();
  wb.backend.restore();
  resetClusterKinds();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the KEDA and Karpenter sections", () => {
  it("are listed with the kinds the cluster serves", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("KEDA"));
    expect(sections()).toContain("Karpenter");
    fireEvent.click(screen.getByRole("button", { name: /Karpenter/ }));
    const karpenter = within(screen.getByRole("button", { name: /Karpenter/ }).closest("li")!);
    for (const label of ["Node Pools", "Node Claims", "EC2 Node Classes"]) expect(karpenter.getByRole("button", { name: label })).toBeInTheDocument();
    expect(karpenter.queryByRole("button", { name: "AKS Node Classes" })).toBeNull();
  });

  it("are not there without the tools", async () => {
    discovery = [...BUILT_IN];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("KEDA");
    expect(sections()).not.toContain("Karpenter");
  });
});

// ---------- Details ----------

function refTo(obj: KubeObject): ObjectRef {
  return { kind: kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? ""), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

const everywhere = (s: WatchSpec) => s.namespaces === null && s.fieldSelector === null;
const inShop = (s: WatchSpec) => JSON.stringify(s.namespaces) === '["shop"]' && s.fieldSelector === null;

const HPA_OBJ: KubeObject = {
  apiVersion: "autoscaling/v2",
  kind: "HorizontalPodAutoscaler",
  metadata: { name: "web", namespace: "shop", uid: "hpa-1" },
  spec: {
    scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "web" },
    minReplicas: 2,
    maxReplicas: 10,
    metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 50 } } }],
  },
  status: {
    currentReplicas: 2,
    desiredReplicas: 4,
    currentMetrics: [{ type: "Resource", resource: { name: "cpu", current: { averageUtilization: 90 } } }],
    conditions: [
      { type: "AbleToScale", status: "True", reason: "SucceededRescale" },
      { type: "ScalingActive", status: "True", reason: "ValidMetricFound" },
      { type: "ScalingLimited", status: "False", reason: "DesiredWithinRange" },
    ],
  },
};

const DEPLOYMENT_OBJ: KubeObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "shop", uid: "dep-1" },
  spec: {
    replicas: 2,
    template: { spec: { containers: [{ name: "app", resources: { requests: { cpu: "100m" } } }, { name: "proxy" }] } },
  },
};

describe("HPA details", () => {
  it("say why it scales, compare each metric with its target and check the target's requests", async () => {
    await openDetails(HPA_OBJ);
    const hpa = within(section("autoscalingHpa"));
    expect(hpa.getByText("Scaling from 2 to 4 replicas.")).toBeInTheDocument();
    expect(hpa.getByText("Resource cpu")).toBeInTheDocument();
    expect(hpa.getByText("90%")).toBeInTheDocument();
    expect(hpa.getByText("50% (Utilization)")).toBeInTheDocument();
    expect(hpa.getByText("The last change of the replica count succeeded.")).toBeInTheDocument();
    expect(hpa.getByRole("button", { name: "Open Deployment web" })).toBeInTheDocument();
    // The target is watched by name; its template has a container without a CPU request.
    const target = await watchOf(wb, "Deployment", (s) => s.fieldSelector === "metadata.name=web");
    emitSnapshot(wb, target, [DEPLOYMENT_OBJ]);
    await waitFor(() => expect(hpa.getByText(/these containers have no cpu request: proxy/)).toBeInTheDocument());
  });
});

describe("workload details", () => {
  it("name the HPA that scales the workload", async () => {
    await openDetails(DEPLOYMENT_OBJ);
    emitSnapshot(wb, await watchOf(wb, "HorizontalPodAutoscaler", inShop), [HPA_OBJ]);
    const workload = within(section("autoscalingWorkload"));
    await waitFor(() => expect(workload.getByRole("button", { name: "Open HorizontalPodAutoscaler web" })).toBeInTheDocument());
    expect(workload.getByText("Scaling from 2 to 4 replicas.")).toBeInTheDocument();
  });

  it("draw nothing for a workload nothing scales", async () => {
    await openDetails(DEPLOYMENT_OBJ);
    emitSnapshot(wb, await watchOf(wb, "HorizontalPodAutoscaler", inShop), []);
    emitSnapshot(wb, await watchOf(wb, "ScaledObject", inShop), []);
    await waitFor(() => expect(document.querySelector("[data-section='autoscalingWorkload']")?.textContent ?? "").toBe(""));
  });
});

const GI = "16Gi";
const nodeObj = (name: string, extra: Record<string, unknown> = {}): KubeObject => ({
  apiVersion: "v1",
  kind: "Node",
  metadata: { name, uid: `node-${name}`, labels: { "kubernetes.io/hostname": name } },
  spec: { ...extra },
  status: { allocatable: { cpu: "2", memory: GI, pods: "110" } },
});

const PENDING: KubeObject = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "web-1", namespace: "shop", uid: "pod-1" },
  spec: { containers: [{ name: "app", resources: { requests: { cpu: "1500m", memory: "1Gi" } } }] },
  status: {
    phase: "Pending",
    conditions: [
      {
        type: "PodScheduled",
        status: "False",
        reason: "Unschedulable",
        message: "0/2 nodes are available: 1 Insufficient cpu, 1 node(s) had untolerated taint {dedicated: gpu}.",
      },
    ],
  },
};

describe("a Pending pod", () => {
  it("parses the scheduler's message and checks every node", async () => {
    await openDetails(PENDING);
    const sched = within(section("autoscalingScheduling"));
    expect(sched.getByText("Not enough cpu")).toBeInTheDocument();
    expect(sched.getByText("A taint the Pod does not tolerate: dedicated: gpu")).toBeInTheDocument();
    // Nodes and bound pods come from the cluster-wide watches the problems store holds.
    emitSnapshot(wb, await watchOf(wb, "Node", everywhere), [
      nodeObj("busy"),
      nodeObj("gpu", { taints: [{ key: "dedicated", value: "gpu", effect: "NoSchedule" }] }),
    ]);
    emitSnapshot(wb, await watchOf(wb, "Pod", everywhere), [
      { metadata: { name: "other", namespace: "shop", uid: "p2" }, spec: { nodeName: "busy", containers: [{ resources: { requests: { cpu: "1" } } }] }, status: { phase: "Running" } },
    ]);
    await waitFor(() => expect(sched.getByText("By this check, no node fits.")).toBeInTheDocument());
    expect(sched.getByText("Not enough cpu: the Pod requests 1500m, 1 of 2 is free")).toBeInTheDocument();
    expect(sched.getByText("Taint dedicated=gpu:NoSchedule is not tolerated")).toBeInTheDocument();
    expect(sched.getByRole("button", { name: "Open Node busy" })).toBeInTheDocument();
  });

  it("is not shown for a running pod", async () => {
    await openDetails({ ...PENDING, spec: { ...(PENDING.spec as object), nodeName: "busy" }, status: { phase: "Running" } });
    expect(document.querySelector("[data-section='autoscalingScheduling']")?.textContent ?? "").toBe("");
  });
});

describe("a Karpenter node", () => {
  it("names its NodePool and NodeClaim and why it is disrupted", async () => {
    const node: KubeObject = {
      ...nodeObj("ip-10-0-1-1"),
      metadata: { name: "ip-10-0-1-1", uid: "n1", labels: { "karpenter.sh/nodepool": "default", "karpenter.sh/capacity-type": "spot" } },
    };
    await openDetails(node);
    emitSnapshot(wb, await watchOf(wb, "NodeClaim", everywhere), [
      {
        apiVersion: "karpenter.sh/v1",
        kind: "NodeClaim",
        metadata: { name: "default-abcde", uid: "nc1", labels: { "karpenter.sh/nodepool": "default" } },
        status: { nodeName: "ip-10-0-1-1", conditions: [{ type: "Drifted", status: "True", reason: "NodePoolDrifted" }] },
      },
    ]);
    emitSnapshot(wb, await watchOf(wb, "NodePool", everywhere), [{ apiVersion: "karpenter.sh/v1", kind: "NodePool", metadata: { name: "default", uid: "np1" }, spec: {} }]);
    const node1 = within(section("autoscalingNode"));
    await waitFor(() => expect(node1.getByRole("button", { name: "Open NodeClaim default-abcde" })).toBeInTheDocument());
    expect(node1.getByRole("button", { name: "Open NodePool default" })).toBeInTheDocument();
    expect(node1.getByText("spot")).toBeInTheDocument();
    expect(node1.getByText(/Drifted \(NodePoolDrifted\)/)).toBeInTheDocument();
  });
});
