// The manifest's declarative parts against the built-in view they replace. Its columns and problem rules (which also
// make the kinds' "Only problems") are judged here by Sextant's own window engine (src/extensions/problemRules.ts and
// columns.tsx, loaded at run time so the type check stays inside the extension) and compared with the former built-in
// view's model (`model.ts`, ported unchanged) on its fixtures and on generated objects of both status shapes — every
// shape the API server can store: a v1beta1 object with its old conditions in `.status.conditions` (and, since Cluster
// API 1.9, the new ones in `.status.v1beta2`), a v1beta2 one with the new in `.status.conditions` (and the old under
// `.status.deprecated.v1beta1`). Where the extension differs from the built-in view, the difference is the one its
// README names, and nothing else.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import objectsJson from "../fixtures/objects.json";
import { planChain } from "./chain";
import en from "./locales/en.json";
import {
  capiProblems,
  classOf,
  clusterNameOf,
  clusterReplicasOf,
  clusterState,
  conditionsOf,
  firstFailing,
  get,
  healthCheckState,
  healthCountsOf,
  isPaused,
  isProblem,
  machineState,
  nodeNameOf,
  phaseOf,
  readyText,
  replicasOf,
  scalableState,
  STATE_TONE,
  str,
  type Detected,
} from "./model";
import { isReadable, READABLE_KINDS, READ_GROUPS } from "./permitted";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const G = "cluster.x-k8s.io";
const CP = "controlplane.cluster.x-k8s.io";

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface WindowDetected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  activeFrom?: number;
  until?: number;
  lookups?: { kind: string; name: string; fact?: string }[];
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): WindowDetected[];
  factKey(when: unknown): string;
}
interface WindowColumn {
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
let engine: Engine;
let columns: { computedColumn(id: string, column: unknown): WindowColumn };
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as typeof columns;
  const { startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await startI18n("en");
});

type Column = (typeof manifest.contributes.columns)[number];
type Rule = (typeof manifest.contributes.problems)[number];
const COLUMNS = manifest.contributes.columns as Column[];
const RULES = manifest.contributes.problems as Rule[];
const column = (id: string) => columns.computedColumn(id, COLUMNS.find((c) => c.id === id)!);
const NOW = Date.parse("2026-10-20T10:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString().replace(".000Z", "Z");
const TIMES = [0, 3, 6, 31, 120].map((m) => NOW + m * 60_000);

/** What a cell of the window draws: its sort value, hover, tone and text. */
function cell(id: string, obj: KubeObject) {
  const col = column(id);
  let node = col.render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; value?: string; children?: unknown } } | string | null;
  let title: string | undefined;
  if (node && typeof node === "object" && node.props?.title !== undefined) {
    title = node.props.title;
    node = node.props.children as typeof node;
  }
  const tone = node && typeof node === "object" ? node.props?.tone : undefined;
  return { sort: col.value(obj), title, tone, text: col.searchText(obj, { now: NOW, t: (k) => k }) ?? undefined };
}

// ---------- Generated objects ----------

