// The model and the manifest's declarative parts. The manifest's problem rules, the claims' "Only problems", the Pod
// block's condition and the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts
// and columns.tsx, loaded at run time so the type check stays inside the extension) and compared with the model they
// replace — the reading of Sextant's former built-in view (ADR-0116), ported unchanged — on its fixtures and variants.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import fixtures from "../fixtures/objects.json";
import en from "./locales/en.json";
import {
  allocatedDevicesOf,
  allocatedNodeOf,
  allocationIndex,
  claimSpecOf,
  claimState,
  classConfigOf,
  classesOf,
  classSelectorsOf,
  draProblem,
  draReasonsIn,
  extendedResourceOf,
  generatedFor,
  podClaimsOf,
  requestsOf,
  reservingPods,
  sliceDevicesOf,
  sliceDriver,
  slicePool,
  sliceScope,
  STATE_TONE,
  usesClaims,
  WAIT_GRACE_MS,
} from "./model";

const f = fixtures as unknown as Record<string, KubeObject>;
const copy = <T>(value: T): T => structuredClone(value);
type Rec = Record<string, unknown>;
const st = (o: KubeObject) => (o.status ??= {}) as Rec;
const sp = (o: KubeObject) => o.spec as Rec;
const podScheduled = (o: KubeObject) => (st(o).conditions as Rec[]).find((c) => c.type === "PodScheduled")!;

// ---------- Sextant's window engine ----------

interface Lookup {
  group: string;
  kind: string;
  name: string;
  fact?: string;
}
interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  notify: boolean;
  lookups?: Lookup[];
}
/** A problem as the problems store keeps it (`resolve` in src/features/problems/model.ts), enough for `judgeAcross`. */
interface StoreProblem extends Detected {
  key: string;
  uid: string;
  object: { kind: { group: string; version: string; kind: string }; namespace: string | null; name: string };
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
  kindKeyOf(kind: { group: string; kind: string }): string;
}
interface Across {
  rowOf(labelKeys: readonly string[], facts?: readonly unknown[]): (obj: KubeObject) => unknown;
  factsOf(rules: readonly unknown[], keyOf: (kind: { group: string; kind: string }) => string): Map<string, unknown[]>;
  judgeAcross(problems: readonly StoreProblem[], context: unknown, rules: { rules: ReadonlyMap<string, unknown>; targets: readonly unknown[] }): StoreProblem[];
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let across: Across;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  across = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemsAcross.ts"))) as Across;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
});

// ---------- The model (the built-in view's own tests) ----------

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
    expect(claimState(f.claimV1beta1!)).toBe("bindingFailed");
    const unreserved = copy(f.claimAllocated!);
    delete st(unreserved).reservedFor;
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
    expect(draReasonsIn(podScheduled(f.podWaiting!).message as string)).toEqual(["cannotAllocate"]);
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

// ---------- Variants ----------

function claims(): KubeObject[] {
  const unreserved = copy(f.claimAllocated!);
  delete st(unreserved).reservedFor;
  const deleting = copy(f.claimAllocated!);
  deleting.metadata.deletionTimestamp = "2026-10-01T11:00:00Z";
  const shared = copy(f.claimAllocated!);
  st(shared).reservedFor = ["pod0", "pod1", "pod2"].map((name) => ({ resource: "pods", name, uid: name }));
  const two = copy(f.claimAllocated!);
  st(two).reservedFor = ["pod0", "pod1"].map((name) => ({ resource: "pods", name, uid: name }));
  const twoClasses = copy(f.claimAllocated!);
  sp(twoClasses).devices = {
    requests: [
      { name: "gpu", exactly: { deviceClassName: "gpu.example.com" } },
      { name: "nic", exactly: { deviceClassName: "nic.example.com" } },
    ],
  };
  const twoResults = copy(f.claimAllocated!);
  const results = (((st(twoResults).allocation as Rec).devices as Rec).results as Rec[]);
  results.push({ ...results[0], device: "gpu-1" });
  const recovered = copy(f.claimV1beta1!);
  ((st(recovered).devices as Rec[])[0]!.conditions as Rec[])[0]!.status = "False";
  const nullAllocation = copy(f.claimPending!);
  st(nullAllocation).allocation = null;
  return [f.claimAllocated!, f.claimPending!, f.claimV1beta1!, unreserved, deleting, shared, two, twoClasses, twoResults, recovered, nullAllocation].map(copy);
}

