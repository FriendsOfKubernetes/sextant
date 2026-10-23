import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type ClusterInfo, type KindRef, type KubeObject, type ObjectRef, type ResourceKind, type WatchSpec } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import "./index";
import { CATEGORY_SOURCES } from "../problems/sources";
import { categoryOf, detect, OPT_IN_CATEGORIES, PROBLEM_CATEGORIES } from "../problems/model";
import { planChain } from "./chain";
import objectsJson from "./fixtures/objects.json";
import {
  CAPI_CLUSTER,
  CAPI_GRACE_MS,
  capiProblems,
  clusterState,
  conditionsOf,
  healthCheckSpecOf,
  healthCheckState,
  isLegacy,
  isProblem,
  KUBEADM_CONTROL_PLANE,
  MACHINE,
  MACHINE_DEPLOYMENT,
  MACHINE_HEALTH_CHECK,
  MACHINE_SET,
  machineSelectorOf,
  machineState,
  PROVISIONING_GRACE_MS,
  providerFields,
  providerReady,
  refFrom,
  replicasOf,
  scalableState,
  selectorString,
  serverMatches,
} from "./model";

const objects = objectsJson as KubeObject[];
const byName = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata?.name === name)!);
const cluster = () => byName("Cluster", "capi-quickstart");
const kcp = () => byName("KubeadmControlPlane", "capi-quickstart-n5w87");
const deployment = () => byName("MachineDeployment", "capi-quickstart-md-0-6xq7b");
const machineSet = () => byName("MachineSet", "capi-quickstart-md-0-6xq7b-k9dpl");
const cpMachine = () => byName("Machine", "capi-quickstart-n5w87-hz4sv");
const runningWorker = () => byName("Machine", "capi-quickstart-md-0-6xq7b-k9dpl-2vbjm");
const stuckWorker = () => byName("Machine", "capi-quickstart-md-0-6xq7b-k9dpl-5tq8w");
const healthCheck = () => byName("MachineHealthCheck", "capi-quickstart-node-unhealthy-5m");
const legacyMachine = () => byName("Machine", "legacy-md-0-abcde-fghij");
const legacyDeployment = () => byName("MachineDeployment", "legacy-md-0");

