import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { getPage } from "../../layout/pages";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { categoryOf, detect, OPT_IN_CATEGORIES, PROBLEM_CATEGORIES } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import { judgedByRules, sourcesFor } from "../problems/sources";
import { resetSharedWatches } from "../resource-map/watches";
import fixtures from "./fixtures/objects.json";
import "./index";
import { GPU_NODE_SELECTOR } from "./hooks";
import {
  CLUSTER_POLICY,
  componentsOf,
  gpuNodeOf,
  hasGpu,
  isComponentDaemonSet,
  COMPONENTS,
  migStrategyOf,
  NVIDIA_DRIVER,
  ownedDaemonSets,
  stateOf,
} from "./model";
import { MIG_FAILED_SELECTOR, NOT_READY_GRACE_MS, operandNamespaces, ROLLOUT_GRACE_MS, toProblems, type Seen } from "./provider";
import { GPU_NODES_PAGE_ID } from "./register";

const f = fixtures as unknown as Record<string, KubeObject>;
const daemonSets = () => [f.dsDriver!, f.dsToolkit!, f.dsDevicePlugin!, f.dsOwnedByDriver!];

describe("the model", () => {
  it("reads the state, the operand namespace and the MIG strategy", () => {
    expect(stateOf(f.policyReady!)).toBe("ready");
    expect(stateOf(f.policyNotReady!)).toBe("notReady");
    expect(stateOf({ apiVersion: "nvidia.com/v1", kind: "ClusterPolicy" })).toBe("unknown");
    expect(migStrategyOf(f.policyReady!)).toBe("mixed");
    expect(migStrategyOf(f.policyNotReady!)).toBeUndefined();
    expect(operandNamespaces([f.policyReady!, f.driver!])).toEqual(["gpu-operator"]);
  });

  it("finds each component's DaemonSet by its manifest name; the driver's with its kernel and OS suffix", () => {
    const driver = COMPONENTS.find((c) => c.id === "driver")!;
    expect(isComponentDaemonSet(driver, "nvidia-driver-daemonset-5.15.0-1066-aws-ubuntu22.04")).toBe(true);
    expect(isComponentDaemonSet(driver, "nvidia-driver-daemonset")).toBe(true);
    expect(isComponentDaemonSet(COMPONENTS.find((c) => c.id === "dcgm")!, "nvidia-dcgm-exporter")).toBe(false);
  });

  it("judges components as their IsEnabled() defaults do", () => {
    const rows = componentsOf(f.policyReady!, daemonSets());
    const byId = Object.fromEntries(rows.map((r) => [r.def.id, r]));
    expect(byId.driver).toMatchObject({ enabled: true, state: "rollingOut" });
    expect(byId.toolkit).toMatchObject({ enabled: true, state: "ready" });
    expect(byId.dcgm).toMatchObject({ enabled: false, state: "off" });
    expect(byId.dcgmExporter).toMatchObject({ enabled: true, state: "missing" });
    expect(byId.nodeStatusExporter).toMatchObject({ enabled: false });
    expect(byId.validator).toMatchObject({ enabled: true });
    expect(byId.vgpuManager).toMatchObject({ enabled: false });
    // Unset `enabled`: the operator's default (dcgm on, node status exporter off).
    const defaults = Object.fromEntries(componentsOf(f.policyNotReady!, []).map((r) => [r.def.id, r.enabled]));
    expect(defaults).toMatchObject({ dcgm: true, nodeStatusExporter: false, migManager: true, sandboxDevicePlugin: false });
    expect(componentsOf(f.policyByCrd!, daemonSets()).find((r) => r.def.id === "driver")!.state).toBe("managedByDriver");
  });

  it("finds an NVIDIADriver's DaemonSets by owner", () => {
    expect(ownedDaemonSets(f.driver!, daemonSets()).map((r) => r.name)).toEqual(["nvidia-gpu-driver-ubuntu22.04-7c6d5b9f8"]);
  });

  it("reads a node's GPU labels and its GPU and MIG resources", () => {
    expect(gpuNodeOf(f.nodeMig!)).toMatchObject({
      present: true,
      product: "NVIDIA-A100-SXM4-40GB",
      count: "8",
      migConfig: "all-1g.5gb",
      migState: "success",
      amounts: [
        { resource: "nvidia.com/gpu", capacity: "0", allocatable: "0" },
        { resource: "nvidia.com/mig-1g.5gb", capacity: "56", allocatable: "54" },
      ],
    });
    expect(hasGpu(gpuNodeOf(f.nodePlain!))).toBe(false);
  });
});