/** A small seeded random source, so a failure names an object that can be made again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The new conditions each kind has (api/core/v1beta2, controlplane/kubeadm/api/v1beta2). */
const NEW_TYPES: Record<string, string[]> = {
  Cluster: ["Available", "InfrastructureReady", "ControlPlaneInitialized", "ControlPlaneAvailable", "WorkersAvailable", "RemoteConnectionProbe", "RollingOut", "ScalingUp", "ScalingDown", "Remediating", "TopologyReconciled", "Deleting", "Paused"],
  Machine: ["Available", "Ready", "UpToDate", "BootstrapConfigReady", "InfrastructureReady", "NodeReady", "NodeHealthy", "Deleting", "Paused", "Updating"],
  MachineDeployment: ["Available", "MachinesReady", "MachinesUpToDate", "RollingOut", "ScalingUp", "ScalingDown", "Remediating", "Deleting", "Paused"],
  MachineSet: ["MachinesReady", "MachinesUpToDate", "ScalingUp", "ScalingDown", "Remediating", "Deleting", "Paused"],
  KubeadmControlPlane: ["Available", "CertificatesAvailable", "Initialized", "EtcdClusterHealthy", "MachinesReady", "MachinesUpToDate", "RollingOut", "ScalingUp", "ScalingDown", "Remediating", "Deleting", "Paused"],
  MachineHealthCheck: ["RemediationAllowed", "Paused"],
};
/** The old (v1beta1) conditions each kind has: none of the types whose False is good news. */
const OLD_TYPES: Record<string, string[]> = {
  Cluster: ["Ready", "InfrastructureReady", "ControlPlaneReady", "ControlPlaneInitialized", "TopologyReconciled"],
  Machine: ["Ready", "BootstrapReady", "InfrastructureReady", "DrainingSucceeded", "NodeHealthy"],
  MachineDeployment: ["Ready", "Available", "MachineSetReady"],
  MachineSet: ["Ready", "MachinesCreated", "MachinesReady", "Resized"],
  KubeadmControlPlane: ["Ready", "Available", "CertificatesAvailable", "MachinesCreated", "MachinesReady", "MachinesSpecUpToDate", "Resized"],
  MachineHealthCheck: ["RemediationAllowed"],
};
const NEGATIVE = new Set(["Deleting", "Paused", "ScalingUp", "ScalingDown", "RollingOut", "Remediating", "Updating"]);
const PHASES: Record<string, string[]> = {
  Cluster: ["Pending", "Provisioning", "Provisioned", "Deleting", "Failed"],
  Machine: ["Pending", "Provisioning", "Provisioned", "Running", "Updating", "Deleting", "Deleted", "Failed"],
  MachineDeployment: ["ScalingUp", "ScalingDown", "Running", "Failed"],
};
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function generate(kind: string, seed: number): KubeObject {
  const r = random(seed);
  const chance = (p: number) => r() < p;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (max: number) => Math.floor(r() * (max + 1));
  const legacy = chance(0.4);
  const group = kind === "KubeadmControlPlane" ? CP : G;
  const o: Obj = {
    apiVersion: `${group}/${legacy ? "v1beta1" : "v1beta2"}`,
    kind,
    metadata: { name: `${kind.toLowerCase()}-${seed}`, namespace: "default", uid: `u-${seed}`, resourceVersion: "1", creationTimestamp: iso(180), labels: {} as Record<string, string> },
    spec: {},
    status: {},
  };
  if (chance(0.06)) o.metadata.deletionTimestamp = iso(1);
  if (chance(0.05)) o.metadata.annotations = { "cluster.x-k8s.io/paused": "" };
  if ((kind === "Cluster" || kind === "MachineDeployment") && chance(0.05)) o.spec.paused = true;
  if (PHASES[kind] && chance(0.92)) o.status.phase = pick(PHASES[kind]);
  const when = () => iso(int(170));
  const newList = NEW_TYPES[kind]!.filter(() => chance(0.75)).map((type) => {
    if (NEGATIVE.has(type)) {
      // Good news when False: no message then, as Cluster API writes them.
      return chance(0.85) ? { type, status: "False", reason: `Not${type}`, lastTransitionTime: when() } : { type, status: "True", reason: type, message: `* ${type} is going on`, lastTransitionTime: when() };
    }
    const status = pick(["True", "True", "True", "False", "False", "Unknown"]);
    const c: Obj = { type, status, reason: status === "True" ? type : pick(["NotReady", "Failed", "WaitingFor"]), lastTransitionTime: when() };
    if (chance(status === "True" ? 0.15 : 0.75)) c.message = `* ${type}: ${pick(["waiting for infrastructure", "1 of 2 replicas ready", "probe failed"])}`;
    return c;
  });
  const oldList = OLD_TYPES[kind]!.filter(() => chance(0.75)).map((type) => {
    const status = pick(["True", "True", "False", "False", "Unknown"]);
    const c: Obj = { type, status, lastTransitionTime: when() };
    if (status !== "True") c.reason = pick(["WaitingForInfrastructure", "ScalingUp", "Failed"]);
    if (status === "False") c.severity = pick(["Error", "Warning", "Info"]);
    if (status !== "True" && chance(0.6)) c.message = `${type} ${pick(["is not ready yet", "failed: quota exceeded", "0 of 1 ready"])}`;
    return c;
  });
  if (r() < 0.3) newList.reverse();
  if (legacy) {
    if (chance(0.9)) o.status.conditions = oldList;
    if (chance(0.6)) o.status.v1beta2 = { conditions: newList };
  } else {
    if (chance(0.9)) o.status.conditions = newList;
    if (chance(0.5)) o.status.deprecated = { v1beta1: { conditions: oldList } };
  }
  if (chance(0.1) && kind !== "MachineHealthCheck") {
    const target = legacy ? o.status : ((o.status.deprecated ??= {}).v1beta1 ??= {});
    if (chance(0.5)) target.failureReason = "InvalidConfiguration";
    if (chance(0.7)) target.failureMessage = "the infrastructure cannot be created";
  }
  const counts = (into: Obj, names: string[]) => names.forEach((n) => chance(0.8) && (into[n] = int(3)));
  switch (kind) {
    case "Cluster": {
      o.spec.controlPlaneEndpoint = { host: "172.18.0.3", port: 6443 };
      if (chance(0.7)) o.spec.topology = { version: "v1.34.0", ...(legacy ? { class: "quick-start" } : { classRef: { name: "quick-start" } }) };
      const groups = (into: Obj) => {
        if (chance(0.7)) counts((into.controlPlane = {}), ["desiredReplicas", "replicas", "readyReplicas", "availableReplicas", "upToDateReplicas"]);
        if (chance(0.7)) counts((into.workers = {}), ["desiredReplicas", "replicas", "readyReplicas", "availableReplicas", "upToDateReplicas"]);
      };
      if (legacy) {
        if (chance(0.7)) o.status.controlPlaneReady = chance(0.5);
        if (o.status.v1beta2) groups(o.status.v1beta2);
      } else {
        if (chance(0.7)) o.status.initialization = { controlPlaneInitialized: chance(0.6) };
        groups(o.status);
      }
      break;
    }
    case "Machine":
      o.spec.clusterName = "c1";
      o.spec.version = "v1.34.0";
      if (chance(0.85)) o.status.lastUpdated = when();
      if (chance(0.5)) o.status.nodeRef = { name: `node-${seed}` };
      break;
    case "MachineDeployment":
    case "MachineSet":
    case "KubeadmControlPlane": {
      if (kind !== "KubeadmControlPlane") o.spec.clusterName = "c1";
      if (kind === "KubeadmControlPlane" ? chance(0.7) : true) o.metadata.labels["cluster.x-k8s.io/cluster-name"] = "c1";
      if (chance(0.9)) o.spec.replicas = int(3);
      if (chance(0.85)) o.status.replicas = int(3);
      if (legacy) {
        counts(o.status, ["readyReplicas", "availableReplicas", "updatedReplicas"]);
        if (chance(0.6)) counts((o.status.v1beta2 ??= {}), ["readyReplicas", "availableReplicas", "upToDateReplicas"]);
        if (kind === "KubeadmControlPlane" && chance(0.8)) o.status.initialized = chance(0.7);
      } else {
        counts(o.status, ["readyReplicas", "availableReplicas", "upToDateReplicas"]);
        if (kind === "KubeadmControlPlane" && chance(0.8)) o.status.initialization = { controlPlaneInitialized: chance(0.7) };
      }
      if (kind !== "KubeadmControlPlane") o.spec.template = { spec: { version: "v1.34.0" } };
      else o.spec.version = "v1.34.0";
      break;
    }
    case "MachineHealthCheck": {
      o.spec.clusterName = "c1";
      const expected = int(5);
      if (chance(0.85)) o.status.expectedMachines = expected;
      if (chance(0.85)) o.status.currentHealthy = int(expected);
      if (chance(0.85)) o.status.remediationsAllowed = int(2);
      break;
    }
  }
  return o as KubeObject;
}

