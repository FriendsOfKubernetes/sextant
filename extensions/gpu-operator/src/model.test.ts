// The model and the manifest's declarative parts. The manifest's problem rules, the kinds' "Only problems", the GPU
// block's condition and the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts,
// columns.tsx and src/resources/jsonpath.ts, loaded at run time so the type check stays inside the extension) and
// compared with the model they replace — the reading of Sextant's former built-in view (ADR-0116), ported unchanged —
// on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import fixtures from "../fixtures/objects.json";
import en from "./locales/en.json";
import {
  COMPONENTS,
  componentsOf,
  driverNodeSelectorOf,
  driverTypeOf,
  driverVersionOf,
  failureOf,
  gpuNodeOf,
  gpuProblems,
  hasGpu,
  isComponentDaemonSet,
  migStrategyOf,
  MIG_FAILED_SELECTOR,
  operandNamespaceOf,
  ownedDaemonSets,
  shownComponent,
  stateOf,
  STATE_TONE,
  type BuiltInProblem,
} from "./model";

const f = fixtures as unknown as Record<string, KubeObject>;
const copy = <T>(value: T): T => structuredClone(value);
const fx = (name: string): KubeObject => copy(f[name]!);
const st = (o: KubeObject) => o.status as Record<string, unknown>;
const spec = (o: KubeObject) => o.spec as Record<string, unknown>;
const conditions = (o: KubeObject) => st(o).conditions as Record<string, unknown>[];

/** A DaemonSet the operator made for `owner` (it sets its ClusterPolicy as every operand's controller). */
function ownedBy(ds: KubeObject, owner: KubeObject): KubeObject {
  const out = copy(ds);
  out.metadata.ownerReferences = [{ apiVersion: owner.apiVersion, kind: owner.kind, name: owner.metadata.name, uid: owner.metadata.uid, controller: true }];
  return out;
}
/** The policy's DaemonSets (owned by it) and the driver's (already owned in the fixtures). */
const daemonSets = (policy: KubeObject) => [ownedBy(f.dsDriver!, policy), ownedBy(f.dsToolkit!, policy), ownedBy(f.dsDevicePlugin!, policy), fx("dsOwnedByDriver")];

// ---------- Sextant's window engine ----------

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
  activeFrom?: number;
  until?: number;
  notify: boolean;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
interface JsonPath {
  evalJsonPath(obj: unknown, path: string): unknown[];
  formatJsonPathValues(values: unknown[]): string;
}
let engine: Engine;
let columns: Columns;
let jsonPath: JsonPath;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  jsonPath = (await import(/* @vite-ignore */ join(here, "../../../src/resources/jsonpath.ts"))) as JsonPath;
});

type Rule = (typeof manifest.contributes.problems)[number];
const rules = manifest.contributes.problems as Rule[];
const kindOfObj = (o: KubeObject) => ({ group: (o.apiVersion ?? "").includes("/") ? o.apiVersion!.split("/")[0]! : "", kind: o.kind ?? "" });
const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

/** The problems the manifest's rules find, as the window finds them, first seen at `firstSeen`. */
function windowProblems(objects: KubeObject[], firstSeen: number) {
  return objects.flatMap((obj) =>
    rules
      .filter((rule) => sameKind(rule.kind, kindOfObj(obj)))
      .flatMap((rule) => engine.detectRule(rule, obj))
      .map((d) => {
        const start = d.since ? Date.parse(d.since) : firstSeen;
        return {
          kind: obj.kind ?? "",
          name: obj.metadata.name,
          reason: d.reason,
          message: d.message ?? "",
          activeAt: d.activeFrom ?? start + (d.graceMs ?? 0),
        };
      }),
  );
}

/**
 * The built-in problems in the window's terms: a component's problem is about its DaemonSet (the extension cannot tell
 * a problem about another object, #405), the rest about the object itself.
 */
const builtIn = (problems: BuiltInProblem[]) =>
  problems.map((p) => ({
    kind: p.daemonSet ? "DaemonSet" : p.object.kind,
    name: p.daemonSet ?? p.object.name,
    reason: p.reason,
    message: p.message,
    activeAt: p.activeAt,
  }));
const sorted = <T extends { kind: string; name: string; reason: string }>(list: T[]) =>
  [...list].sort((a, b) => `${a.kind}/${a.name}/${a.reason}`.localeCompare(`${b.kind}/${b.name}/${b.reason}`));