describe("problems", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const input = (over: Partial<Parameters<typeof toProblems>[0]> = {}) => ({
    policies: [f.policyNotReady!],
    drivers: [f.driver!],
    daemonSetsOf: (ns: string) => (ns === "gpu-operator" ? daemonSets() : undefined),
    failedNodes: [f.nodeMigFailed!],
    ...over,
  });

  it("a ClusterPolicy and an NVIDIADriver not ready, a component not rolled out, a MIG configuration failed", () => {
    const seen: Seen = new Map();
    const problems = toProblems(input(), seen, now);
    const reasons = problems.map((p) => `${p.object.kind.kind}/${p.object.name}:${p.reason}`).sort();
    expect(reasons).toEqual([
      "ClusterPolicy/cluster-policy:ComponentNotReady",
      "ClusterPolicy/cluster-policy:NotReady",
      "NVIDIADriver/default:ComponentNotReady",
      "NVIDIADriver/default:NotReady",
      "Node/gpu-node-2:MigConfigFailed",
    ]);
    const notReady = problems.find((p) => p.object.kind.kind === "ClusterPolicy" && p.reason === "NotReady")!;
    expect(notReady.message).toContain("state-driver");
    expect(notReady.activeAt).toBe(Date.parse("2026-10-01T09:05:00Z") + NOT_READY_GRACE_MS);
    const component = problems.find((p) => p.object.kind.kind === "ClusterPolicy" && p.reason === "ComponentNotReady")!;
    expect(component).toMatchObject({ category: "gpuOperator", messageKey: "messages.gpuComponentNotReady", activeAt: now + ROLLOUT_GRACE_MS });
    expect(component.messageParams).toMatchObject({ daemonSet: "nvidia-driver-daemonset-5.15.0-1066-aws-ubuntu22.04", ready: 1, desired: 2 });
    expect(problems.find((p) => p.reason === "MigConfigFailed")!.messageParams).toEqual({ config: "all-3g.40gb" });
  });

  it("a rollout that moves restarts its grace; DaemonSets not read are not judged", () => {
    const seen: Seen = new Map();
    toProblems(input({ drivers: [], failedNodes: [] }), seen, now);
    const moved = copy(f.dsDriver!);
    (moved.status as Record<string, number>).numberReady = 0;
    const later = now + 60_000;
    const again = toProblems(input({ drivers: [], failedNodes: [], daemonSetsOf: () => [moved] }), seen, later);
    expect(again.find((p) => p.reason === "ComponentNotReady")!.activeAt).toBe(later + ROLLOUT_GRACE_MS);
    const unread = toProblems(input({ drivers: [], failedNodes: [], daemonSetsOf: () => undefined }), new Map(), now);
    expect(unread.map((p) => p.reason)).toEqual(["NotReady"]);
    expect(toProblems(input({ policies: [f.policyReady!], drivers: [], failedNodes: [], daemonSetsOf: () => [f.dsToolkit!] }), new Map(), now)).toEqual([]);
  });

  it("is a category of its own, on by default, judged by its provider only where ClusterPolicies are served", () => {
    expect(PROBLEM_CATEGORIES).toContain("gpuOperator");
    expect(OPT_IN_CATEGORIES).not.toContain("gpuOperator");
    expect(categoryOf(CLUSTER_POLICY)).toBe("gpuOperator");
    expect(categoryOf(NVIDIA_DRIVER)).toBe("gpuOperator");
    expect(detect(CLUSTER_POLICY, f.policyNotReady!)).toEqual([]);
    expect(judgedByRules(CLUSTER_POLICY)).toBe(false);
    expect(sourcesFor(["gpuOperator"], [served(CLUSTER_POLICY, false)])).toEqual([expect.objectContaining({ external: true })]);
    expect(sourcesFor(["gpuOperator"], [served(NODE, false)])).toEqual([]);
  });
});

// ---------- In the app ----------

const NODE: KindRef = { group: "", version: "v1", kind: "Node" };
const DAEMONSET: KindRef = { group: "apps", version: "v1", kind: "DaemonSet" };

function served(kind: KindRef, namespaced = true): ResourceKind {
  return { kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced, verbs: ["list", "watch"], printerColumns: [] };
}