function slices(): KubeObject[] {
  const selector = copy(f.sliceV1beta1!);
  delete sp(selector).allNodes;
  sp(selector).nodeSelector = { nodeSelectorTerms: [{ matchExpressions: [{ key: "topology.kubernetes.io/zone", operator: "In", values: ["zone-a"] }] }] };
  const perDevice = copy(f.sliceV1beta1!);
  delete sp(perDevice).allNodes;
  sp(perDevice).perDeviceNodeSelection = true;
  const none = copy(f.sliceV1beta1!);
  delete sp(none).allNodes;
  delete sp(none).devices;
  return [f.sliceV1!, f.sliceV1beta1!, f.sliceV1alpha3!, selector, perDevice, none].map(copy);
}


// ---------- Columns ----------

const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)!;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.dra:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = Date.parse("2026-10-01T12:00:00Z");
/** A cell's text, as the window searches and copies it; "" for an empty cell. */
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? "";
/** What a cell sorts by. */
const sortOf = (id: string, obj: KubeObject) => windowColumn(id).value(obj);
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject): { title?: string; tone?: string } {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title: title || undefined, tone: node?.props?.tone };
}
const word = (key: string) => (en as Record<string, string>)[key]!;
/** The built-in cells' hovers and sort values (src/features/dra/columns.tsx). */
const devicesText = (o: KubeObject) => allocatedDevicesOf(o).map((d) => `${d.driver}/${d.pool}/${d.device}`).join(", ");
const scopeValue = (o: KubeObject) => {
  const s = sliceScope(o);
  return s.type === "node" ? s.node : s.type;
};