const NOW = Date.parse("2026-10-01T12:00:00Z");

/** Both judge the same objects alike: the ClusterPolicy or NVIDIADriver, its DaemonSets, the failed nodes. */
function expectSame(input: { policies?: KubeObject[]; drivers?: KubeObject[]; daemonSets?: KubeObject[]; failedNodes?: KubeObject[] }, label: string) {
  const full = { policies: [], drivers: [], daemonSets: [], failedNodes: [], ...input };
  const objects = [...full.policies, ...full.drivers, ...full.daemonSets, ...full.failedNodes];
  expect(sorted(windowProblems(objects, NOW)), label).toEqual(sorted(builtIn(gpuProblems(full, NOW))));
}

describe("the model", () => {
  it("reads the state, the operand namespace and the MIG strategy", () => {
    expect(stateOf(f.policyReady!)).toBe("ready");
    expect(stateOf(f.policyNotReady!)).toBe("notReady");
    expect(stateOf({ apiVersion: "nvidia.com/v1", kind: "ClusterPolicy", metadata: { name: "x" } })).toBe("unknown");
    expect(migStrategyOf(f.policyReady!)).toBe("mixed");
    expect(migStrategyOf(f.policyNotReady!)).toBeUndefined();
    expect(operandNamespaceOf(f.driver!)).toBe("gpu-operator");
  });

  it("finds each component's DaemonSet by its manifest name; the driver's with its kernel and OS suffix", () => {
    const driver = COMPONENTS.find((c) => c.id === "driver")!;
    expect(isComponentDaemonSet(driver, "nvidia-driver-daemonset-5.15.0-1066-aws-ubuntu22.04")).toBe(true);
    expect(isComponentDaemonSet(driver, "nvidia-driver-daemonset")).toBe(true);
    expect(isComponentDaemonSet(COMPONENTS.find((c) => c.id === "dcgm")!, "nvidia-dcgm-exporter")).toBe(false);
  });

  it("follows the sandbox mode and never counts the retired Kata manager as on (#260)", () => {
    const policy = (mode?: string): KubeObject => {
      const p = fx("policyNotReady");
      Object.assign(spec(p), {
        sandboxWorkloads: { enabled: true, ...(mode ? { mode } : {}) },
        sandboxDevicePlugin: { enabled: true },
        kataSandboxDevicePlugin: { enabled: true },
        kataManager: { enabled: true },
        ccManager: { enabled: true },
      });
      return p;
    };
    const enabledIn = (p: KubeObject) => Object.fromEntries(componentsOf(p, []).map((r) => [r.def.id, r.enabled]));
    expect(enabledIn(policy("kubevirt"))).toMatchObject({ sandboxDevicePlugin: true, kataSandboxDevicePlugin: false, ccManager: false, kataManager: false });
    expect(enabledIn(policy("kata"))).toMatchObject({ sandboxDevicePlugin: false, kataSandboxDevicePlugin: true, ccManager: true, kataManager: false, sandboxValidator: true });
    expect(enabledIn(policy())).toMatchObject({ sandboxDevicePlugin: true, kataSandboxDevicePlugin: true, ccManager: true, kataManager: false });
    const without = componentsOf(policy("kata"), []).find((r) => r.def.id === "kataManager")!;
    expect(without).toMatchObject({ enabled: false, state: "off" });
    expect(shownComponent(without)).toBe(false);
  });

  it("judges components as their IsEnabled() defaults do", () => {
    const byId = Object.fromEntries(componentsOf(f.policyReady!, daemonSets(f.policyReady!)).map((r) => [r.def.id, r]));
    expect(byId.driver).toMatchObject({ enabled: true, state: "rollingOut" });
    expect(byId.toolkit).toMatchObject({ enabled: true, state: "ready" });
    expect(byId.dcgm).toMatchObject({ enabled: false, state: "off" });
    expect(byId.dcgmExporter).toMatchObject({ enabled: true, state: "missing" });
    expect(byId.validator).toMatchObject({ enabled: true });
    const defaults = Object.fromEntries(componentsOf(f.policyNotReady!, []).map((r) => [r.def.id, r.enabled]));
    expect(defaults).toMatchObject({ dcgm: true, nodeStatusExporter: false, migManager: true, sandboxDevicePlugin: false });
    expect(componentsOf(f.policyByCrd!, []).find((r) => r.def.id === "driver")!.state).toBe("managedByDriver");
  });

  it("finds an NVIDIADriver's DaemonSets by owner, and reads its type, version and node selector", () => {
    expect(ownedDaemonSets(f.driver!, daemonSets(f.policyReady!)).map((r) => r.name)).toEqual(["nvidia-gpu-driver-ubuntu22.04-7c6d5b9f8"]);
    expect([driverTypeOf(f.driver!), driverVersionOf(f.driver!), driverNodeSelectorOf(f.driver!)]).toEqual(["gpu", "570.86.15", { "nvidia.com/gpu.present": "true" }]);
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

// ---------- The problem rules ----------

describe("the problem rules, against the built-in ones", () => {
  it("find what the built-in category found on its fixtures", () => {
    expectSame({ policies: [fx("policyNotReady")], drivers: [fx("driver")], daemonSets: daemonSets(f.policyNotReady!), failedNodes: [fx("nodeMigFailed")] }, "fixtures");
    const found = sorted(windowProblems([fx("policyNotReady"), fx("driver"), ...daemonSets(f.policyNotReady!), fx("nodeMigFailed")], NOW));
    expect(found.map((p) => `${p.kind}/${p.name}:${p.reason}`)).toEqual([
      "ClusterPolicy/cluster-policy:NotReady",
      "DaemonSet/nvidia-driver-daemonset-5.15.0-1066-aws-ubuntu22.04:ComponentNotReady",
      "DaemonSet/nvidia-gpu-driver-ubuntu22.04-7c6d5b9f8:ComponentNotReady",
      "Node/gpu-node-2:MigConfigFailed",
      "NVIDIADriver/default:NotReady",
    ]);
    expect(found[0]).toMatchObject({ message: "ClusterPolicy is not ready, states not ready: [state-driver]", activeAt: Date.parse("2026-10-01T09:05:00Z") + 10 * 60_000 });
    expect(found[1]).toMatchObject({ message: "DaemonSet nvidia-driver-daemonset-5.15.0-1066-aws-ubuntu22.04: 1 of 2 Pods ready, 2 updated.", activeAt: NOW + 10 * 60_000 });
    expect(found[3]).toMatchObject({ message: "The MIG manager could not apply the MIG configuration all-3g.40gb on this node.", activeAt: NOW + 2 * 60_000 });
  });

  it("take the operator's message as the built-in rule did: the Error condition, else a False Ready, else the plain text", () => {
    /** The object's condition of `type`, added when it has none. */
    const cond = (o: KubeObject, type: string): Record<string, unknown> => {
      const list = (st(o).conditions ??= []) as Record<string, unknown>[];
      let c = list.find((x) => x.type === type);
      if (!c) list.push((c = { type, status: "False", message: "" }));
      return c;
    };
    const variants: [string, (o: KubeObject) => void][] = [
      ["as it is", () => undefined],
      ["error with a message", (o) => Object.assign(cond(o, "Error"), { status: "True", message: "failed to deploy state-driver" })],
      ["error without a message", (o) => Object.assign(cond(o, "Error"), { status: "True", message: "" })],
      ["error, its message left out", (o) => (Object.assign(cond(o, "Error"), { status: "True" }), delete cond(o, "Error").message)],
      ["ready false without a message", (o) => (cond(o, "Ready").message = "")],
      ["ready false without a time", (o) => delete cond(o, "Ready").lastTransitionTime],
      ["ready true", (o) => (cond(o, "Ready").status = "True")],
      ["no conditions", (o) => delete st(o).conditions],
      ["ready", (o) => (st(o).state = "ready")],
      ["ignored", (o) => (st(o).state = "ignored")],
      ["disabled", (o) => (st(o).state = "disabled")],
      ["no state", (o) => delete st(o).state],
      ["deleting", (o) => (o.metadata.deletionTimestamp = "2026-10-01T11:00:00Z")],
    ];
    for (const [label, change] of variants) {
      const policy = fx("policyNotReady");
      change(policy);
      expectSame({ policies: [policy] }, `ClusterPolicy ${label}`);
      const driver = fx("driver");
      change(driver);
      expectSame({ drivers: [driver] }, `NVIDIADriver ${label}`);
    }
  });

  it("judge component DaemonSets as rolled out when every scheduled pod is ready and updated", () => {
    const policy = fx("policyNotReady");
    const ds = (status: Record<string, number>, name = "nvidia-device-plugin-daemonset"): KubeObject =>
      ownedBy({ apiVersion: "apps/v1", kind: "DaemonSet", metadata: { name, namespace: "gpu-operator", uid: name }, status }, policy);
    const cases: [string, Record<string, number>][] = [
      ["rolled out", { desiredNumberScheduled: 2, numberReady: 2, updatedNumberScheduled: 2 }],
      ["one not ready", { desiredNumberScheduled: 2, numberReady: 1, updatedNumberScheduled: 2 }],
      ["one not updated", { desiredNumberScheduled: 2, numberReady: 2, updatedNumberScheduled: 1 }],
      ["none updated (left out)", { desiredNumberScheduled: 2, numberReady: 2 }],
      ["no pod scheduled", { desiredNumberScheduled: 0, numberReady: 0 }],
      ["more ready than wanted", { desiredNumberScheduled: 1, numberReady: 2, updatedNumberScheduled: 2 }],
    ];
    for (const [label, status] of cases) expectSame({ policies: [policy], daemonSets: [ds(status)] }, label);
    const none = windowProblems([ds({ desiredNumberScheduled: 2, numberReady: 2 })], NOW);
    expect(none[0]!.message).toBe("DaemonSet nvidia-device-plugin-daemonset: 2 of 2 Pods ready, 0 updated.");
  });

  it("judge the DaemonSets the operator owns, where the built-in rule judged the enabled components' by name", () => {
    // A DaemonSet of the component's name that the operator does not own: the built-in rule judged it.
    const stray = { ...fx("dsDriver"), metadata: { ...f.dsDriver!.metadata } };
    expect(windowProblems([stray], NOW)).toEqual([]);
    expect(gpuProblems({ policies: [fx("policyNotReady")], drivers: [], daemonSets: [stray], failedNodes: [] }, NOW).map((p) => p.reason)).toContain("ComponentNotReady");
  });

  it("judge nodes whose MIG configuration failed, picked by the label on the API server", () => {
    const node = rules.find((r) => r.id === "mig-config-failed")!;
    expect(node.source).toEqual({ labelSelector: MIG_FAILED_SELECTOR, metadataOnly: true });
    expectSame({ failedNodes: [fx("nodeMigFailed")] }, "failed");
    const noConfig = fx("nodeMigFailed");
    delete noConfig.metadata.labels!["nvidia.com/mig.config"];
    expectSame({ failedNodes: [noConfig] }, "failed without a configuration");
    expectSame({ failedNodes: [fx("nodeMig")] }, "success");
  });

  it("group as the built-in category: one notification group per problem, all of them notifying", () => {
    expect(new Set(rules.map((r) => r.group))).toEqual(new Set(["not-ready", "component-not-ready", "mig-config-failed"]));
    for (const rule of rules) expect((rule as { notify?: boolean }).notify).toBeUndefined();
  });

  it("make the kinds' Only problems: the objects that are not ready", () => {
    for (const kind of manifest.contributes.kinds) {
      for (const obj of [f.policyReady!, f.policyNotReady!, f.policyByCrd!, f.driver!]) {
        expect(engine.evaluate(kind.problemWhen, obj).holds, `${kind.kind} ${obj.metadata.uid}`).toBe(stateOf(obj) === "notReady");
      }
    }
  });
});

// ---------- The GPU block's condition ----------

describe("the GPU block of nodes", () => {
  const section = manifest.contributes.detailsSections.find((s) => s.id === "gpu-node")!;
  it("shows on the nodes the built-in block showed on", () => {
    const only = (labels: Record<string, string>, status: Record<string, unknown> = {}): KubeObject => ({ apiVersion: "v1", kind: "Node", metadata: { name: "n", labels }, status });
    const nodes: [string, KubeObject][] = [
      ["MIG", fx("nodeMig")],
      ["MIG failed", fx("nodeMigFailed")],
      ["plain", fx("nodePlain")],
      ["present false", only({ "nvidia.com/gpu.present": "false" })],
      ["product only", only({ "nvidia.com/gpu.product": "Tesla-T4" })],
      ["empty product", only({ "nvidia.com/gpu.product": "" })],
      ["MIG state only", only({ "nvidia.com/mig.config.state": "pending" })],
      ["GPU capacity only", only({}, { capacity: { "nvidia.com/gpu": "1" } })],
      ["GPU allocatable only", only({}, { allocatable: { "nvidia.com/gpu": "1" } })],
    ];
    for (const [label, node] of nodes) expect(engine.evaluate(section.when, node).holds, label).toBe(hasGpu(gpuNodeOf(node)));
  });

  it("leaves out a node with nothing but MIG resources, which a condition cannot pick by a key's prefix", () => {
    const node: KubeObject = { apiVersion: "v1", kind: "Node", metadata: { name: "n" }, status: { capacity: { "nvidia.com/mig-1g.5gb": "7" } } };
    expect(hasGpu(gpuNodeOf(node))).toBe(true);
    expect(engine.evaluate(section.when, node).holds).toBe(false);
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.gpu-operator:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
function drawn(id: string, obj: KubeObject): { title?: string; tone?: string } {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title, tone: node?.props?.tone };
}
/** The extension's tones are Sextant's but muted, which a column cannot say (#403). */
const toneOf = (tone: string) => (tone === "muted" ? "neutral" : tone);

describe("the columns, against the built-in ones", () => {
  it("are placed after the name in the built-in order, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    expect(manifest.contributes.columns.map((c) => [c.kind.kind, c.afterColumn, c.id])).toEqual([
      ["ClusterPolicy", "name", "policy-state"],
      ["ClusterPolicy", "policy-state", "policy-namespace"],
      ["ClusterPolicy", "policy-namespace", "policy-mig-strategy"],
      ["NVIDIADriver", "name", "driver-state"],
      ["NVIDIADriver", "driver-state", "driver-type"],
      ["NVIDIADriver", "driver-type", "driver-version"],
      ["NVIDIADriver", "driver-version", "driver-node-selector"],
    ]);
  });

  function stateVariants(): [string, KubeObject][] {
    const out: [string, KubeObject][] = [
      ["ready", fx("policyReady")],
      ["not ready", fx("policyNotReady")],
      ["driver", fx("driver")],
      ["by CRD", fx("policyByCrd")],
    ];
    for (const state of ["ignored", "disabled", "somethingNew"]) {
      const o = fx("policyReady");
      st(o).state = state;
      out.push([state, o]);
    }
    const none = fx("policyReady");
    delete none.status;
    out.push(["no status", none]);
    const error = fx("policyNotReady");
    Object.assign(conditions(error)[1]!, { status: "True", message: "failed to deploy state-driver" });
    out.push(["error", error]);
    return out;
  }

  it("say the state as the built-in column did, coloured, with the operator's message on hover", () => {
    for (const id of ["policy-state", "driver-state"]) {
      for (const [label, obj] of stateVariants()) {
        const state = stateOf(obj);
        expect(cell(id, obj), `${id} ${label}`).toBe(en[`state.${state}`]);
        expect(drawn(id, obj), `${id} ${label}`).toEqual({ title: failureOf(obj)?.message, tone: toneOf(STATE_TONE[state]) });
      }
    }
  });

  it("show the operand namespace, the MIG strategy, the driver type, version and node selector", () => {
    for (const obj of [f.policyReady!, f.policyNotReady!, f.policyByCrd!]) {
      expect(cell("policy-namespace", obj)).toBe(operandNamespaceOf(obj));
      expect(cell("policy-mig-strategy", obj)).toBe(migStrategyOf(obj));
    }
    const typed = fx("driver");
    spec(typed).driverType = "vgpu-host-manager";
    const untyped = fx("driver");
    delete spec(untyped).driverType;
    const emptyType = fx("driver");
    spec(emptyType).driverType = "";
    for (const obj of [f.driver!, typed, untyped, emptyType]) {
      expect(cell("driver-type", obj)).toBe(driverTypeOf(obj));
      expect(cell("driver-version", obj)).toBe(driverVersionOf(obj));
    }
    // The node selector as JSON (the built-in column wrote `key=value, …`; a column cannot write a map's entries, #404).
    const selector = columnOf("driver-node-selector") as { jsonPath?: string };
    expect(jsonPath.formatJsonPathValues(jsonPath.evalJsonPath(f.driver!, selector.jsonPath!))).toBe('{"nvidia.com/gpu.present":"true"}');
  });
});
