// The model and the manifest's declarative parts. The manifest's problem rules, the kinds' "Only problems", the GPU
// block's condition and the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and
// columns.tsx, loaded at run time so the type check stays inside the extension; `related` lookups as
// src/extensions/problemsAcross.ts judges them) and
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
  /**
   * The objects the rule looks up (`related`: with the fact its own `when` must hold for, by `factKey`); of those
   * with the same `anyOf` (an `any` of lookups), one is enough.
   */
  lookups?: { group: string; kind: string; name: string; fact?: string; anyOf?: string }[];
  /** The object the problem is about when it is not the judged one (`about`). */
  object?: { kind: { group: string; version: string; kind: string }; namespace: string | null; name: string };
  notifyAs?: string;
  stamp?: string;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  filter?: { type: string; value(obj: KubeObject, ctx: { now: number }): unknown };
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  // Sextant's own texts, so lists join as in the window (`common:list.separator`).
  const { startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await startI18n("en");
});

type Rule = (typeof manifest.contributes.problems)[number];
const rules = manifest.contributes.problems as Rule[];
const kindOfObj = (o: KubeObject) => ({ group: (o.apiVersion ?? "").includes("/") ? o.apiVersion!.split("/")[0]! : "", kind: o.kind ?? "" });
const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

/**
 * Whether the objects a problem looks up stand as the window's `judgeAcross` asks (`src/extensions/problemsAcross.ts`):
 * a `related` object there among `objects` with its fact holding, a `missing` one not there; of an `any` of lookups
 * (the same `anyOf`), one standing is enough.
 */
function lookupsStand(d: Detected, objects: KubeObject[]): boolean {
  const stands = (lookup: NonNullable<Detected["lookups"]>[number]) => {
    const found = objects.find((o) => sameKind(kindOfObj(o), lookup) && o.metadata.name === lookup.name);
    if (lookup.fact === undefined) return found === undefined;
    return found !== undefined && engine.evaluate(JSON.parse(lookup.fact), found).holds;
  };
  const lookups = d.lookups ?? [];
  const groups = new Set(lookups.flatMap((l) => (l.anyOf === undefined ? [] : [l.anyOf])));
  return lookups.every((l) => l.anyOf !== undefined || stands(l)) && [...groups].every((g) => lookups.some((l) => l.anyOf === g && stands(l)));
}

/** The window's problems with the object each is about (`about`, else the judged one), first seen at `firstSeen`. */
function windowDetected(objects: KubeObject[]) {
  return objects.flatMap((obj) =>
    rules
      .filter((rule) => sameKind(rule.kind, kindOfObj(obj)))
      .flatMap((rule) => engine.detectRule(rule, obj).map((d) => ({ rule, d, obj })))
      .filter(({ d }) => lookupsStand(d, objects)),
  );
}

/** The problems the manifest's rules find, as the window finds them, first seen at `firstSeen`. */
function windowProblems(objects: KubeObject[], firstSeen: number) {
  return windowDetected(objects).map(({ d, obj }) => {
    const start = d.since ? Date.parse(d.since) : firstSeen;
    return {
      kind: d.object?.kind.kind ?? obj.kind ?? "",
      name: d.object?.name ?? obj.metadata.name,
      reason: d.reason,
      message: d.message ?? "",
      activeAt: d.activeFrom ?? start + (d.graceMs ?? 0),
    };
  });
}

/** The built-in problems in the window's terms: each about its object (a component's about its ClusterPolicy or NVIDIADriver). */
const builtIn = (problems: BuiltInProblem[]) =>
  problems.map((p) => ({ kind: p.object.kind, name: p.object.name, reason: p.reason, message: p.message, activeAt: p.activeAt }));