const KINDS = ["Cluster", "Machine", "MachineDeployment", "MachineSet", "KubeadmControlPlane", "MachineHealthCheck"];
const COUNT = 700;
/** The fixtures of a kind and generated objects of it. */
function objectsOf(kind: string): [string, KubeObject][] {
  const out: [string, KubeObject][] = objects.filter((o) => o.kind === kind).map((o) => [`fixture ${o.metadata.name}`, copy(o)]);
  for (let i = 0; i < COUNT; i++) out.push([`generated ${kind} #${i}`, generate(kind, i * 7919 + kind.length)]);
  return out;
}

// ---------- The built-in readings ----------

type State = ReturnType<typeof clusterState> | ReturnType<typeof machineState> | ReturnType<typeof scalableState> | ReturnType<typeof healthCheckState>;
const builtInState = (kind: string, o: KubeObject): State =>
  kind === "Cluster" ? clusterState(o) : kind === "Machine" ? machineState(o) : kind === "MachineHealthCheck" ? healthCheckState(o) : scalableState(o);
const PREFIX: Record<string, string> = { Cluster: "c", Machine: "m", MachineDeployment: "md", MachineSet: "ms", KubeadmControlPlane: "k", MachineHealthCheck: "h" };
const WINDOW_TONE: Record<string, string> = { success: "success", warning: "warning", danger: "danger", muted: "muted" };
/** The built-in hover: the phase and the first failing condition's message (else reason). */
function builtInHover(o: KubeObject): string | undefined {
  const failing = firstFailing(o);
  return [phaseOf(o), failing?.message ?? failing?.reason].filter(Boolean).join(": ") || undefined;
}