describe("the columns, against the built-in ones", () => {
  it("are placed in the built-in order, with the built-in widths", () => {
    const ids = (k: string) => manifest.contributes.columns.filter((c) => c.kind.kind === k).map((c) => [c.afterColumn, c.id, (c as { width?: string }).width]);
    // The widths of src/features/dra/columns.tsx.
    const wide = (n: number) => `minmax(${n}px, 1fr)`;
    expect(ids("ResourceClaim")).toEqual([
      ["namespace", "claim-state", "140px"],
      ["claim-state", "claim-classes", wide(120)],
      ["claim-classes", "claim-devices", "90px"],
      ["claim-devices", "claim-node", wide(100)],
      ["claim-node", "claim-reserved-for", wide(120)],
    ]);
    expect(ids("ResourceClaimTemplate")).toEqual([
      ["namespace", "template-classes", wide(120)],
      ["template-classes", "template-requests", "90px"],
    ]);
    expect(ids("DeviceClass")).toEqual([
      ["name", "class-selectors", "90px"],
      ["class-selectors", "class-drivers", wide(120)],
      ["class-drivers", "class-extended-resource", wide(120)],
    ]);
    expect(ids("ResourceSlice")).toEqual([
      ["name", "slice-node", wide(120)],
      ["slice-node", "slice-driver", wide(120)],
      ["slice-driver", "slice-pool", wide(100)],
      ["slice-pool", "slice-devices", "90px"],
    ]);
    expect(windowColumn("claim-state").width).toBe("140px");
  });

  it("ResourceClaims: the state in its tone sorted by the state, the classes, devices, node and the pods it is reserved for", () => {
    for (const claim of claims()) {
      const name = claim.metadata.name;
      const state = claimState(claim);
      expect(cell("claim-state", claim), name).toBe(word(`state.${state}`));
      expect(drawn("claim-state", claim).tone, name).toBe(STATE_TONE[state]);
      expect(sortOf("claim-state", claim), name).toBe(state);
      expect(cell("claim-classes", claim), name).toBe(classesOf(claimSpecOf(claim)).join(", "));
      expect(cell("claim-devices", claim), name).toBe(String(allocatedDevicesOf(claim).length));
      expect(sortOf("claim-devices", claim), name).toBe(allocatedDevicesOf(claim).length);
      expect(cell("claim-node", claim), name).toBe(allocatedNodeOf(claim) ?? "");
      expect(cell("claim-reserved-for", claim), name).toBe(reservingPods(claim).join(", "));
    }
    // Deleting is muted, as the built-in table drew it.
    const deleting = claims().find((c) => claimState(c) === "deleting")!;
    expect(drawn("claim-state", deleting).tone).toBe("muted");
    // The devices' hover: the device in full.
    expect(drawn("claim-devices", f.claimAllocated!).title).toBe(devicesText(f.claimAllocated!));
  });

  it("lists every pod a claim is reserved for, and every class of every request, each once", () => {
    const many = copy(f.claimAllocated!);
    st(many).reservedFor = [
      ...["a", "b", "c", "d", "e"].map((name) => ({ resource: "pods", name })),
      { apiGroup: "example.com", resource: "jobs", name: "j" },
    ];
    expect(cell("claim-reserved-for", many)).toBe(reservingPods(many).join(", "));
    expect(cell("claim-reserved-for", many)).toBe("a, b, c, d, e");
    const mixed = copy(f.claimPending!);
    sp(mixed).devices = {
      requests: [
        { name: "a", exactly: { deviceClassName: "gpu.example.com" } },
        { name: "b", firstAvailable: [{ name: "x", deviceClassName: "gpu.example.com" }, { name: "y", deviceClassName: "nic.example.com" }] },
        { name: "c", exactly: { deviceClassName: "fpga.example.com" } },
        { name: "d", firstAvailable: [{ name: "z", deviceClassName: "dpu.example.com" }] },
      ],
    };
    // The same classes, each once; the built-in cell named them in the requests' order, here the exact requests'
    // classes come before the choices' ("Requirements and limits").
    expect(cell("claim-classes", mixed).split(", ").sort()).toEqual(classesOf(claimSpecOf(mixed)).sort());
    expect(cell("claim-classes", mixed)).toBe("gpu.example.com, fpga.example.com, nic.example.com, dpu.example.com");
    expect(classesOf(claimSpecOf(mixed)).join(", ")).toBe("gpu.example.com, nic.example.com, fpga.example.com, dpu.example.com");
  });

  it("hovers one allocated device in full; with more, the first and \"…\" (a hover has five placeholders)", () => {
    const two = claims().find((c) => allocatedDevicesOf(c).length === 2)!;
    expect(cell("claim-devices", two)).toBe("2");
    expect(sortOf("claim-devices", two)).toBe(2);
    expect(drawn("claim-devices", two).title).toBe(`${devicesText(two).split(", ")[0]}, …`);
    expect(drawn("claim-devices", f.claimPending!).title).toBeUndefined();
  });

  it("templates: the classes and the number of requests", () => {
    for (const template of [f.templateV1!, f.templateV1beta1!]) {
      expect(cell("template-classes", template)).toBe(classesOf(claimSpecOf(template)).join(", "));
      expect(cell("template-requests", template)).toBe(String(requestsOf(claimSpecOf(template)).length));
    }
    const empty = copy(f.templateV1!);
    ((empty.spec as Rec).spec as Rec).devices = { requests: [] };
    expect(cell("template-requests", empty)).toBe("0");
  });

  it("DeviceClasses: the selectors (every one on hover, a line each), the drivers each once and the extended resource", () => {
    const bare = copy(f.deviceClass!);
    delete sp(bare).selectors;
    delete sp(bare).config;
    const two = copy(f.deviceClass!);
    (sp(two).config as Rec[]).push({ opaque: { driver: "nic.example.com", parameters: {} } }, { opaque: { driver: "gpu.example.com", parameters: {} } });
    const selectors = (n: number) => {
      const cls = copy(f.deviceClass!);
      sp(cls).selectors = Array.from({ length: n }, (_, i) => ({ cel: { expression: `device.attributes["index"] == ${i}` } }));
      return cls;
    };
    for (const cls of [f.deviceClass!, bare, two, ...[1, 2, 5].map(selectors)]) {
      expect(cell("class-selectors", cls)).toBe(String(classSelectorsOf(cls).length));
      expect(sortOf("class-selectors", cls)).toBe(classSelectorsOf(cls).length);
      expect(drawn("class-selectors", cls).title).toBe(classSelectorsOf(cls).join("\n") || undefined);
      expect(cell("class-drivers", cls)).toBe([...new Set(classConfigOf(cls).map((c) => c.driver))].join(", "));
      expect(cell("class-extended-resource", cls)).toBe(extendedResourceOf(cls) ?? "");
    }
    // Past five, the first four and "…".
    const seven = selectors(7);
    expect(cell("class-selectors", seven)).toBe("7");
    expect(drawn("class-selectors", seven).title).toBe(`${classSelectorsOf(seven).slice(0, 4).join("\n")}\n…`);
  });

  it("ResourceSlices: where the devices are (sorted as the built-in), its selector on hover, driver, pool and the number of devices", () => {
    for (const slice of slices()) {
      const scope = sliceScope(slice);
      expect(cell("slice-node", slice), slice.metadata.name).toBe(scope.type === "node" ? scope.node : word(`scope.${scope.type}`));
      expect(sortOf("slice-node", slice), slice.metadata.name).toBe(scopeValue(slice));
      expect(cell("slice-driver", slice)).toBe(sliceDriver(slice));
      expect(cell("slice-pool", slice)).toBe(slicePool(slice));
      expect(cell("slice-devices", slice)).toBe(String(sliceDevicesOf(slice).length));
    }
    const withSelector = (terms: unknown[]) => {
      const s = copy(slices()[3]!);
      sp(s).nodeSelector = { nodeSelectorTerms: terms };
      return s;
    };
    const exact = [
      [{ matchExpressions: [{ key: "zone", operator: "In", values: ["a"] }] }],
      [{ matchExpressions: [{ key: "zone", operator: "In", values: ["a", "b"] }] }],
      [{ matchExpressions: [{ key: "gpu", operator: "Exists" }] }],
      [{ matchFields: [{ key: "metadata.name", operator: "In", values: ["n1", "n2"] }] }],
    ];
    for (const terms of exact) {
      const s = withSelector(terms);
      const scope = sliceScope(s) as { text: string[] };
      expect(drawn("slice-node", s).title).toBe(scope.text.join("\n"));
    }
    // Longer selectors: the first expression, then "…" (a hover has five placeholders).
    const long = withSelector([{ matchExpressions: [{ key: "zone", operator: "In", values: ["a"] }, { key: "gpu", operator: "Exists" }] }, { matchFields: [] }]);
    expect(drawn("slice-node", long).title).toBe("zone In a …");
    const exists = withSelector([{ matchExpressions: [{ key: "gpu", operator: "Exists" }, { key: "zone", operator: "In", values: ["a"] }] }]);
    expect(drawn("slice-node", exists).title).toBe("gpu Exists …");
  });
});