let wb: WatchBackend;
let discovery: ResourceKind[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [served(NODE, false), served(DAEMONSET), served(CLUSTER_POLICY, false), served(NVIDIA_DRIVER, false)];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery);
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the NVIDIA GPU Operator section", () => {
  it("is there where the cluster serves ClusterPolicies; its problems watch the operand namespace and failed MIG nodes only", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("NVIDIA GPU Operator"));
    emitSnapshot(wb, await watchOf(wb, "ClusterPolicy"), [f.policyReady!]);
    emitSnapshot(wb, await watchOf(wb, "NVIDIADriver"), []);
    emitSnapshot(wb, await watchOf(wb, "Node", (s) => s.labelSelector === MIG_FAILED_SELECTOR), [f.nodeMigFailed!]);
    emitSnapshot(wb, await watchOf(wb, "DaemonSet", (s) => s.namespaces?.join() === "gpu-operator"), daemonSets());
    const starts = wb.backend.calls.filter((c) => c.cmd === "watch_start").map((c) => c.args.spec as { kind: KindRef; namespaces: string[] | null });
    expect(starts.filter((s) => s.kind.kind === "DaemonSet").every((s) => s.namespaces?.join() === "gpu-operator")).toBe(true);
    expect(starts.some((s) => s.kind.kind === "Node" && s.namespaces === null && (s as { labelSelector?: string }).labelSelector !== MIG_FAILED_SELECTOR)).toBe(false);
  });

  it("is not there without the CRDs, and nothing of it is watched", async () => {
    discovery = [served(NODE, false), served(DAEMONSET)];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("NVIDIA GPU Operator");
    expect([...wb.specs.values()].some((s) => s.kind.group === "nvidia.com" || s.labelSelector === MIG_FAILED_SELECTOR)).toBe(false);
  });

  it("the tables show the state, the operand namespace and the MIG strategy; drivers their type and version", () => {
    const policies = getResourceDef(CLUSTER_POLICY);
    expect(policies.columns.map((c) => c.id)).toEqual(["name", "state", "namespace", "migStrategy", "age"]);
    expect(policies.columns.find((c) => c.id === "state")!.value(f.policyNotReady!)).toBe("notReady");
    expect(policies.problem?.(f.policyNotReady!)).toBe(true);
    const drivers = getResourceDef(NVIDIA_DRIVER);
    expect(drivers.columns.find((c) => c.id === "version")!.value(f.driver!)).toBe("570.86.15");
    expect(drivers.columns.find((c) => c.id === "nodeSelector")!.value(f.driver!)).toBe("nvidia.com/gpu.present=true");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  const [group, version] = (obj.apiVersion ?? "").split("/");
  return version === undefined
    ? { kind: { group: "", version: group ?? "", kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" }
    : { kind: { group: group ?? "", version, kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`), [obj]);
  return container;
}

const sectionOf = (id: string) => document.querySelector<HTMLElement>(`[data-section='${id}']`)!;

describe("details", () => {
  it("a ClusterPolicy: state, the operator's message, and each component with its DaemonSet", async () => {
    const container = await openDetails(f.policyNotReady!);
    await waitFor(() => expect(sectionOf("gpuOperator")).not.toBeNull());
    const view = within(sectionOf("gpuOperator"));
    expect(view.getAllByText("Not ready")[0]).toHaveClass("rt-status--warning");
    expect(view.getByText(/states not ready: \[state-driver\]/)).toBeInTheDocument();
    emitSnapshot(wb, await watchOf(wb, "DaemonSet", (s) => s.namespaces?.join() === "gpu-operator"), daemonSets());
    await waitFor(() => expect(view.getByText("1 of 2 ready, 2 updated")).toHaveClass("rt-status--warning"));
    expect(view.getByRole("button", { name: "Open DaemonSet nvidia-container-toolkit-daemonset" })).toBeInTheDocument();
    expect(view.getAllByText("Not deployed yet").length).toBeGreaterThan(0);
    expect(view.getByText("Not set (the device plugin decides, by default none)")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("an NVIDIADriver: its type, version and the DaemonSets it owns", async () => {
    const container = await openDetails(f.driver!);
    emitSnapshot(wb, await watchOf(wb, "DaemonSet", (s) => s.namespaces?.join() === "gpu-operator"), daemonSets());
    await waitFor(() => expect(sectionOf("gpuOperator")).not.toBeNull());
    const view = within(sectionOf("gpuOperator"));
    await waitFor(() => expect(view.getByRole("button", { name: "Open DaemonSet nvidia-gpu-driver-ubuntu22.04-7c6d5b9f8" })).toBeInTheDocument());
    expect(view.getByText("570.86.15")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a node's GPUs and MIG state; nothing on a node without GPUs", async () => {
    const container = await openDetails(f.nodeMigFailed!);
    await waitFor(() => expect(sectionOf("gpuNode")).not.toBeNull());
    const view = within(sectionOf("gpuNode"));
    expect(view.getByText("NVIDIA-H100-80GB-HBM3")).toBeInTheDocument();
    expect(view.getByText("failed")).toHaveClass("rt-status--danger");
    expect(view.getByText(/could not apply the MIG configuration all-3g.40gb/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("the GPU nodes page", () => {
  it("lists the GPU nodes with their GPUs and MIG resources", async () => {
    const Page = getPage(GPU_NODES_PAGE_ID)!.Component;
    const { container } = render(<Page clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "Node", (s) => s.labelSelector === GPU_NODE_SELECTOR), [f.nodeMig!, f.nodeMigFailed!]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 nodes"));
    expect(screen.getByText("mig-1g.5gb: 54/56")).toBeInTheDocument();
    expect(screen.getByText("8 of 8")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