// ---------- The extension's hover, as its README describes it ----------

type Cond = { type: string; status?: string; reason?: string; message?: string; severity?: string };
const list = (o: KubeObject, ...path: string[]): Cond[] => (Array.isArray(get(o, ...path)) ? (get(o, ...path) as Cond[]) : []);
const legacyShape = (o: KubeObject) => /\/v1beta1$|\/v1alpha/.test(o.apiVersion ?? "");
const filled = (s: string | undefined) => (s === undefined || s === "" ? undefined : s);
const ALL_NEGATIVE = ["Deleting", "Paused", "ScalingUp", "ScalingDown", "RollingOut", "Remediating", "Updating"];
/** The types whose False is good news, as each kind's hover is written: all where they fit, else the kind's own. */
const NEG_OF: Record<string, string[]> = {
  Cluster: ALL_NEGATIVE.filter((t) => t !== "Updating"),
  MachineDeployment: ALL_NEGATIVE.filter((t) => t !== "Updating"),
  Machine: ["Deleting", "Paused", "Updating"],
  MachineSet: ALL_NEGATIVE,
  KubeadmControlPlane: ALL_NEGATIVE,
  MachineHealthCheck: ALL_NEGATIVE,
};
const PHASED = new Set(["Cluster", "Machine", "MachineDeployment"]);

/** What the extension's hover reads: README "Requirements and limits". */
function documentedHover(kind: string, o: KubeObject): string | undefined {
  const phase = filled(phaseOf(o));
  const p = (body: string | undefined) => (phase && body ? `${phase}: ${body}` : undefined);
  const sc = list(o, "status", "conditions");
  const v2 = list(o, "status", "v1beta2", "conditions");
  const dep = list(o, "status", "deprecated", "v1beta1", "conditions");
  const negative = NEG_OF[kind]!;
  const first = (l: Cond[]) => l.find((c) => c.status === "False" && !negative.includes(c.type));
  const v2f = first(v2);
  const scf = first(sc.filter((c) => c.severity === undefined || !["Error", "Warning", "Info"].includes(c.severity)));
  const sco = sc.find((c) => c.status === "False" && c.severity === "Error");
  const depo = dep.find((c) => c.status === "False" && c.severity === "Error");
  const there = (values: (string | undefined)[]) => values.find((v) => v !== undefined);
  if (!PHASED.has(kind)) return there([v2f?.message, v2f?.reason, scf?.message, sco?.message, scf?.reason, sco?.reason, depo?.message, depo?.reason]);
  const fromTemplates = [p(filled(v2f?.message)), p(filled(v2f?.reason)), p(filled(scf?.message) ?? filled(sco?.message)), p(filled(scf?.reason) ?? filled(sco?.reason))].find(Boolean);
  return fromTemplates ?? there([v2f?.message, v2f?.reason, scf?.message, scf?.reason, sco?.message, sco?.reason, phaseOf(o), depo?.message]);
}

