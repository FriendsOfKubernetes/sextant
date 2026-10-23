import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind, type WatchState } from "../../api";
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
import { allocationIndex } from "./hooks";
import {
  allocatedDevicesOf,
  allocatedNodeOf,
  claimSpecOf,
  claimState,
  classConfigOf,
  classesOf,
  classSelectorsOf,
  DEVICE_CLASS,
  draReasonsIn,
  generatedFor,
  podClaimsOf,
  requestsOf,
  reservingPods,
  RESOURCE_CLAIM,
  RESOURCE_CLAIM_TEMPLATE,
  RESOURCE_SLICE,
  sliceDevicesOf,
  sliceScope,
} from "./model";
import { claimsIn, namespacesToCheck, toProblems, unallocatedClaims, WAIT_GRACE_MS } from "./provider";
import { DEVICES_PAGE_ID } from "./register";

const f = fixtures as unknown as Record<string, KubeObject>;
const ready = (items: KubeObject[]): WatchState => ({ status: "ready", items: new Map(items.map((o) => [o.metadata?.uid ?? "", o])) });

describe("the model reads every version by its fields", () => {
  it("reads requests: v1 `exactly`, v1beta1 on the request, firstAvailable as ordered choices", () => {
    expect(requestsOf(claimSpecOf(f.templateV1!))).toEqual([
      { name: "gpu", firstAvailable: false, alternatives: [{ deviceClassName: "gpu.example.com", selectors: [], allocationMode: "ExactCount", count: 1, adminAccess: false }] },
    ]);
    expect(requestsOf(claimSpecOf(f.templateV1beta1!))[0]!.alternatives[0]).toMatchObject({ deviceClassName: "gpu.example.com", count: 2 });
    const pending = requestsOf(claimSpecOf(f.claimPending!));
    expect(pending[0]!.firstAvailable).toBe(true);
    expect(pending[0]!.alternatives.map((a) => [a.name, a.count])).toEqual([
      ["big", 1],
      ["small", 2],
    ]);
    expect(pending[0]!.alternatives[0]!.selectors[0]).toContain("compareTo(quantity('80Gi'))");
    expect(requestsOf(claimSpecOf(f.claimV1beta1!))[0]!.alternatives[0]).toMatchObject({ allocationMode: "All", count: 0, adminAccess: true });
    expect(classesOf(claimSpecOf(f.claimPending!))).toEqual(["gpu.example.com"]);
  });

  it("reads the allocation, the node, the consumers and the pod a claim was made for", () => {
    expect(allocatedDevicesOf(f.claimAllocated!)).toEqual([
      { request: "gpu", driver: "gpu.example.com", pool: "kind-worker", device: "gpu-0", adminAccess: false, bindingFailed: [], bindingPending: [] },
    ]);
    expect(allocatedNodeOf(f.claimAllocated!)).toBe("kind-worker");
    expect(allocatedNodeOf(f.claimV1beta1!)).toBeUndefined();
    expect(reservingPods(f.claimAllocated!)).toEqual(["pod0"]);
    expect(generatedFor(f.claimAllocated!)).toBe("pod0");
    expect(claimState(f.claimAllocated!)).toBe("inUse");
    expect(claimState(f.claimPending!)).toBe("pending");
    // A binding failure condition that is True on the device's status.
    expect(claimState(f.claimV1beta1!)).toBe("bindingFailed");
    const unreserved = copy(f.claimAllocated!);
    delete (unreserved.status as Record<string, unknown>).reservedFor;
    expect(claimState(unreserved)).toBe("allocated");
  });

  it("reads slices of v1, v1beta1 (`basic`, capacity value) and v1alpha3 (plain quantity)", () => {
    expect(sliceScope(f.sliceV1!)).toEqual({ type: "node", node: "kind-worker" });
    expect(sliceScope(f.sliceV1beta1!)).toEqual({ type: "allNodes" });
    const [gpu0] = sliceDevicesOf(f.sliceV1!);
    expect(gpu0!.attributes).toEqual([
      ["driverVersion", "1.0.0"],
      ["index", "0"],
      ["productName", "LATEST-GPU-MODEL"],
    ]);
    expect(gpu0!.capacity).toEqual([["memory", "80Gi"]]);
    expect(sliceDevicesOf(f.sliceV1beta1!)[0]!.capacity).toEqual([["bandwidth", "400G"]]);
    expect(sliceDevicesOf(f.sliceV1alpha3!)[0]).toMatchObject({ name: "gpu-0", capacity: [["memory", "16Gi"]], attributes: [["uuid", "gpu-1234"]] });
  });

  it("reads a class's CEL selectors as text and its drivers' configuration", () => {
    expect(classSelectorsOf(f.deviceClass!)).toEqual(["device.driver == 'gpu.example.com'"]);
    expect(classConfigOf(f.deviceClass!)[0]!.driver).toBe("gpu.example.com");
    expect(classConfigOf(f.deviceClass!)[0]!.parameters).toContain("TimeSlicing");
  });

  it("resolves a pod's claims: named, made from a template, not made yet", () => {
    expect(podClaimsOf(f.podRunning!)).toEqual([{ name: "gpu", template: "single-gpu", claimName: "pod0-gpu-x7k2p", notCreated: false, notNeeded: false, containers: ["ctr0"] }]);
    expect(podClaimsOf(f.podWaiting!).map((c) => [c.name, c.claimName, c.containers])).toEqual([
      ["gpu", "shared-gpu", ["trainer (gpu)"]],
      ["scratch", "pod1-scratch-q8z4m", ["trainer"]],
    ]);
    expect(podClaimsOf(f.podNotCreated!)[0]).toMatchObject({ name: "gpus", notCreated: true });
  });

  it("recognises the scheduler's DRA reasons in its message", () => {
    const message = (f.podWaiting!.status as { conditions: { message: string }[] }).conditions[0]!.message;
    expect(draReasonsIn(message)).toEqual(["cannotAllocate"]);
    expect(draReasonsIn('pod "gpu-test2/pod2": ResourceClaim not created yet')).toEqual(["notCreated"]);
    expect(draReasonsIn('resourceclaim.resource.k8s.io "x" not found')).toEqual(["notFound"]);
    expect(draReasonsIn("request gpu: device class missing does not exist")).toEqual(["noClass"]);
    expect(draReasonsIn("0/3 nodes are available: 3 Insufficient cpu.")).toEqual([]);
  });

  it("indexes which claim holds each device", () => {
    const index = allocationIndex([f.claimAllocated!, f.claimPending!]);
    expect(index.get("gpu.example.com/kind-worker/gpu-0")).toEqual([{ namespace: "gpu-test1", claim: "pod0-gpu-x7k2p", request: "gpu", apiVersion: "resource.k8s.io/v1" }]);
    expect(index.size).toBe(1);
  });
});