const sorted = <T extends { kind: string; name: string; reason: string; message: string }>(list: T[]) =>
  [...list].sort((a, b) => `${a.kind}/${a.name}/${a.reason}/${a.message}`.localeCompare(`${b.kind}/${b.name}/${b.reason}/${b.message}`));

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
      "ClusterPolicy/cluster-policy:ComponentNotReady",
      "ClusterPolicy/cluster-policy:NotReady",
      "Node/gpu-node-2:MigConfigFailed",
      "NVIDIADriver/default:ComponentNotReady",
      "NVIDIADriver/default:NotReady",
    ]);
    expect(found[1]).toMatchObject({ message: "ClusterPolicy is not ready, states not ready: [state-driver]", activeAt: Date.parse("2026-10-01T09:05:00Z") + 10 * 60_000 });
    expect(found[0]).toMatchObject({ message: "DaemonSet nvidia-driver-daemonset-5.15.0-1066-aws-ubuntu22.04: 1 of 2 Pods ready, 2 updated.", activeAt: NOW + 10 * 60_000 });
    expect(found[2]).toMatchObject({ message: "The MIG manager could not apply the MIG configuration all-3g.40gb on this node.", activeAt: NOW + 2 * 60_000 });
  });

  it("tell a component's problem about its ClusterPolicy or NVIDIADriver, notifying once for it, as the built-in did", () => {
    const policy = fx("policyNotReady");
    const objects = [policy, fx("driver"), ...daemonSets(policy)];
    const components = windowDetected(objects).filter(({ d }) => d.reason === "ComponentNotReady");
    expect(components.map(({ obj, d }) => [obj.metadata.name, d.object, d.notifyAs])).toEqual([
      [
        "nvidia-driver-daemonset-5.15.0-1066-aws-ubuntu22.04",
        { kind: { group: "nvidia.com", version: "v1", kind: "ClusterPolicy" }, namespace: null, name: "cluster-policy" },
        "nvidia.com/ClusterPolicy//cluster-policy",
      ],
      [
        "nvidia-gpu-driver-ubuntu22.04-7c6d5b9f8",
        { kind: { group: "nvidia.com", version: "v1alpha1", kind: "NVIDIADriver" }, namespace: null, name: "default" },
        "nvidia.com/NVIDIADriver//default",
      ],
    ]);
    // One notification group for every component of an object, as the built-in key `<uid>|ComponentNotReady`.
    expect(new Set(components.map(({ d }) => d.group))).toEqual(new Set(["component-not-ready"]));
    // Without its ClusterPolicy among the rows (not read yet), nothing is said.
    expect(windowProblems(daemonSets(policy).slice(0, 1), NOW)).toEqual([]);
  });

  it("start a component's grace again whenever its counts move, as the built-in stamp `ready/updated/desired` did", () => {
    const policy = fx("policyNotReady");
    const stampOf = (status: Record<string, number>) => {
      const ds = ownedBy(f.dsDevicePlugin!, policy);
      ds.status = status;
      const found = windowDetected([policy, ds]).filter(({ d }) => d.reason === "ComponentNotReady");
      expect(found, JSON.stringify(status)).toHaveLength(1);
      return found[0]!.d.stamp;
    };
    const builtInStamp = (s: Record<string, number>) => `${s.numberReady ?? 0}/${s.updatedNumberScheduled ?? 0}/${s.desiredNumberScheduled ?? 0}`;
    const steps: Record<string, number>[] = [
      { desiredNumberScheduled: 3, numberReady: 3 },
      { desiredNumberScheduled: 3, numberReady: 2, updatedNumberScheduled: 1 },
      { desiredNumberScheduled: 3, numberReady: 2, updatedNumberScheduled: 1 },
      { desiredNumberScheduled: 3, numberReady: 2, updatedNumberScheduled: 2 },
      { desiredNumberScheduled: 4, numberReady: 2, updatedNumberScheduled: 2 },
      { desiredNumberScheduled: 4, numberReady: 3, updatedNumberScheduled: 2 },
    ];
    for (let i = 1; i < steps.length; i++) {
      expect(stampOf(steps[i]!) !== stampOf(steps[i - 1]!), `step ${i}`).toBe(builtInStamp(steps[i]!) !== builtInStamp(steps[i - 1]!));
    }
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
    const none = windowProblems([policy, ds({ desiredNumberScheduled: 2, numberReady: 2 })], NOW).filter((p) => p.reason === "ComponentNotReady");
    expect(none[0]!.message).toBe("DaemonSet nvidia-device-plugin-daemonset: 2 of 2 Pods ready, 0 updated.");
  });

  it("judge only the components' DaemonSets, not of an ignored, disabled or deleted object, the driver's only while the policy deploys it", () => {
    const behind = { desiredNumberScheduled: 2, numberReady: 1, updatedNumberScheduled: 1 };
    const ds = (owner: KubeObject, name: string): KubeObject =>
      ownedBy({ apiVersion: "apps/v1", kind: "DaemonSet", metadata: { name, namespace: "gpu-operator", uid: name }, status: behind }, owner);
    const policyWith = (change: (p: KubeObject) => void) => {
      const p = fx("policyNotReady");
      change(p);
      return p;
    };
    const policies: [string, KubeObject][] = [
      ["not ready", fx("policyNotReady")],
      ["ready", fx("policyReady")],
      ["ignored", policyWith((p) => (st(p).state = "ignored"))],
      ["disabled", policyWith((p) => (st(p).state = "disabled"))],
      ["no state", policyWith((p) => delete st(p).state)],
      ["deleting", policyWith((p) => (p.metadata.deletionTimestamp = "2026-10-01T11:00:00Z"))],
      ["driver off", policyWith((p) => (spec(p).driver = { enabled: false }))],
      ["driver by NVIDIADriver", fx("policyByCrd")],
    ];
    const names = [
      "nvidia-driver-daemonset",
      "nvidia-driver-daemonset-5.15.0-1066-aws-ubuntu22.04",
      "nvidia-driver-daemonsets",
      "nvidia-device-plugin-daemonset",
      "nvidia-operator-validator",
      // The retired Kata manager's, left by an older operator: shown, never judged.
      "nvidia-kata-manager",
      // A DaemonSet of the operator's that is no component of the view.
      "nvidia-device-plugin-mps-control-daemon",
    ];
    for (const [label, policy] of policies) {
      for (const name of names) expectSame({ policies: [policy], daemonSets: [ds(policy, name)] }, `${label} ${name}`);
    }
    const driver = (change: (d: KubeObject) => void) => {
      const d = fx("driver");
      change(d);
      return d;
    };
    for (const [label, d] of [
      ["not ready", fx("driver")],
      ["ignored", driver((o) => (st(o).state = "ignored"))],
      ["disabled", driver((o) => (st(o).state = "disabled"))],
      ["deleting", driver((o) => (o.metadata.deletionTimestamp = "2026-10-01T11:00:00Z"))],
    ] as [string, KubeObject][]) {
      expectSame({ drivers: [d], daemonSets: [ds(d, "nvidia-gpu-driver-ubuntu22.04-1"), ds(d, "nvidia-gpu-driver-rhel9-2")] }, `NVIDIADriver ${label}`);
    }
  });

  it("judge a component only while its ClusterPolicy turns it on, as the built-in rule did", () => {
    // policyReady turns DCGM off: the built-in rule left its DaemonSet (the operator deletes it when it next reconciles)
    // alone, and so does the rule, asking the policy the component's own switch.
    const policy = fx("policyReady");
    const dcgm = ownedBy({ apiVersion: "apps/v1", kind: "DaemonSet", metadata: { name: "nvidia-dcgm", namespace: "gpu-operator", uid: "dcgm" }, status: { desiredNumberScheduled: 2, numberReady: 1 } }, policy);
    expect(gpuProblems({ policies: [policy], drivers: [], daemonSets: [dcgm], failedNodes: [] }, NOW)).toEqual([]);
    expect(windowProblems([policy, dcgm], NOW)).toEqual([]);
    // Every component (but the driver, judged by its own rules) under every switch of its own, of sandbox workloads and
    // their mode, in every state of the policy.
    const behind = { desiredNumberScheduled: 2, numberReady: 1, updatedNumberScheduled: 1 };
    const noneUpdated = { desiredNumberScheduled: 2, numberReady: 2 };
    let judged = 0;
    for (const def of COMPONENTS.filter((c) => c.id !== "driver")) {
      for (const enabled of [true, false, undefined, "true"]) {
        for (const sandbox of [true, false, undefined]) {
          for (const mode of ["kubevirt", "kata", undefined]) {
            for (const state of ["notReady", "ready", "ignored"]) {
              const p = fx("policyReady");
              const sp = spec(p);
              if (enabled === undefined) delete sp[def.field ?? def.id];
              else sp[def.field ?? def.id] = { ...(sp[def.field ?? def.id] as object), enabled };
              sp.sandboxWorkloads = { ...(sandbox === undefined ? {} : { enabled: sandbox }), ...(mode === undefined ? {} : { mode }) };
              st(p).state = state;
              for (const status of [behind, noneUpdated]) {
                const ds = ownedBy({ apiVersion: "apps/v1", kind: "DaemonSet", metadata: { name: def.daemonSet, namespace: "gpu-operator", uid: def.id }, status }, p);
                const label = `${def.id} ${String(enabled)} ${String(sandbox)} ${String(mode)} ${state} ${JSON.stringify(status)}`;
                expectSame({ policies: [p], daemonSets: [ds] }, label);
                if (gpuProblems({ policies: [p], drivers: [], daemonSets: [ds], failedNodes: [] }, NOW).some((x) => x.reason === "ComponentNotReady")) judged++;
              }
            }
          }
        }
      }
    }
    expect(judged).toBeGreaterThan(100);
  });

  it("differ where a rule cannot reach: a DaemonSet the operator does not own", () => {
    // A DaemonSet of the component's name that the operator does not own: the built-in rule judged it by its name.
    const stray = fx("dsDriver");
    expect(windowProblems([fx("policyNotReady"), stray], NOW).filter((p) => p.reason === "ComponentNotReady")).toEqual([]);
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

  it("stay within the rules a manifest may have, each told by its own message", () => {
    expect(rules.length).toBeLessThanOrEqual(30);
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
  // An empty hover (an Error condition with an empty message) is no hover, as the built-in `title={message || undefined}`.
  const title = node?.props?.title || undefined;
  if (node?.props?.title !== undefined) node = node!.props!.children as typeof node;
  return { title, tone: node?.props?.tone };
}

describe("the columns, against the built-in ones", () => {
  it("are placed after the name in the built-in order and widths, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    expect(manifest.contributes.columns.map((c) => [c.kind.kind, c.afterColumn, c.id, windowColumn(c.id).width])).toEqual([
      ["ClusterPolicy", "name", "policy-state", "120px"],
      ["ClusterPolicy", "policy-state", "policy-namespace", "minmax(120px, 1fr)"],
      ["ClusterPolicy", "policy-namespace", "policy-mig-strategy", "120px"],
      ["NVIDIADriver", "name", "driver-state", "120px"],
      ["NVIDIADriver", "driver-state", "driver-type", "140px"],
      ["NVIDIADriver", "driver-type", "driver-version", "minmax(100px, 1fr)"],
      ["NVIDIADriver", "driver-version", "driver-node-selector", "minmax(140px, 1fr)"],
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
    // An Error condition without a message hides the Ready one's, as `failureOf` reads them.
    const silent = fx("policyNotReady");
    Object.assign(conditions(silent)[1]!, { status: "True" });
    delete conditions(silent)[1]!.message;
    out.push(["error without a message", silent]);
    const empty = fx("policyNotReady");
    Object.assign(conditions(empty)[1]!, { status: "True", message: "" });
    out.push(["error with an empty message", empty]);
    const readyTrue = fx("policyNotReady");
    Object.assign(conditions(readyTrue)[0]!, { status: "True", message: "all ready" });
    out.push(["ready true", readyTrue]);
    for (const state of ["ready", "ignored", "disabled", "somethingNew"]) {
      const o = fx("policyNotReady");
      st(o).state = state;
      out.push([`${state}, Ready false`, o]);
    }
    return out;
  }

  it("say the state as the built-in column did, coloured, with the operator's message on hover", () => {
    for (const id of ["policy-state", "driver-state"]) {
      for (const [label, obj] of stateVariants()) {
        const state = stateOf(obj);
        expect(cell(id, obj), `${id} ${label}`).toBe(en[`state.${state}`]);
        expect(drawn(id, obj), `${id} ${label}`).toEqual({ title: failureOf(obj)?.message, tone: STATE_TONE[state] });
      }
    }
  });

  it("sort and filter the state by its name, as the built-in column's value", () => {
    for (const id of ["policy-state", "driver-state"]) {
      const column = windowColumn(id);
      expect(column.filter?.type, id).toBe("string");
      for (const [label, obj] of stateVariants()) {
        expect(column.value(obj), `${id} ${label}`).toBe(stateOf(obj));
        expect(column.filter!.value(obj, { now: NOW }), `${id} ${label}`).toBe(stateOf(obj));
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
    // The node selector as the built-in `key=value, …`, in the API server's order (Go writes a map's keys sorted).
    const two = fx("driver");
    spec(two).nodeSelector = { "nvidia.com/gpu.deploy.driver": "true", "nvidia.com/gpu.present": "true" };
    for (const obj of [f.driver!, two]) {
      const builtIn = Object.entries(driverNodeSelectorOf(obj)).map(([k, v]) => `${k}=${v}`).join(", ");
      expect(cell("driver-node-selector", obj)).toBe(builtIn);
      expect(windowColumn("driver-node-selector").value(obj)).toBe(builtIn);
    }
  });
});