/** Why the documented hover may differ from the built-in one, or `null` where it must not. */
function hoverDifference(o: KubeObject): string | null {
  const hasNew = conditionsOf(o).length > 0;
  if (!hasNew && !legacyShape(o)) return "a v1beta2 object with only deprecated conditions: the phase alone";
  if (hasNew && !firstFailing(o)) return "no failing new condition: the first old one of severity Error";
  return null;
}

// ---------- Columns ----------

describe("the state columns", () => {
  for (const kind of KINDS) {
    it(`say ${kind}s' states as the built-in view did, sorted and filtered by the state's name`, () => {
      let differing = 0;
      for (const [label, o] of objectsOf(kind)) {
        const state = builtInState(kind, o);
        const drawn = cell(`${PREFIX[kind]}-status`, o);
        expect(drawn.sort, `${label} state`).toBe(state);
        expect(drawn.text, label).toBe(en[`state.${state}` as keyof typeof en]);
        expect(drawn.tone, label).toBe(WINDOW_TONE[STATE_TONE[state]]);
        // The hover: as the README says; where that differs from the built-in one, only for the reasons it names.
        expect(drawn.title, `${label} hover`).toBe(documentedHover(kind, o));
        if (drawn.title !== builtInHover(o)) {
          differing++;
          expect(hoverDifference(o), `${label}: ${drawn.title} / ${builtInHover(o)}`).not.toBeNull();
        }
      }
      // Only the shapes the README names, which the generator makes far more often than clusters have them.
      expect(differing).toBeLessThan(COUNT / 10);
    });
  }

  it("give every state of the built-in view in its tone", () => {
    type StateCase = { value: string; text: string; tone: string };
    const words = (id: string) => ((COLUMNS.find((c) => c.id === id)!.cases ?? []) as StateCase[]).map((c) => [c.value, c.text, c.tone]);
    const tone = { success: "ok", warning: "warning", danger: "error", muted: "muted" } as Record<string, string>;
    for (const id of ["c-status", "m-status", "md-status", "ms-status", "k-status", "h-status"])
      for (const [value, text, t] of words(id)) {
        expect(text, id).toBe(en[`state.${value}` as keyof typeof en]);
        expect(t, id).toBe(tone[STATE_TONE[value as State]]);
      }
  });
});