describe("pods waiting for devices", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  const claims = new Map([["shared-gpu", f.claimPending!], ["pod1-scratch-q8z4m", f.claimAllocated!]]);

  it("names the claims a waiting pod has no devices for; unknown without the claims", () => {
    expect(unallocatedClaims(f.podWaiting!, claims)).toEqual(["shared-gpu"]);
    expect(unallocatedClaims(f.podWaiting!, new Map())).toEqual(["shared-gpu", "pod1-scratch-q8z4m"]);
    expect(unallocatedClaims(f.podWaiting!, undefined)).toBeUndefined();
    expect(unallocatedClaims(f.podNotCreated!, undefined)).toEqual(["gpus"]);
  });

  it("counts a pod after the grace from its PodScheduled change, with the scheduler's message, once per owner", () => {
    const seen = new Map<string, number>();
    const problems = toProblems([f.podWaiting!, f.podRunning!], (ns) => (ns === "gpu-test1" ? claims : undefined), seen, now);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      category: "dra",
      reason: "DraWaiting",
      object: { kind: { kind: "Pod" }, namespace: "gpu-test1", name: "pod1" },
      notifyKey: "rs-owner|DraWaiting",
      messageKey: "messages.draWaitingClaims",
      messageLists: { claims: ["shared-gpu"] },
      activeAt: Date.parse("2026-10-01T10:01:00Z") + WAIT_GRACE_MS,
    });
    expect(problems[0]!.message).toContain("cannot allocate all claims");
  });

  it("without the claims, counts a pod only when the scheduler names a DRA reason", () => {
    const unknown = () => undefined;
    expect(toProblems([f.podWaiting!], unknown, new Map(), now)).toHaveLength(1);
    const cpu = copy(f.podWaiting!);
    (cpu.status as { conditions: { message: string }[] }).conditions[0]!.message = "0/3 nodes are available: 3 Insufficient cpu.";
    expect(toProblems([cpu], unknown, new Map(), now)).toEqual([]);
    // Every claim allocated: the pod waits for something else.
    const allocated = new Map([["shared-gpu", f.claimAllocated!], ["pod1-scratch-q8z4m", f.claimAllocated!]]);
    expect(toProblems([f.podWaiting!], () => allocated, new Map(), now)).toEqual([]);
  });

  it("looks at the claims of only the namespaces where a pod waits with claims", () => {
    expect(namespacesToCheck([f.podWaiting!, f.podRunning!, f.podNotCreated!])).toEqual(["gpu-test1", "gpu-test2"]);
    expect(claimsIn(ready([f.claimPending!, f.claimV1beta1!]), "gpu-test1")?.has("shared-gpu")).toBe(true);
    expect(claimsIn({ status: "loading", items: new Map() }, "gpu-test1")).toBeUndefined();
  });

  it("is a category of its own, on by default, judged by its provider only where claims are served", () => {
    expect(PROBLEM_CATEGORIES).toContain("dra");
    expect(OPT_IN_CATEGORIES).not.toContain("dra");
    expect(categoryOf(RESOURCE_CLAIM)).toBe("dra");
    expect(detect(RESOURCE_CLAIM, f.claimPending!)).toEqual([]);
    expect(judgedByRules(RESOURCE_CLAIM)).toBe(false);
    expect(sourcesFor(["dra"], [served(RESOURCE_CLAIM)])).toEqual([expect.objectContaining({ external: true })]);
    expect(sourcesFor(["dra"], [served(POD)])).toEqual([]);
  });
});