describe("the claims' \"Only problems\" and the Pod block's condition", () => {
  it("\"Only problems\" holds for a claim whose binding failed, as the built-in filter", () => {
    const when = manifest.contributes.kinds[0]!.problemWhen;
    for (const claim of claims()) expect(engine.evaluate(when, claim).holds, claim.metadata.name).toBe(claimState(claim) === "bindingFailed");
  });

  it("the Pod block shows for a pod with claims only", () => {
    const section = manifest.contributes.detailsSections.find((s) => s.id === "pod-devices")!;
    const plain: KubeObject = { apiVersion: "v1", kind: "Pod", metadata: { name: "plain", namespace: "default" }, spec: { containers: [] } };
    for (const pod of [f.podRunning!, f.podWaiting!, f.podNotCreated!, plain]) expect(engine.evaluate(section.when, pod).holds).toBe(usesClaims(pod));
  });

  it("every section is untitled, as the built-in ones, and the Node's starts hidden", () => {
    for (const s of manifest.contributes.detailsSections) expect((s as { heading?: boolean }).heading, s.id).toBe(false);
    expect(manifest.contributes.detailsSections.filter((s) => (s as { startHidden?: boolean }).startHidden).map((s) => s.id)).toEqual(["node-devices"]);
  });
});

// ---------- Problems ----------

const RULES = manifest.contributes.problems;
const CLAIM_KIND = { group: "resource.k8s.io", version: "v1", kind: "ResourceClaim" };
const CLAIM_DEF = { category: "ext:sextant.dra", kind: CLAIM_KIND, fieldSelector: null, discovered: true };