describe("the other columns", () => {
  const n = (v: number | undefined) => v;
  const BUILT_IN: Record<string, (o: KubeObject) => unknown> = {
    "c-phase": phaseOf,
    "c-class": (o) => classOf(o)?.name,
    "c-version": (o) => str(get(o, "spec", "topology", "version")),
    "c-control-plane": (o) => readyText(clusterReplicasOf(o).controlPlane),
    "c-workers": (o) => readyText(clusterReplicasOf(o).workers),
    "m-phase": phaseOf,
    "m-cluster": clusterNameOf,
    "m-node": nodeNameOf,
    "m-version": (o) => str(get(o, "spec", "version")),
    "h-cluster": clusterNameOf,
    "h-healthy": (o) => {
      const c = healthCountsOf(o);
      return c.expected === undefined ? undefined : `${c.healthy ?? 0}/${c.expected}`;
    },
    "h-remediations-allowed": (o) => n(healthCountsOf(o).allowed),
  };
  for (const p of ["md", "ms", "k"]) {
    BUILT_IN[`${p}-cluster`] = clusterNameOf;
    BUILT_IN[`${p}-ready`] = (o) => readyText(replicasOf(o));
    BUILT_IN[`${p}-up-to-date`] = (o) => replicasOf(o).upToDate;
    BUILT_IN[`${p}-available`] = (o) => replicasOf(o).available;
    BUILT_IN[`${p}-version`] = (o) => str(get(o, "spec", p === "k" ? "version" : "template", ...(p === "k" ? [] : ["spec", "version"])));
  }

  it("cover every column of the manifest, in the built-in order and widths", () => {
    const byKind = (kind: string) => COLUMNS.filter((c) => c.kind.kind === kind).map((c) => [c.title, c.width]);
    expect(byKind("Cluster")).toEqual([["Status", "130px"], ["Phase", "110px"], ["Class", "minmax(110px, 1fr)"], ["Version", "100px"], ["Control plane", "100px"], ["Workers", "90px"]]);
    expect(byKind("Machine")).toEqual([["Status", "130px"], ["Phase", "110px"], ["Cluster", "minmax(120px, 1fr)"], ["Node", "minmax(140px, 1.5fr)"], ["Version", "100px"]]);
    for (const kind of ["MachineDeployment", "MachineSet", "KubeadmControlPlane"])
      expect(byKind(kind), kind).toEqual([["Status", "130px"], ["Cluster", "minmax(120px, 1fr)"], ["Ready", "80px"], ["Up to date", "90px"], ["Available", "90px"], ["Version", "100px"]]);
    expect(byKind("MachineHealthCheck")).toEqual([["Status", "130px"], ["Cluster", "minmax(120px, 1fr)"], ["Healthy", "90px"], ["Remediations allowed", "120px"]]);
    expect(byKind("ClusterResourceSet")).toEqual([["Strategy", "120px"]]);
    expect(byKind("ClusterClass")).toEqual([]);
    for (const kind of [...new Set(COLUMNS.map((c) => c.kind.kind))]) {
      const own = COLUMNS.filter((c) => c.kind.kind === kind);
      own.forEach((c, i) => expect(c.afterColumn, c.id).toBe(i === 0 ? "namespace" : own[i - 1]!.id));
    }
  });

  for (const kind of KINDS) {
    it(`read ${kind}s as the built-in columns did`, () => {
      const ids = COLUMNS.filter((c) => c.kind.kind === kind && !c.id.endsWith("-status")).map((c) => c.id);
      for (const id of ids) expect(BUILT_IN[id], id).toBeDefined();
      for (const [label, o] of objectsOf(kind)) for (const id of ids) expect(cell(id, o).sort, `${label} ${id}`).toBe(BUILT_IN[id]!(o));
    });
  }

  it("give a ClusterResourceSet's strategy, ApplyOnce when unset", () => {
    const crs = (spec: Record<string, unknown>) => ({ apiVersion: "addons.cluster.x-k8s.io/v1beta2", kind: "ClusterResourceSet", metadata: { name: "crs" }, spec }) as unknown as KubeObject;
    expect(cell("crs-strategy", crs({})).sort).toBe("ApplyOnce");
    expect(cell("crs-strategy", crs({ strategy: "Reconcile" })).sort).toBe("Reconcile");
  });
});

// ---------- Problems ----------

/** The built-in groups by the manifest's names (lowercase ids). */
const GROUP: Record<string, string> = { failed: "failed", notAvailable: "not-available", provisioning: "provisioning", RemediationBlocked: "remediation-blocked" };
const rulesOf = (kind: string) => RULES.filter((r) => r.kind.kind === kind);

/** The Cluster a Machine or control plane belongs to, as the test's world has it: none, running, or paused. */
type World = "none" | "running" | "paused";
const worldCluster = (world: World): KubeObject | null =>
  world === "none" ? null : ({ apiVersion: `${G}/v1beta2`, kind: "Cluster", metadata: { name: "c1", namespace: "default" }, spec: world === "paused" ? { paused: true } : {} } as unknown as KubeObject);