describe("the model", () => {
  it("reads a v1beta2 Cluster's state from its phase and Available condition", () => {
    expect(clusterState(cluster())).toBe("notAvailable");
    const ok = cluster();
    (ok.status as { conditions: { type: string; status: string }[] }).conditions[0]!.status = "True";
    expect(clusterState(ok)).toBe("available");
    const coming = cluster();
    (coming.status as Record<string, unknown>).phase = "Provisioning";
    expect(clusterState(coming)).toBe("provisioning");
    const paused = cluster();
    (paused.spec as Record<string, unknown>).paused = true;
    expect(clusterState(paused)).toBe("paused");
    expect(capiProblems(CAPI_CLUSTER, paused)).toEqual([]);
  });

  it("reads a v1beta1 object's new conditions under status.v1beta2 and its failure fields on status", () => {
    const old = legacyMachine();
    expect(isLegacy(old)).toBe(true);
    expect(conditionsOf(old).map((c) => c.type)).toEqual(["Ready", "InfrastructureReady"]);
    expect(machineState(old)).toBe("failed");
    expect(capiProblems(MACHINE, old)).toEqual([expect.objectContaining({ reason: "Failed", message: expect.stringContaining("InsufficientInstanceCapacity"), notify: true })]);
    // Counts by the new meaning when status.v1beta2 has them, else the old ones.
    expect(replicasOf(legacyDeployment())).toEqual({ desired: 3, current: 3, ready: 1, available: 2, upToDate: 3 });
    const older = legacyDeployment();
    delete (older.status as Record<string, unknown>).v1beta2;
    expect(replicasOf(older)).toEqual({ desired: 3, current: 3, ready: 2, available: 2, upToDate: 3 });
    expect(scalableState(older)).toBe("available");
  });

  it("references in both shapes", () => {
    expect(refFrom({ apiGroup: "infrastructure.cluster.x-k8s.io", kind: "DockerMachine", name: "m" }, "default")).toEqual({
      group: "infrastructure.cluster.x-k8s.io",
      version: undefined,
      kind: "DockerMachine",
      name: "m",
      namespace: "default",
    });
    expect(refFrom({ apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2", kind: "AWSMachine", name: "a", namespace: "legacy" }, "x")).toEqual({
      group: "infrastructure.cluster.x-k8s.io",
      version: "v1beta2",
      kind: "AWSMachine",
      name: "a",
      namespace: "legacy",
    });
    expect(refFrom({ kind: "X" }, null)).toBeUndefined();
  });

  it("selectors as the API server reads them", () => {
    expect(machineSelectorOf(deployment())).toBe("cluster.x-k8s.io/cluster-name=capi-quickstart,topology.cluster.x-k8s.io/deployment-name=md-0");
    expect(
      selectorString({
        matchLabels: { a: "1" },
        matchExpressions: [
          { key: "b", operator: "In", values: ["x", "y"] },
          { key: "c", operator: "NotIn", values: ["z"] },
          { key: "d", operator: "Exists" },
          { key: "e", operator: "DoesNotExist" },
        ],
      }),
    ).toBe("a=1,b in (x,y),c notin (z),d,!e");
    expect(selectorString({})).toBeUndefined();
  });

  it("matches a kubeconfig server to the control plane endpoint by host and port only", () => {
    const endpoint = { host: "172.18.0.3", port: 6443 };
    expect(serverMatches("https://172.18.0.3:6443", endpoint)).toBe(true);
    expect(serverMatches("https://172.18.0.3", endpoint)).toBe(false);
    expect(serverMatches("https://127.0.0.1:6443", endpoint)).toBe(false);
    expect(serverMatches("https://API.example.com", { host: "api.example.com", port: 443 })).toBe(true);
    expect(serverMatches("https://[fd00::1]:6443", { host: "fd00::1", port: 6443 })).toBe(true);
    expect(serverMatches("not a url", endpoint)).toBe(false);
  });

  it("provider objects by the contract, and a few known kinds' fields", () => {
    const dm = byName("DockerMachine", "capi-quickstart-md-0-6xq7b-k9dpl-5tq8w");
    expect(providerReady(dm)).toBe(false);
    expect(providerReady(byName("KubeadmConfig", "capi-quickstart-md-0-6xq7b-k9dpl-5tq8w"))).toBe(true);
    expect(providerReady({ apiVersion: "infrastructure.cluster.x-k8s.io/v1beta1", kind: "X", status: { ready: true } })).toBe(true);
    expect(providerReady({ apiVersion: "x/v1", kind: "X" })).toBeUndefined();
    expect(providerFields(dm)).toEqual([["customImage", "kindest/node:v1.34.0"]]);
    const aws: KubeObject = { apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2", kind: "AWSMachine", spec: { instanceType: "t3.large" }, status: { instanceState: "running" } };
    expect(providerFields(aws)).toEqual([
      ["instanceType", "t3.large"],
      ["instanceState", "running"],
      ["instanceId", undefined],
    ]);
    expect(providerFields({ apiVersion: "other.io/v1", kind: "AWSMachine" })).toEqual([]);
  });
});

describe("problems", () => {
  it("a Cluster not available counts after 5 minutes once provisioned, 30 while provisioning", () => {
    const [d] = capiProblems(CAPI_CLUSTER, cluster());
    expect(d).toMatchObject({ reason: "NotAvailable", since: "2026-10-20T10:05:00Z", graceMs: CAPI_GRACE_MS });
    const coming = cluster();
    (coming.status as Record<string, unknown>).phase = "Provisioning";
    expect(capiProblems(CAPI_CLUSTER, coming)[0]?.graceMs).toBe(PROVISIONING_GRACE_MS);
    expect(isProblem(cluster(), CAPI_CLUSTER, Date.parse("2026-10-20T10:06:00Z"))).toBe(false);
    expect(isProblem(cluster(), CAPI_CLUSTER, Date.parse("2026-10-20T10:11:00Z"))).toBe(true);
  });

  it("a Machine stuck before Running counts 30 minutes after its phase changed; a running one has none", () => {
    expect(capiProblems(MACHINE, stuckWorker())).toEqual([
      expect.objectContaining({ reason: "ProvisioningStuck", message: "Waiting for DockerMachine to become ready", since: "2026-10-20T10:01:00Z", graceMs: PROVISIONING_GRACE_MS, stamp: "Provisioning" }),
    ]);
    expect(capiProblems(MACHINE, cpMachine())).toEqual([]);
    expect(capiProblems(MACHINE, runningWorker())).toEqual([]);
    const deleting = stuckWorker();
    deleting.metadata!.deletionTimestamp = "2026-10-20T12:00:00Z";
    expect(capiProblems(MACHINE, deleting)).toEqual([]);
  });

  it("a control plane not available, and remediation blocked by too many unhealthy machines", () => {
    expect(capiProblems(KUBEADM_CONTROL_PLANE, kcp())).toEqual([]);
    expect(scalableState(kcp())).toBe("available");
    const down = kcp();
    (down.status as { conditions: { status: string }[] }).conditions[0]!.status = "False";
    expect(capiProblems(KUBEADM_CONTROL_PLANE, down)[0]).toMatchObject({ reason: "NotAvailable", graceMs: CAPI_GRACE_MS });
    expect(healthCheckState(healthCheck())).toBe("blocked");
    expect(capiProblems(MACHINE_HEALTH_CHECK, healthCheck())).toEqual([expect.objectContaining({ reason: "RemediationBlocked", message: expect.stringContaining("exceeds maxUnhealthy") })]);
    expect(healthCheckSpecOf(healthCheck())).toEqual({
      nodeConditions: [
        { type: "Ready", status: "Unknown", timeout: "300s" },
        { type: "Ready", status: "False", timeout: "300s" },
      ],
      machineConditions: [
        { type: "NodeReady", status: "Unknown", timeout: "1800s" },
        { type: "InfrastructureReady", status: "False", timeout: "1800s" },
      ],
      nodeStartupTimeout: "600s",
      maxUnhealthy: "40%",
      unhealthyRange: undefined,
    });
  });

  it("the category is on by default, watches four kinds with Machines capped, and is judged by these rules", () => {
    expect(PROBLEM_CATEGORIES).toContain("clusterApi");
    expect(OPT_IN_CATEGORIES).not.toContain("clusterApi");
    expect(CATEGORY_SOURCES.clusterApi.map((s) => [s.kind.kind, s.maxObjects])).toEqual([
      ["Cluster", undefined],
      ["KubeadmControlPlane", undefined],
      ["Machine", 5000],
      ["MachineHealthCheck", undefined],
    ]);
    expect(categoryOf(MACHINE)).toBe("clusterApi");
    expect(categoryOf(MACHINE_DEPLOYMENT)).toBeUndefined();
    expect(categoryOf({ group: "postgresql.cnpg.io", kind: "Cluster" })).toBe("cnpg");
    expect(detect(MACHINE, stuckWorker()).map((d) => d.reason)).toEqual(["ProvisioningStuck"]);
  });
});

describe("the chain", () => {
  it("groups Machines under the control plane, their MachineSet and its MachineDeployment, within a cap", () => {
    const plan = planChain([deployment()], [machineSet()], [cpMachine(), runningWorker(), stuckWorker()], 50);
    expect(plan.controlPlane.map((m) => m.metadata?.name)).toEqual(["capi-quickstart-n5w87-hz4sv"]);
    expect(plan.deployments).toHaveLength(1);
    expect(plan.deployments[0]!.sets[0]!.machines.map((m) => m.metadata?.name)).toEqual(["capi-quickstart-md-0-6xq7b-k9dpl-2vbjm", "capi-quickstart-md-0-6xq7b-k9dpl-5tq8w"]);
    expect(plan.sets).toEqual([]);
    expect(plan.others).toEqual([]);
    const capped = planChain([deployment()], [machineSet()], [cpMachine(), runningWorker(), stuckWorker()], 2);
    expect(capped.hidden).toBe(1);
    const lone = planChain([], [], [legacyMachine()], 50);
    expect(lone.others).toHaveLength(1);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const servedKind = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const DOCKER_MACHINE: KindRef = { group: "infrastructure.cluster.x-k8s.io", version: "v1beta2", kind: "DockerMachine" };
const DOCKER_CLUSTER: KindRef = { group: "infrastructure.cluster.x-k8s.io", version: "v1beta2", kind: "DockerCluster" };
const KUBEADM_CONFIG: KindRef = { group: "bootstrap.cluster.x-k8s.io", version: "v1beta2", kind: "KubeadmConfig" };

let wb: WatchBackend;
let discovery: KindRef[];
let reads: ObjectRef[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  resetClustersStore();
  discovery = [POD, CAPI_CLUSTER, KUBEADM_CONTROL_PLANE, MACHINE_DEPLOYMENT, MACHINE_SET, MACHINE, MACHINE_HEALTH_CHECK, DOCKER_MACHINE, DOCKER_CLUSTER, KUBEADM_CONFIG];
  reads = [];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(servedKind));
  wb.backend.on("settings_get", () => defaultAppSettings());
  wb.backend.on("resource_get", (args) => {
    const ref = args.ref as ObjectRef;
    reads.push(ref);
    const found = objects.find((o) => o.kind === ref.kind.kind && o.metadata?.name === ref.name);
    if (!found) throw { code: "notFound", message: "not found" };
    return copy(found);
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetClustersStore();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the Cluster API section", () => {
  it("is there for a cluster that serves the kinds and counts failed machines", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Cluster API"));
    emitSnapshot(wb, await watchOf(wb, "Machine", (s) => s.namespaces === null), [legacyMachine(), cpMachine()]);
    await waitFor(() => expect(screen.getByTitle("1 object needs attention")).toHaveTextContent("1"));
  });

  it("is not there without the CRDs", async () => {
    discovery = [POD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Workloads"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("Cluster API");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  const [group = "", version = ""] = (obj.apiVersion ?? "").split("/");
  return { kind: { group, version, kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  await waitFor(() => expect(document.querySelector("[data-section='clusterApi']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='clusterApi']")!);
const byLabel = (kind: string) => (s: WatchSpec) => s.kind.kind === kind && s.labelSelector !== null;

function withWorkloadCluster(server: string): void {
  useClustersStore.setState({
    clusters: [{ id: "w1", context: "kind-capi-quickstart", clusterName: "kind-capi-quickstart", server, user: "u", namespace: null, sourceId: "s" } as unknown as ClusterInfo],
  });
}

describe("details", () => {
  it("of a Cluster: why it is not available, its control plane and infrastructure, the workload cluster and the machine chain", async () => {
    withWorkloadCluster("https://172.18.0.3:6443");
    const container = await openDetails(cluster());
    const v = view();
    expect(v.getByText("The cluster is not available: one of the checks behind its Available condition fails.")).toBeInTheDocument();
    expect(v.getAllByText("Not available")[0]).toHaveClass("rt-status--danger");
    expect(v.getByRole("button", { name: "Open KubeadmControlPlane capi-quickstart-n5w87" })).toBeInTheDocument();
    expect(v.getByText("1 of 2 ready")).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open cluster kind-capi-quickstart" })).toBeInTheDocument();
    await waitFor(() => expect(v.getAllByText("Ready").length).toBeGreaterThan(0));
    // DockerCluster is not in the fixtures: missing.
    await waitFor(() => expect(v.getByText("Missing")).toBeInTheDocument());
    const label = "cluster.x-k8s.io/cluster-name=capi-quickstart";
    emitSnapshot(wb, await watchOf(wb, "MachineDeployment", (s) => byLabel("MachineDeployment")(s) && s.labelSelector === label), [deployment()]);
    emitSnapshot(wb, await watchOf(wb, "MachineSet", (s) => byLabel("MachineSet")(s)), [machineSet()]);
    const machinesWatch = await watchOf(wb, "Machine", (s) => byLabel("Machine")(s));
    expect(wb.specs.get(machinesWatch)).toMatchObject({ namespaces: ["default"], labelSelector: label });
    emitSnapshot(wb, machinesWatch, [cpMachine(), runningWorker(), stuckWorker()]);
    await waitFor(() => expect(v.getByRole("button", { name: "Open Machine capi-quickstart-md-0-6xq7b-k9dpl-5tq8w" })).toBeInTheDocument());
    expect(v.getAllByText("Control plane")).toHaveLength(2);
    expect(v.getByRole("button", { name: "Open MachineSet capi-quickstart-md-0-6xq7b-k9dpl" })).toBeInTheDocument();
    expect(v.getByText("Node capi-quickstart-n5w87-hz4sv")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a stuck Machine: its bootstrap and infrastructure objects, read by name", async () => {
    const container = await openDetails(stuckWorker());
    const v = view();
    expect(v.getByText("The machine has not reached Running yet (phase Provisioning).")).toBeInTheDocument();
    await waitFor(() => expect(v.getByText("kindest/node:v1.34.0")).toBeInTheDocument());
    expect(v.getByText("Not ready")).toHaveClass("rt-status--warning");
    expect(v.getByRole("button", { name: "Open DockerMachine capi-quickstart-md-0-6xq7b-k9dpl-5tq8w" })).toBeInTheDocument();
    expect(reads.map((r) => r.kind.kind).sort()).toEqual(["Cluster", "DockerMachine", "KubeadmConfig"]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a running Machine: the Node opens in the workload cluster only on a click", async () => {
    withWorkloadCluster("https://172.18.0.3:6443");
    await openDetails(cpMachine());
    const v = view();
    const open = await waitFor(() => v.getByRole("button", { name: "Open Node capi-quickstart-n5w87-hz4sv in kind-capi-quickstart" }));
    expect(wb.backend.calls.some((c) => c.cmd === "cluster_connect")).toBe(false);
    act(() => open.click());
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_connect" && c.args.clusterId === "w1")).toBe(true));
  });

  it("of a MachineHealthCheck: what it checks and why remediation is blocked", async () => {
    const container = await openDetails(healthCheck());
    const v = view();
    expect(v.getByText("Remediation is blocked: too many machines are unhealthy (2 of 5 healthy).")).toBeInTheDocument();
    expect(v.getByText(/exceeds maxUnhealthy/)).toBeInTheDocument();
    expect(v.getByText("40%")).toBeInTheDocument();
    expect(v.getAllByText("300s")).toHaveLength(2);
    expect(v.getByRole("button", { name: "Open Machine np0-a" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a MachineDeployment: replica counts and its Machines by its selector", async () => {
    const container = await openDetails(deployment());
    const v = view();
    expect(v.getByText("Not available: fewer machines are available than required.")).toBeInTheDocument();
    const w = await watchOf(wb, "Machine", (s) => s.labelSelector === "cluster.x-k8s.io/cluster-name=capi-quickstart,topology.cluster.x-k8s.io/deployment-name=md-0");
    emitSnapshot(wb, w, [runningWorker(), stuckWorker()]);
    await waitFor(() => expect(v.getAllByRole("row")).toHaveLength(3));
    expect(await axeViolations(container)).toEqual([]);
  });
});