// ---------- In the app ----------

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const NODE: KindRef = { group: "", version: "v1", kind: "Node" };

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
  // The cluster serves v1beta1 only: the views follow discovery's version.
  const beta = (kind: KindRef) => ({ ...kind, version: "v1beta1" });
  discovery = [served(POD), served(NODE, false), served(beta(RESOURCE_CLAIM)), served(beta(RESOURCE_CLAIM_TEMPLATE)), served(beta(DEVICE_CLASS), false), served(beta(RESOURCE_SLICE), false)];
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

describe("the Dynamic Resource Allocation section", () => {
  it("is there where the cluster serves the kinds, and counts the pods waiting for devices", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Dynamic Resource Allocation"));
    const pending = await watchOf(wb, "Pod", (s) => s.fieldSelector === "status.phase=Pending" && s.namespaces === null);
    emitSnapshot(wb, pending, [f.podWaiting!]);
    const claims = await watchOf(wb, "ResourceClaim", (s) => s.namespaces?.join() === "gpu-test1");
    expect((wb.specs.get(claims)!.kind as KindRef).version).toBe("v1beta1");
    emitSnapshot(wb, claims, [f.claimPending!]);
    await waitFor(() => expect(screen.getByTitle("1 pod waits for devices")).toHaveTextContent("1"));
  });

  it("is not there without the kinds, and nothing of it is watched", async () => {
    discovery = [served(POD), served(NODE, false)];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("Dynamic Resource Allocation");
    expect([...wb.specs.values()].some((s) => s.kind.group === "resource.k8s.io" || s.fieldSelector === "status.phase=Pending")).toBe(false);
  });

  it("the tables show the state, classes, devices, node and consumers; slices where their devices are", () => {
    const claims = getResourceDef(RESOURCE_CLAIM);
    const col = (id: string) => claims.columns.find((c) => c.id === id)!;
    expect(claims.columns.map((c) => c.id)).toEqual(["name", "namespace", "state", "classes", "devices", "node", "reservedFor", "age"]);
    expect(col("state").value(f.claimAllocated!)).toBe("inUse");
    expect(col("node").value(f.claimAllocated!)).toBe("kind-worker");
    expect(col("reservedFor").value(f.claimAllocated!)).toBe("pod0");
    expect(claims.problem?.(f.claimV1beta1!)).toBe(true);
    const slices = getResourceDef(RESOURCE_SLICE);
    expect(slices.columns.find((c) => c.id === "node")!.value(f.sliceV1beta1!)).toBe("allNodes");
    expect(slices.columns.find((c) => c.id === "deviceCount")!.value(f.sliceV1!)).toBe(2);
    expect(getResourceDef(DEVICE_CLASS).columns.find((c) => c.id === "selectors")!.value(f.deviceClass!)).toBe(1);
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
  it("an allocated claim: state, node, consumer, requests and the devices", async () => {
    const container = await openDetails(f.claimAllocated!);
    await waitFor(() => expect(sectionOf("dra")).not.toBeNull());
    const view = within(sectionOf("dra"));
    expect(view.getAllByText("In use")[0]).toHaveClass("rt-status--success");
    expect(view.getByRole("button", { name: "Open Node kind-worker" })).toBeInTheDocument();
    expect(view.getAllByRole("button", { name: "Open Pod pod0" }).length).toBeGreaterThan(0);
    expect(view.getByText("kind-worker / gpu-0")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open DeviceClass gpu.example.com" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a pending claim: CEL selectors as text, the choices, and the pods that wait with the scheduler's words", async () => {
    const container = await openDetails(f.claimPending!);
    await waitFor(() => expect(sectionOf("dra")).not.toBeNull());
    const view = within(sectionOf("dra"));
    expect(view.getByText(/compareTo\(quantity\('80Gi'\)\)/)).toBeInTheDocument();
    expect(view.getByText("gpu: choice 2 (small)")).toBeInTheDocument();
    expect(view.getByText("2 devices")).toBeInTheDocument();
    const pending = await watchOf(wb, "Pod", (s) => s.fieldSelector === "status.phase=Pending" && s.namespaces?.join() === "gpu-test1");
    emitSnapshot(wb, pending, [f.podWaiting!]);
    await waitFor(() => expect(view.getByRole("button", { name: "Open Pod pod1" })).toBeInTheDocument());
    expect(view.getByText(/No node has free devices that match every request/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a pod's devices: its claims, their state, and why it waits", async () => {
    const container = await openDetails(f.podWaiting!);
    const claims = await watchOf(wb, "ResourceClaim", (s) => s.namespaces?.join() === "gpu-test1");
    emitSnapshot(wb, claims, [f.claimPending!]);
    await waitFor(() => expect(sectionOf("draPod")).not.toBeNull());
    const view = within(sectionOf("draPod"));
    await waitFor(() => expect(view.getByText("Pending")).toHaveClass("rt-status--warning"));
    expect(view.getByText("Does not exist")).toHaveClass("rt-status--danger");
    expect(view.getByText(/No node has free devices/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a node's DRA devices, from its slices, with the claim that holds each", async () => {
    const node: KubeObject = { apiVersion: "v1", kind: "Node", metadata: { name: "kind-worker", uid: "n1" } };
    const container = await openDetails(node);
    const slices = await watchOf(wb, "ResourceSlice", (s) => s.fieldSelector === "spec.nodeName=kind-worker");
    emitSnapshot(wb, slices, [f.sliceV1!]);
    const all = await watchOf(wb, "ResourceClaim", (s) => s.namespaces === null);
    emitSnapshot(wb, all, [f.claimAllocated!]);
    await waitFor(() => expect(sectionOf("draNode")).not.toBeNull());
    const view = within(sectionOf("draNode"));
    await waitFor(() => expect(view.getByRole("button", { name: "Open ResourceClaim pod0-gpu-x7k2p" })).toBeInTheDocument());
    expect(view.getByText("Free")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a pod without claims draws nothing", async () => {
    await openDetails({ apiVersion: "v1", kind: "Pod", metadata: { name: "plain", namespace: "default", uid: "p" }, spec: { containers: [] } });
    await waitFor(() => expect(sectionOf("summary")).not.toBeNull());
    expect(sectionOf("draPod")).toBeEmptyDOMElement();
  });
});

describe("the Devices page", () => {
  it("lists every slice's devices by node with the totals", async () => {
    const Page = getPage(DEVICES_PAGE_ID)!.Component;
    const { container } = render(<Page clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "ResourceSlice", (s) => s.fieldSelector === null), [f.sliceV1!, f.sliceV1beta1!]);
    emitSnapshot(wb, await watchOf(wb, "ResourceClaim", (s) => s.namespaces === null), [f.claimAllocated!]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("3 devices, 1 allocated"));
    expect(screen.getByText("All nodes")).toBeInTheDocument();
    expect(screen.getByText("fabric / link-0")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