/** What the built-in view counted for `o` at `now`: its detector, its grace, and a paused Cluster leaving it out. */
function builtInFound(kind: string, o: KubeObject, now: number, world: World) {
  const cluster = worldCluster(world);
  return capiProblems({ group: kind === "KubeadmControlPlane" ? CP : G, kind }, o)
    .filter((d: Detected) => !(d.belongsTo && cluster && d.belongsTo === cluster.metadata.name && isPaused(cluster)))
    .filter((d: Detected) => (d.since && d.graceMs ? Date.parse(d.since) + d.graceMs : -Infinity) <= now)
    .map((d: Detected) => ({ reason: d.reason, group: GROUP[d.group ?? d.reason], message: d.message ?? "", since: d.since }));
}

/** What the manifest's rules count for `o` at `now`, with the window's lookups of its Cluster. */
function windowFound(kind: string, o: KubeObject, now: number, world: World) {
  const cluster = worldCluster(world);
  return rulesOf(kind)
    .flatMap((rule) => engine.detectRule(rule, o).map((d) => ({ d, rule })))
    .filter(({ d }) => (d.activeFrom ?? -Infinity) <= now && (d.until === undefined || d.until > now))
    .filter(({ d, rule }) =>
      (d.lookups ?? []).every((lookup) => {
        if (lookup.fact === undefined) return cluster === null || cluster.metadata.name !== lookup.name;
        const when = (rule.when as { of: { type: string; when?: unknown }[] }).of.find((c) => c.type === "related")!.when;
        return cluster !== null && cluster.metadata.name === lookup.name && engine.evaluate(when, cluster).holds;
      }),
    )
    .map(({ d }) => ({ reason: d.reason, group: d.group, message: d.message ?? "", since: d.since }));
}

/** Cluster API ≥ 1.9 writes the new Paused condition on a paused Cluster's objects: their own pause says it. */
function pausedByCluster(o: KubeObject): KubeObject {
  const c = copy(o);
  const st = c.status as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const news = legacyShape(c) ? st.v1beta2?.conditions : st.conditions;
  if (Array.isArray(news) && news.length > 0) news.unshift({ type: "Paused", status: "True", reason: "Paused", lastTransitionTime: iso(0) });
  return c;
}

describe("the problem rules", () => {
  for (const kind of KINDS) {
    it(`find ${kind}s' problems as the built-in view did, with its graces`, () => {
      for (const [label, o] of objectsOf(kind)) {
        for (const now of TIMES) {
          const at = `${label} at +${(now - NOW) / 60_000}m`;
          expect(windowFound(kind, o, now, "none"), at).toEqual(builtInFound(kind, o, now, "none"));
          expect(windowFound(kind, o, now, "running"), at).toEqual(builtInFound(kind, o, now, "running"));
          // "Only problems" comes from the same rules, judged with the Cluster's row (the built-in filter knew no pause).
          const listed = windowFound(kind, o, now, "running").length > 0;
          expect(listed, `${at} Only problems`).toBe(isProblem(o, { group: kind === "KubeadmControlPlane" ? CP : G, kind }, now));
        }
      }
    });
  }

  for (const kind of ["Machine", "KubeadmControlPlane"]) {
    it(`leave out the problems of a paused Cluster's ${kind}s as the built-in view did`, () => {
      for (const [label, raw] of objectsOf(kind)) {
        const o = pausedByCluster(raw);
        for (const now of TIMES) expect(windowFound(kind, o, now, "paused"), label).toEqual(builtInFound(kind, o, now, "paused"));
      }
    });
  }

  it("name the built-in reasons and nothing else, and notify", () => {
    expect([...new Set(RULES.map((r) => r.reasonOr))].sort()).toEqual(["Failed", "NotAvailable", "ProvisioningStuck", "RemediationBlocked"]);
    for (const r of RULES) expect((r as { notify?: boolean }).notify, r.id).toBe(true);
    expect(new Set(RULES.map((r) => r.title)).size).toBe(RULES.length);
  });

  it("judge the kinds the built-in category judged", () => {
    expect([...new Set(RULES.map((r) => r.kind.kind))].sort()).toEqual(["Cluster", "KubeadmControlPlane", "Machine", "MachineHealthCheck"]);
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "clusterApi", label: { one: "{{count}} object needs attention", other: "{{count}} objects need attention" } }]);
  });
});