/**
 * The problems of `pod` that stand in Sextant's window: every rule judged by its engine (`detectRule`), kept as the
 * problems store keys them, then judged across the namespace's claims (`judgeAcross`) — `claims` undefined: their list
 * is not read in full, which cannot tell.
 */
function standing(pod: KubeObject, claimList: KubeObject[] | undefined): StoreProblem[] {
  const uid = pod.metadata.uid ?? pod.metadata.name;
  const found: StoreProblem[] = RULES.flatMap((rule) => engine.detectRule(rule, pod)).map((d) => ({
    ...d,
    key: `${uid}|${d.reason}`,
    uid,
    object: { kind: { group: "", version: "v1", kind: "Pod" }, namespace: pod.metadata.namespace ?? null, name: pod.metadata.name },
  }));
  const facts = across.factsOf(RULES, engine.kindKeyOf).get("resource.k8s.io/resourceclaim") ?? [];
  const rows =
    claimList === undefined
      ? undefined
      : { status: "ready", rows: new Map(claimList.map((c, i) => [`c${i}`, across.rowOf([], facts)(c)])), truncated: false, namespaces: null };
  const context = { rows: undefined, target: (def: unknown) => (def === CLAIM_DEF ? rows : undefined), problemUids: () => new Set<string>() };
  return across.judgeAcross(found, context, { rules: new Map(RULES.map((r) => [r.id, r])), targets: [{ ...CLAIM_KIND, namespaced: true, def: CLAIM_DEF }] });
}

type ClaimState2 = "missing" | "unallocated" | "allocated";
function claimNamed(name: string, state: Exclude<ClaimState2, "missing">): KubeObject {
  const c = copy(state === "allocated" ? f.claimAllocated! : f.claimPending!);
  c.metadata.name = name;
  c.metadata.namespace = "gpu-test1";
  return c;
}
interface Entry {
  name: string;
  /** The claim it names, or (`template`) the one the controller made, if it did. */
  claim?: string;
  template?: boolean;
  /** A template's entry the controller has not recorded yet. */
  unrecorded?: boolean;
}
const DR_MESSAGE = (podScheduled(f.podWaiting!).message as string);
const CPU_MESSAGE = "0/3 nodes are available: 3 Insufficient cpu.";
/** A waiting pod with these claims; `message` null: PodScheduled without one; undefined: no PodScheduled at all. */
function waiting(entries: Entry[], message: string | null | undefined, statuses = true): KubeObject {
  const pod = copy(f.podWaiting!);
  sp(pod).resourceClaims = entries.map((e) => (e.template ? { name: e.name, resourceClaimTemplateName: "tpl" } : { name: e.name, resourceClaimName: e.claim }));
  const made = entries.filter((e) => e.template && !e.unrecorded).map((e) => ({ name: e.name, ...(e.claim ? { resourceClaimName: e.claim } : {}) }));
  if (statuses && made.length > 0) st(pod).resourceClaimStatuses = made;
  else delete st(pod).resourceClaimStatuses;
  if (message === undefined) delete st(pod).conditions;
  else if (message === null) delete podScheduled(pod).message;
  else podScheduled(pod).message = message;
  return pod;
}
const EN_PROBLEMS = { claims: "Waits for devices of claims that are not allocated or do not exist: {{claims}}." };
const claimMap = (list: KubeObject[]) => new Map(list.map((c) => [c.metadata.name, c]));
const PREFIX = EN_PROBLEMS.claims.slice(0, EN_PROBLEMS.claims.indexOf("{{"));
/** The claims a message without the scheduler's words names. */
const listed = (message: string | undefined) => (message?.startsWith(PREFIX) ? message.slice(PREFIX.length, -1).split(/,\s?/) : []);