// ---------- The rest of the manifest ----------

describe("the manifest", () => {
  it("lists the kinds in the built-in section, its icons and order, without printer columns", () => {
    expect(manifest.contributes.kinds.map((k) => [k.group, k.kind, k.title, k.icon, k.order, k.printerColumns])).toEqual([
      [G, "Cluster", "Clusters", "capiCluster", 10, false],
      [G, "ClusterClass", "Cluster Classes", "capiClusterClass", 11, false],
      [CP, "KubeadmControlPlane", "Kubeadm Control Planes", "capiControlPlane", 20, false],
      [G, "MachineDeployment", "Machine Deployments", "capiMachineDeployment", 30, false],
      [G, "MachineSet", "Machine Sets", "capiMachineSet", 31, false],
      [G, "Machine", "Machines", "capiMachine", 32, false],
      [G, "MachineHealthCheck", "Machine Health Checks", "capiHealthCheck", 40, false],
      ["addons.cluster.x-k8s.io", "ClusterResourceSet", "Cluster Resource Sets", "capiResourceSet", 50, false],
    ]);
    expect(manifest.contributes.sections).toEqual([{ section: "clusterApi", title: "Cluster API", icon: "clusterApi", after: "prometheusOperator" }]);
    expect(manifest.contributes.detailsSections).toEqual([
      {
        id: "cluster-api",
        title: "Cluster API",
        kinds: ["Cluster", "Machine", "MachineDeployment", "MachineSet", "KubeadmControlPlane", "MachineHealthCheck"].map((kind) => ({ group: kind === "KubeadmControlPlane" ? CP : G, kind })),
        placement: "section",
        order: 20,
        heading: false,
      },
    ]);
  });

  it("asks only to read, and the details know the kinds it may read", () => {
    const rules = manifest.permissions.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]!.actions).toEqual(["read"]);
    const listed: Record<string, string[]> = {};
    for (const k of (rules[0]!.kinds as { kinds: { group: string; kind: string }[] }).kinds) (listed[k.group] ??= []).push(k.kind);
    expect(listed).toEqual(READABLE_KINDS);
    // Every provider's objects through the groups under the domain, as the built-in view read any provider kind.
    expect(manifest.permissions.readGroups).toEqual([...READ_GROUPS]);
    expect(isReadable({ group: "infrastructure.cluster.x-k8s.io", kind: "SomeNewProviderMachine" })).toBe(true);
    expect(isReadable({ group: "evilcluster.x-k8s.io", kind: "X" })).toBe(false);
    expect(manifest.contributes).not.toHaveProperty("actions");
  });

  it("keeps the chain as the built-in planner had it", () => {
    const md = objects.find((o) => o.kind === "MachineDeployment" && o.metadata.name === "capi-quickstart-md-0-6xq7b")!;
    const ms = objects.find((o) => o.kind === "MachineSet")!;
    const machines = objects.filter((o) => o.kind === "Machine" && o.apiVersion?.endsWith("v1beta2"));
    const plan = planChain([md], [ms], machines, 50);
    expect(plan.controlPlane.map((m) => m.metadata.name)).toEqual(["capi-quickstart-n5w87-hz4sv"]);
    expect(plan.deployments[0]!.sets[0]!.machines.map((m) => m.metadata.name)).toEqual(["capi-quickstart-md-0-6xq7b-k9dpl-2vbjm", "capi-quickstart-md-0-6xq7b-k9dpl-5tq8w"]);
    expect(planChain([md], [ms], machines, 2).hidden).toBe(1);
  });
});