const SHAPES: Record<string, Entry[]> = {
  named: [{ name: "gpu", claim: "a" }],
  made: [{ name: "gpu", claim: "a", template: true }],
  "named, made": [{ name: "gpu", claim: "a" }, { name: "scratch", claim: "b", template: true }],
  "made, named": [{ name: "scratch", claim: "b", template: true }, { name: "gpu", claim: "a" }],
  "two named": [{ name: "gpu", claim: "a" }, { name: "nic", claim: "b" }],
  "two made": [{ name: "gpu", claim: "a", template: true }, { name: "nic", claim: "b", template: true }],
};
const STATES: ClaimState2[] = ["missing", "unallocated", "allocated"];

describe("the problem rules, against the built-in detector", () => {
  it("are one notification group, with the built-in reason, source, grace and since", () => {
    expect(RULES.length).toBeLessThanOrEqual(30);
    for (const rule of RULES) {
      expect(rule.kind).toEqual({ group: "", kind: "Pod" });
      // The group is a rule's id, so the window's judge across objects finds a rule for every problem.
      expect(RULES.some((r) => r.id === rule.group), rule.id).toBe(true);
      expect(rule.group).toBe("claims-not-created");
      expect(rule.reason).toBe("DraWaiting");
      expect(rule.graceMinutes * 60_000).toBe(WAIT_GRACE_MS);
      // The built-in provider watched the Pending pods, at most 2000.
      expect(rule.source).toEqual({ fieldSelector: "status.phase=Pending", maxObjects: 2000 });
      expect([rule.since, ...rule.sinceOr]).toEqual(['.status.conditions[type="PodScheduled"].lastTransitionTime', ".metadata.creationTimestamp"]);
    }
  });

  it("tell one problem per Pod, as the built-in one, for every state of one or two claims and every message", () => {
    let compared = 0;
    let unlisted = 0;
    for (const [shape, entries] of Object.entries(SHAPES)) {
      const names = entries.map((e) => e.claim!);
      const combos: ClaimState2[][] = names.length === 1 ? STATES.map((s) => [s]) : STATES.flatMap((a) => STATES.map((b) => [a, b]));
      for (const states of combos) {
        const list = names.flatMap((n, i) => (states[i] === "missing" ? [] : [claimNamed(n, states[i] as "allocated" | "unallocated")]));
        for (const message of [DR_MESSAGE, CPU_MESSAGE, null, undefined]) {
          const pod = waiting(entries, message);
          const label = `${shape} ${states.join("/")} ${String(message).slice(0, 20)}`;
          const builtIn = draProblem(pod, claimMap(list));
          const rules = standing(pod, list);
          compared++;
          expect(rules.length, label).toBe(builtIn ? 1 : 0);
          if (!builtIn) continue;
          const [p] = rules;
          expect([p!.reason, p!.since, p!.graceMs], label).toEqual(["DraWaiting", builtIn.since, WAIT_GRACE_MS]);
          expect(p!.key, label).toBe(`${pod.metadata.uid}|DraWaiting`);
          if (builtIn.message) {
            expect(p!.message, label).toBe(builtIn.message);
            continue;
          }
          // Without the scheduler's words: the claims that do not exist, as the built-in sentence; it also named a
          // second claim that exists without devices, and the claims in the Pod's order ("Requirements and limits").
          const gone = (builtIn.claims ?? []).filter((n) => states[names.indexOf(n)] === "missing");
          expect(listed(p!.message).sort(), label).toEqual(gone.sort());
          if (gone.length !== builtIn.claims?.length) unlisted++;
        }
      }
    }
    expect(compared).toBe(4 * (3 + 3 + 4 * 9));
    expect(unlisted).toBeGreaterThan(0);
  });

  it("claims of its templates not created yet: the scheduler's message, or every claim of the Pod", () => {
    for (const message of [podScheduled(f.podNotCreated!).message as string, null, undefined]) {
      const pod = copy(f.podNotCreated!);
      if (message === undefined) delete st(pod).conditions;
      else if (message === null) delete podScheduled(pod).message;
      const builtIn = draProblem(pod, undefined)!;
      const rules = standing(pod, undefined);
      expect(rules.map((p) => [p.reason, p.since]), String(message)).toEqual([["DraWaiting", builtIn.since]]);
      expect(rules[0]!.message).toBe(builtIn.message ?? EN_PROBLEMS.claims.replace("{{claims}}", builtIn.claims!.join(", ")));
    }
    // Two templates, neither made yet; and one made of two (the controller records them together).
    const two = waiting([{ name: "gpu", template: true }, { name: "nic", template: true }], null, false);
    // `|list` joins as the built-in message's list did (`formatList`, in the UI language).
    expect(standing(two, []).map((p) => listed(p.message))).toEqual([draProblem(two, new Map())!.claims]);
    const half = waiting([{ name: "gpu", claim: "a", template: true }, { name: "nic", template: true, unrecorded: true }], DR_MESSAGE);
    expect(draProblem(half, claimMap([claimNamed("a", "allocated")]))).toBeDefined();
    expect(standing(half, [claimNamed("a", "allocated")])).toHaveLength(1);
    // A template whose claim was not needed (a status entry without a name) is no gap.
    const notNeeded = waiting([{ name: "gpu", claim: "a" }, { name: "opt", template: true }], DR_MESSAGE);
    expect(draProblem(notNeeded, claimMap([claimNamed("a", "allocated")]))).toBeUndefined();
    expect(standing(notNeeded, [claimNamed("a", "allocated")])).toEqual([]);
  });

  it("no problem where the built-in one found none", () => {
    const gated = copy(f.podWaiting!);
    Object.assign(podScheduled(gated), { reason: "SchedulingGated", message: "Scheduling is blocked due to non-empty scheduling gates" });
    const deleting = copy(f.podNotCreated!);
    deleting.metadata.deletionTimestamp = "2026-10-01T11:00:00Z";
    const placed = copy(f.podWaiting!);
    podScheduled(placed).status = "True";
    const running = copy(f.podNotCreated!);
    st(running).phase = "Running";
    sp(running).nodeName = "kind-worker";
    const noClaims: KubeObject = { apiVersion: "v1", kind: "Pod", metadata: { name: "plain", namespace: "default" }, spec: { containers: [] }, status: { phase: "Pending" } };
    const everyClaim = [claimNamed("shared-gpu", "allocated"), claimNamed("pod1-scratch-q8z4m", "allocated")];
    for (const [pod, list] of [
      [f.podRunning!, everyClaim],
      [f.podWaiting!, everyClaim],
      [gated, []],
      [deleting, undefined],
      [placed, []],
      [running, undefined],
      [noClaims, []],
    ] as [KubeObject, KubeObject[] | undefined][]) {
      expect(draProblem(pod, list && claimMap(list)), pod.metadata.name).toBeUndefined();
      expect(standing(pod, list), pod.metadata.name).toEqual([]);
    }
  });

  it("the scheduler's DRA reasons, as the built-in expressions read them", () => {
    const reasons = [
      'pod "x": ResourceClaim not created yet',
      "waiting for dynamic resource controller to create the resourceclaim",
      'resourceclaim "a" not found',
      'resourceclaims.resource.k8s.io "a" not found',
      'resourceclaim "a" is being deleted',
      "resourceclaim in use",
      "request gpu: device class missing does not exist",
      "0/3 nodes are available: 3 cannot allocate all claims.",
      "resourceclaim not available on the node",
      "resourceclaim a is in the process of being allocated",
      "resourceclaim a was not created for Pod p",
      CPU_MESSAGE,
      'persistentvolumeclaim "a" not found',
    ];
    for (const text of reasons) {
      const pod = waiting([{ name: "gpu", claim: "a" }], text);
      expect(standing(pod, [claimNamed("a", "unallocated")]).length, text).toBe(draReasonsIn(text).length > 0 ? 1 : 0);
    }
  });

  it("cannot tell while the claims are not read in full, nor judge more than two claims", () => {
    // Without the claims the built-in detector counted a Pod whose scheduler message names a DRA reason; a rule's
    // looked-up claim is "cannot tell" then ("Requirements and limits").
    expect(draProblem(f.podWaiting!, undefined)).toBeDefined();
    expect(standing(f.podWaiting!, undefined)).toEqual([]);
    const three = waiting(
      [
        { name: "a", claim: "a" },
        { name: "b", claim: "b" },
        { name: "c", claim: "c" },
      ],
      DR_MESSAGE,
    );
    expect(draProblem(three, new Map())?.claims).toEqual(["a", "b", "c"]);
    expect(standing(three, [])).toEqual([]);
  });
});
