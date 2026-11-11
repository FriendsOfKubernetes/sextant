// The model and the manifest's declarative parts. The manifest's problem rules, the kinds' "Only problems" and the
// columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run
// time so the type check stays inside the extension) and compared with the model they replace — the reading of
// Sextant's former built-in view (ADR-0100), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import fixtures from "../fixtures/monitoring.json";
import {
  ALERTMANAGER,
  endpointsOf,
  isServerProblem,
  judgeMonitors,
  labelsOf,
  monitorSelector,
  MONITORING_GROUP,
  pickedUpBy,
  POD_MONITOR,
  portText,
  PROMETHEUS,
  prometheusOperatorProblems,
  ruleCount,
  ruleGroupsOf,
  selectorText,
  SERVER_TONE,
  serverReadiness,
  SERVICE_MONITOR,
  targetNamespaces,
  type Labels,
} from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const obj = (value: unknown) => copy(value) as KubeObject;
const prometheus = () => obj(fixtures.prometheus);
const at = (iso: string) => Date.parse(iso);

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
  detectRule(rule: unknown, obj: KubeObject): (Detected & { lookups?: unknown[] })[];
}
type KeyOf = (kind: { group: string; kind: string }) => string;
interface Across {
  rowOf(
    labelKeys: readonly string[],
    facts?: readonly unknown[],
    keepLabels?: boolean,
    valuePaths?: readonly string[],
    referrers?: readonly unknown[],
    rankPath?: string,
    judgedPaths?: readonly string[],
    defines?: unknown,
    selecting?: readonly unknown[],
  ): (obj: KubeObject) => unknown;
  judgeAcross(
    problems: readonly unknown[],
    context: unknown,
    rules: { rules: ReadonlyMap<string, unknown>; targets: readonly unknown[]; served?: (kind: { group: string; kind: string }) => boolean; api?: number },
  ): unknown[];
  factsOf(rules: readonly unknown[], keyOf: KeyOf): Map<string, unknown[]>;
  selectedKinds(rules: readonly unknown[], keyOf: KeyOf): Set<string>;
  selectingPaths(rules: readonly unknown[], keyOf: KeyOf): Map<string, unknown[]>;
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
  filter?: { value(obj: KubeObject, ctx: { now: number }): unknown };
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let across: Across;
let columns: Columns;
let formatList: (items: readonly string[]) => string;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  across = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemsAcross.ts"))) as Across;
  const i18n = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await i18n.startI18n("en");
  ({ formatList } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/format.ts"))) as { formatList: typeof formatList });
});

const c = manifest.contributes;
type Rule = (typeof c.problems)[number];
const RULES = c.problems as Rule[];
const rulesOf = (kind: string) => RULES.filter((r) => r.kind.kind === kind);

/**
 * When a problem starts to count, as Sextant's problems store reads both (`resolve`): `activeFrom`, else the grace after
 * `since`; with no readable `since`, the grace after it was first seen (`"firstSeen+grace"`).
 */
type Start = number | "firstSeen+grace";
const startOf = (d: { activeFrom?: number; graceMs?: number; since?: string }): Start =>
  d.activeFrom ?? (d.since && !Number.isNaN(at(d.since)) ? at(d.since) + (d.graceMs ?? 0) : "firstSeen+grace");
const live = (start: Start, until: number | undefined, now: number) => (start === "firstSeen+grace" || start <= now) && (until === undefined || until > now);
const readable = (since: string | undefined) => (since && !Number.isNaN(at(since)) ? since : undefined);

function windowFound(kind: string, o: KubeObject, now: number) {
  return rulesOf(kind)
    .flatMap((rule) => engine.detectRule(rule, o).map((d) => ({ d, rule })))
    .filter(({ d }) => live(startOf(d), d.until, now))
    .map(({ d, rule }) => ({ reason: d.reason, message: d.message ?? "", since: readable(d.since), start: startOf(d), notify: d.notify, category: (rule as { category?: string }).category }));
}

function builtInFound(kind: string, o: KubeObject, now: number) {
  return prometheusOperatorProblems({ group: MONITORING_GROUP, kind }, o)
    .filter((d) => live(startOf(d), undefined, now))
    .map((d) => ({ reason: d.reason, message: d.message ?? "", since: readable(d.since), start: startOf(d), notify: d.notify, category: "prometheus-operator" }));
}

// ---------- The rules judged across objects, on the cluster's lists ----------

const keyOf: KeyOf = (k) => `${k.group}/${k.kind}`.toLowerCase();
const DEF = (kind: string, group = "") => ({ kind: { group, version: "v1", kind } });

interface ClusterLists {
  proms: KubeObject[];
  agents?: KubeObject[];
  targets: KubeObject[];
  /** The namespaces the Services (Pods) are listed in; `null`: every one. */
  watched: string[] | null;
  /** The Namespaces' labels; `null`: they could not be listed. */
  namespaces?: Record<string, Labels> | null;
  /** How the Prometheuses' list stands, when not read in full of every namespace. */
  promsRows?: { truncated?: boolean; namespaces?: string[] };
}

/** What the manifest's monitor rules find of `m` on these lists, judged by Sextant's window engine. */
function windowJudged(m: KubeObject, lists: ClusterLists): [reason: string, message: string, notify: boolean][] {
  const rules = rulesOf(m.kind!);
  const facts = across.factsOf(rules, keyOf);
  const selected = across.selectedKinds(rules, keyOf);
  const selecting = across.selectingPaths(rules, keyOf);
  const rowsOf = (kind: { group: string; kind: string }, objects: KubeObject[], over: Record<string, unknown> = {}) => ({
    status: "ready",
    rows: new Map(
      objects.map((x) => [x.metadata.uid!, across.rowOf([], facts.get(keyOf(kind)) ?? [], selected.has(keyOf(kind)), [], [], undefined, [], undefined, selecting.get(keyOf(kind)) ?? [])(x)]),
    ),
    truncated: false,
    namespaces: null,
    ...over,
  });
  const targetKind = m.kind === "PodMonitor" ? "Pod" : "Service";
  const defs = { prom: DEF("Prometheus", MONITORING_GROUP), agent: DEF("PrometheusAgent", MONITORING_GROUP), target: DEF(targetKind), ns: DEF("Namespace") };
  const nsObjects = Object.entries(lists.namespaces ?? {}).map(([name, labels]) => obj({ apiVersion: "v1", kind: "Namespace", metadata: { name, uid: `ns-${name}`, labels } }));
  const rows = new Map<unknown, unknown>([
    [defs.prom, rowsOf({ group: MONITORING_GROUP, kind: "Prometheus" }, lists.proms, lists.promsRows)],
    [defs.agent, rowsOf({ group: MONITORING_GROUP, kind: "PrometheusAgent" }, lists.agents ?? [])],
    [defs.target, rowsOf({ group: "", kind: targetKind }, lists.targets, { namespaces: lists.watched })],
    [defs.ns, lists.namespaces === null ? { status: "error", rows: new Map(), truncated: false, namespaces: null } : rowsOf({ group: "", kind: "Namespace" }, nsObjects)],
  ]);
  const context = { rows: undefined, target: (def: unknown) => rows.get(def), problemUids: () => new Set<string>() };
  const detected = rules.flatMap((rule) =>
    engine.detectRule(rule, m).map((d) => ({ ...d, rule: rule.id, group: rule.id, uid: m.metadata.uid, object: { namespace: m.metadata.namespace } })),
  );
  const targets = [
    { group: MONITORING_GROUP, kind: "Prometheus", namespaced: true, def: defs.prom },
    { group: MONITORING_GROUP, kind: "PrometheusAgent", namespaced: true, def: defs.agent },
    { group: "", kind: targetKind, namespaced: true, def: defs.target },
    { group: "", kind: "Namespace", namespaced: false, def: defs.ns },
  ];
  const kept = across.judgeAcross(detected, context, { rules: new Map(rules.map((r) => [r.id, r])), targets, api: 5 }) as Detected[];
  return kept.map((d) => [d.reason, d.message ?? "", d.notify]);
}

// ---------- Variants of the fixtures ----------

type Cond = { type: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string };
const st = (o: KubeObject) => (o.status ??= {}) as Record<string, unknown>;
function withConditions(o: KubeObject, ...list: Cond[]): KubeObject {
  st(o).conditions = list;
  return o;
}
const T0 = "2026-10-10T08:00:00Z";
const available = (status: string, extra: Partial<Cond> = {}): Cond => ({ type: "Available", status, reason: `${status}Reason`, message: `available is ${status}`, lastTransitionTime: T0, ...extra });
const reconciled = (status: string, extra: Partial<Cond> = {}): Cond => ({ type: "Reconciled", status, reason: `Reconcile${status}`, message: `reconciled is ${status}`, lastTransitionTime: "2026-10-10T08:02:00Z", ...extra });

function serverVariants(kind: string): [string, KubeObject][] {
  const base = () => {
    const o = prometheus();
    o.kind = kind;
    return o;
  };
  const out: [string, KubeObject][] = [["the fixture (degraded)", base()]];
  const add = (label: string, ...list: Cond[]) => out.push([label, withConditions(base(), ...list)]);
  for (const a of ["True", "False", "Degraded", "Unknown", undefined])
    for (const r of ["True", "False", undefined]) {
      const list = [...(a ? [available(a)] : []), ...(r ? [reconciled(r)] : [])];
      add(`Available ${a ?? "-"} Reconciled ${r ?? "-"}`, ...list);
    }
  add("Available False without reason, message or time", { type: "Available", status: "False" });
  add("Degraded without a reason", available("Degraded", { reason: undefined }));
  add("Reconciled False without a reason", available("True"), reconciled("False", { reason: "" }));
  add("Available False with an unreadable time", available("False", { lastTransitionTime: "yesterday" }));
  const deleting = withConditions(base(), available("False"));
  deleting.metadata.deletionTimestamp = "2026-10-10T08:01:00Z";
  out.push(["deleting", deleting]);
  return out;
}

const TIMES = ["2026-10-10T08:00:30Z", "2026-10-10T08:04:59Z", "2026-10-10T08:05:00Z", "2026-10-10T08:06:59Z", "2026-10-10T08:07:00Z", "2030-01-01T00:00:00Z"].map(at);

describe("the problem rules, against the built-in category prometheusOperator", () => {
  it("find for Prometheuses and Alertmanagers what the built-in detector found, with its reason, message and start", () => {
    for (const kind of ["Prometheus", "Alertmanager"])
      for (const [label, o] of serverVariants(kind))
        for (const now of TIMES) expect(windowFound(kind, o, now), `${kind} ${label} at ${new Date(now).toISOString()}`).toEqual(builtInFound(kind, o, now));
  });

  it("count a degraded Prometheus 5 minutes after the condition changed, with the operator's reason", () => {
    const found = windowFound("Prometheus", prometheus(), at("2026-10-10T08:05:00Z"));
    expect(found).toEqual([
      {
        reason: "SomePodsNotReady",
        message: "shard 0: pod prometheus-prometheus-1: containers with incomplete status: [init-config-reloader]",
        since: "2026-10-10T08:00:00Z",
        start: at("2026-10-10T08:05:00Z"),
        notify: true,
        category: "prometheus-operator",
      },
    ]);
    expect(windowFound("Prometheus", prometheus(), at("2026-10-10T08:04:59Z"))).toEqual([]);
  });

  it("are one notification group, in the extension's own opt-in category, as the built-in category was", () => {
    expect(new Set(RULES.filter((r) => r.kind.kind.startsWith("Prom") || r.kind.kind === "Alertmanager").map((r) => r.group))).toEqual(new Set(["not-ready"]));
    expect(new Set(RULES.map((r) => r.category))).toEqual(new Set(["prometheus-operator"]));
    expect(c.problemCategories).toEqual([{ id: "prometheus-operator", title: "Prometheus Operator", optIn: true }]);
    expect(RULES.map((r) => r.id)).toEqual([
      ...["prometheus", "alertmanager"].flatMap((k) => ["not-available", "not-reconciled", "degraded"].map((s) => `${k}-${s}`)),
      "service-monitor-selects-nothing",
      "pod-monitor-selects-nothing",
      "service-monitor-not-picked-up",
      "pod-monitor-not-picked-up",
    ]);
  });

  it("find for ServiceMonitors and PodMonitors that select nothing what the built-in provider found", () => {
    const services = fixtures.services.map((x) => obj(x));
    const pod = obj({ apiVersion: "v1", kind: "Pod", metadata: { name: "example-app-1", namespace: "default", uid: "p1", labels: { app: "example-app" } } });
    const elsewhere = (o: KubeObject, names: string[]) => {
      (o.spec as Record<string, unknown>).namespaceSelector = { matchNames: names };
      return o;
    };
    const unknownOp = monitor();
    (unknownOp.spec as Record<string, unknown>).selector = { matchExpressions: [{ key: "app", operator: "Gt", values: ["1"] }] };
    const notIn = monitor();
    (notIn.spec as Record<string, unknown>).selector = { matchExpressions: [{ key: "app", operator: "NotIn", values: ["example-app", "other"] }] };
    const noSelectorIn = () => {
      const o = monitor();
      delete (o.spec as Record<string, unknown>).selector;
      return o;
    };
    const noSelector = noSelectorIn();
    const cases: [string, KubeObject, KubeObject[], string[] | null][] = [
      ["the example monitor", monitor(), services, ["default"]],
      ["the orphan", obj(fixtures.orphanMonitor), services, ["default"]],
      ["a monitor of an empty namespace", elsewhere(monitor(), ["empty"]), services, ["default", "empty"]],
      ["a monitor of two namespaces", elsewhere(monitor(), ["empty", "default", "empty"]), services, ["default", "empty"]],
      ["an unknown operator", unknownOp, services, ["default"]],
      ["NotIn of every app", notIn, services, ["default"]],
      ["no selector (every Service)", noSelector, services, ["default"]],
      ["no selector in an empty namespace", elsewhere(noSelectorIn(), ["empty"]), services, ["empty"]],
      ["a PodMonitor", obj(fixtures.podMonitor), [pod], ["default"]],
      ["a PodMonitor without pods", obj(fixtures.podMonitor), [], ["default"]],
    ];
    for (const [label, m, targets, watched] of cases) {
      const kind = m.kind!;
      const targetKind = kind === "PodMonitor" ? "Pod" : "Service";
      const def = { kind: targetKind };
      const rows = new Map(targets.map((x) => [x.metadata.uid!, across.rowOf([], [], true)(x)]));
      const context = {
        rows: undefined,
        target: () => ({ status: "ready", rows, truncated: false, namespaces: watched }),
        problemUids: () => new Set<string>(),
      };
      const rules = rulesOf(kind).filter((r) => r.id.endsWith("selects-nothing"));
      const detected = rules.flatMap((rule) => engine.detectRule(rule, m).map((d) => ({ ...d, uid: m.metadata.uid, object: { namespace: m.metadata.namespace } })));
      const kept = across.judgeAcross(detected, context, { rules: new Map(rules.map((r) => [r.id, r])), targets: [{ group: "", kind: targetKind, namespaced: true, def }] }) as Detected[];
      // The built-in provider, on the same lists.
      const byNs = new Map<string, Labels[]>((watched ?? []).map((ns) => [ns, targets.filter((x) => x.metadata.namespace === ns).map(labelsOf)]));
      const [finding] = judgeMonitors({ kind }, [m], [], byNs, () => undefined);
      expect(kept.map((d) => [d.reason, d.message, d.notify]), label).toEqual(
        finding!.selected === 0 ? [["SelectsNothing", `Selects no ${targetKind} in the namespaces: ${formatList(finding!.namespaces ?? [])}`, true]] : [],
      );
      // A list that does not watch every namespace it looks in cannot tell, as the built-in left it unjudged.
      const partial = { ...context, target: () => ({ status: "ready", rows, truncated: false, namespaces: ["other"] }) };
      expect(across.judgeAcross(detected, partial, { rules: new Map(rules.map((r) => [r.id, r])), targets: [{ group: "", kind: targetKind, namespaced: true, def }] }), label).toEqual([]);
    }
    // A monitor of every namespace is not judged unless its Prometheuses narrow it (below), as the built-in provider.
    const every = monitor();
    (every.spec as Record<string, unknown>).namespaceSelector = { any: true };
    expect(windowJudged(every, { proms: [], targets: fixtures.services.map((x) => obj(x)), watched: null })).toEqual([]);
  });

  it("find what the built-in provider found with Prometheuses: not picked up, and where their namespace selectors make a monitor look", () => {
    const services = fixtures.services.map((x) => obj(x));
    const pod = obj({ apiVersion: "v1", kind: "Pod", metadata: { name: "example-app-1", namespace: "default", uid: "p1", labels: { app: "example-app" } } });
    const appsService = obj({ apiVersion: "v1", kind: "Service", metadata: { name: "web", namespace: "apps", uid: "s-apps", labels: { app: "example-app" } } });
    let named = 0;
    const promWith = (spec: Record<string, unknown>, namespace = "default", kind = "Prometheus") => {
      const o = prometheus();
      o.kind = kind;
      o.metadata.namespace = namespace;
      o.metadata.uid = `${kind}-${namespace}-${JSON.stringify(spec)}`;
      o.metadata.name = `p${(named += 1)}`;
      Object.assign(o.spec as Record<string, unknown>, spec);
      return o;
    };
    const all = { serviceMonitorSelector: {}, podMonitorSelector: {}, serviceMonitorNamespaceSelector: {}, podMonitorNamespaceSelector: {} };
    const ignoring = { ...all, ignoreNamespaceSelectors: true };
    const promSets: [string, KubeObject[], KubeObject[]][] = [
      ["no Prometheus", [], []],
      ["the fixture (frontend, own namespace)", [prometheus()], []],
      ["one of every namespace", [promWith(all, "monitoring")], []],
      ["one that ignores namespace selectors", [promWith(ignoring, "monitoring")], []],
      ["one that ignores them and one that does not", [promWith(ignoring, "monitoring"), promWith(all, "monitoring")], []],
      ["null selectors", [promWith({ serviceMonitorSelector: null, podMonitorSelector: null }, "monitoring")], []],
      ["of another namespace with a null namespace selector", [promWith({ serviceMonitorSelector: {}, podMonitorSelector: {} }, "monitoring")], []],
      ["namespaces by labels", [promWith({ ...all, serviceMonitorNamespaceSelector: { matchLabels: { watch: "yes" } }, podMonitorNamespaceSelector: { matchLabels: { watch: "yes" } } }, "monitoring")], []],
      ["only a PrometheusAgent", [], [promWith(all, "monitoring", "PrometheusAgent")]],
      ["a PrometheusAgent that ignores namespace selectors", [prometheus()], [promWith(ignoring, "monitoring", "PrometheusAgent")]],
    ];
    const withSpec = (o: KubeObject, spec: Record<string, unknown>) => {
      Object.assign(o.spec as Record<string, unknown>, spec);
      return o;
    };
    const monitors: [string, KubeObject][] = [
      ["the example monitor", monitor()],
      ["the orphan", obj(fixtures.orphanMonitor)],
      ["a monitor of apps", withSpec(monitor(), { namespaceSelector: { matchNames: ["apps"] } })],
      ["a monitor of every namespace", withSpec(monitor(), { namespaceSelector: { any: true } })],
      ["a monitor selecting nothing of apps", withSpec(obj(fixtures.orphanMonitor), { namespaceSelector: { matchNames: ["apps"] } })],
      ["a PodMonitor", obj(fixtures.podMonitor)],
      ["a PodMonitor of apps", withSpec(obj(fixtures.podMonitor), { namespaceSelector: { matchNames: ["apps"] } })],
    ];
    const labelSets: [string, Record<string, Labels> | null][] = [
      ["labelled default", { default: { watch: "yes" }, apps: {} }],
      ["unlabelled", { default: {}, apps: {} }],
      ["Namespaces unreadable", null],
    ];
    let compared = 0;
    for (const [promLabel, proms, agents] of promSets)
      for (const [monitorLabel, m] of monitors)
        for (const [nsLabel, nsLabels] of labelSets) {
          const label = `${monitorLabel}, ${promLabel}, ${nsLabel}`;
          const targets = m.kind === "PodMonitor" ? [pod] : [...services, appsService];
          const watched = ["apps", "default"];
          const found = windowJudged(m, { proms, agents, targets, watched, namespaces: nsLabels });
          // The built-in provider on the same lists (its store's `toProblems`).
          const byNs = new Map<string, Labels[]>(watched.map((ns) => [ns, targets.filter((x) => x.metadata.namespace === ns).map(labelsOf)]));
          const [finding] = judgeMonitors({ kind: m.kind! }, [m], [...proms, ...agents], byNs, (name) => (nsLabels === null ? undefined : nsLabels[name]));
          const targetKind = m.kind === "PodMonitor" ? "Pod" : "Service";
          const expected: [string, string, boolean][] = [];
          if (finding!.selected === 0) expected.push(["SelectsNothing", `Selects no ${targetKind} in the namespaces: ${formatList(finding!.namespaces ?? [])}`, true]);
          if (finding!.pickedBy && finding!.pickedBy.length === 0) expected.push(["NotPickedUp", "No Prometheus picks it up by its selectors", false]);
          expect(found, label).toEqual(expected);
          compared += 1;
        }
    expect(compared).toBe(promSets.length * monitors.length * labelSets.length);
    // Cannot tell, never a problem: the Prometheuses not read in full or not of every namespace.
    const orphan = obj(fixtures.orphanMonitor);
    expect(windowJudged(orphan, { proms: [prometheus()], targets: services, watched: ["default"] }).map(([reason]) => reason)).toEqual(["SelectsNothing", "NotPickedUp"]);
    expect(windowJudged(orphan, { proms: [prometheus()], targets: services, watched: ["default"], promsRows: { truncated: true } }).map(([reason]) => reason)).toEqual(["SelectsNothing"]);
    expect(windowJudged(orphan, { proms: [prometheus()], targets: services, watched: ["default"], promsRows: { namespaces: ["default"] } }).map(([reason]) => reason)).toEqual(["SelectsNothing"]);
  });

  it("make the kinds' Only problems as the built-in filter, without a grace", () => {
    for (const kind of ["Prometheus", "Alertmanager"]) {
      const when = c.kinds.find((k) => k.kind === kind)!.problemWhen;
      for (const [label, o] of serverVariants(kind)) expect(engine.evaluate(when, o).holds, `${kind} ${label}`).toBe(isServerProblem(o));
    }
    // A monitor's "Only problems" comes from its rule that it selects nothing, judged across objects by Sextant's
    // problems store — not from "not picked up", as the built-in filter (`selectsNothing`).
    for (const kind of ["ServiceMonitor", "PodMonitor", "Probe", "PrometheusRule"]) expect(c.kinds.find((k) => k.kind === kind)).not.toHaveProperty("problemWhen");
    expect(c.kinds.map((k) => [k.kind, (k as { problemRules?: string[] }).problemRules])).toEqual([
      ["ServiceMonitor", ["service-monitor-selects-nothing"]],
      ["PodMonitor", ["pod-monitor-selects-nothing"]],
      ["Probe", undefined],
      ["PrometheusRule", undefined],
      ["Prometheus", undefined],
      ["Alertmanager", undefined],
    ]);
  });
});

// ---------- Columns ----------

const columnOf = (id: string) => c.columns.find((col) => col.id === id)!;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.prometheus-operator:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = at("2026-10-21T10:00:00Z");
const cell = (id: string, o: KubeObject) => windowColumn(id).searchText(o, { now: NOW, t: T }) ?? undefined;
const sortOf = (id: string, o: KubeObject) => windowColumn(id).value(o);
function drawn(id: string, o: KubeObject): { title?: string; tone?: string } {
  let node = windowColumn(id).render(o, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title, tone: node?.props?.tone };
}

const monitor = () => obj(fixtures.serviceMonitor);
function monitorVariants(): [string, KubeObject][] {
  const out: [string, KubeObject][] = [
    ["the fixture", monitor()],
    ["the orphan", obj(fixtures.orphanMonitor)],
    ["a PodMonitor", obj(fixtures.podMonitor)],
  ];
  const add = (label: string, spec: Record<string, unknown>) => {
    const o = monitor();
    Object.assign(o.spec as Record<string, unknown>, spec);
    out.push([label, o]);
  };
  add("every namespace", { namespaceSelector: { any: true } });
  add("names, repeated and unsorted", { namespaceSelector: { matchNames: ["b", "a", "b"] } });
  add("no names", { namespaceSelector: { matchNames: [] } });
  add("no selector", { selector: undefined });
  add("an empty selector", { selector: {} });
  add("two labels", { selector: { matchLabels: { app: "x", tier: "web" } } });
  for (const [op, values] of [
    ["In", ["a"]],
    ["In", ["a", "b"]],
    ["In", ["a", "b", "c"]],
    ["NotIn", ["a"]],
    ["NotIn", ["a", "b"]],
    ["Exists", []],
    ["DoesNotExist", []],
  ] as const) {
    add(`one expression ${op} ${values.length}`, { selector: { matchExpressions: [{ key: "k", operator: op, values }] } });
    add(`a label and an expression ${op} ${values.length}`, { selector: { matchLabels: { app: "x" }, matchExpressions: [{ key: "k", operator: op, values }] } });
  }
  add("an unknown operator", { selector: { matchLabels: { app: "x" }, matchExpressions: [{ key: "k", operator: "Gt", values: ["1"] }] } });
  add("ports by target and number", { endpoints: [{ targetPort: 8080 }, { targetPort: "metrics" }, { port: "web" }] });
  return out;
}

describe("the columns, against the built-in ones", () => {
  it("are placed after the namespace in the built-in order, with the built-in widths, the CRDs' own columns left out", () => {
    for (const kind of c.kinds) expect(kind.printerColumns).toBe(false);
    const order = (kind: string) => c.columns.filter((col) => col.kind.kind === kind).map((col) => [col.afterColumn, col.id, col.width]);
    expect(order("ServiceMonitor")).toEqual([
      ["namespace", "sm-namespaces", "minmax(120px, 1fr)"],
      ["sm-namespaces", "sm-selector", "minmax(160px, 2fr)"],
      ["sm-selector", "sm-ports", "minmax(100px, 1fr)"],
    ]);
    expect(order("Probe")).toEqual([
      ["namespace", "probe-prober", "minmax(160px, 2fr)"],
      ["probe-prober", "probe-module", "110px"],
      ["probe-module", "probe-interval", "80px"],
    ]);
    expect(order("PrometheusRule")).toEqual([
      ["namespace", "rule-groups", "80px"],
      ["rule-groups", "rule-rules", "80px"],
    ]);
    expect(order("Alertmanager")).toEqual([
      ["namespace", "am-status", "110px"],
      ["am-status", "am-replicas", "90px"],
      ["am-replicas", "am-version", "90px"],
      ["am-version", "am-reason", "minmax(120px, 1fr)"],
    ]);
  });

  it("Namespaces, Selector and Ports of a monitor: the built-in texts", () => {
    for (const [label, o] of monitorVariants()) {
      const prefix = o.kind === "PodMonitor" ? "pm" : "sm";
      const where = targetNamespaces(o);
      expect(cell(`${prefix}-namespaces`, o), label).toBe(where.type === "any" ? "Every namespace" : formatList(where.names));
      // Sorted and filtered by the built-in's value: "*", or the names joined with ",".
      expect(sortOf(`${prefix}-namespaces`, o), label).toBe(where.type === "any" ? "*" : where.names.join(","));
      const text = selectorText(monitorSelector(o));
      expect(cell(`${prefix}-selector`, o), label).toBe(text === "" ? "Everything" : (text ?? "Nothing"));
      // "Everything" sorts first, "Nothing" last (no sort value), as the built-in's "" and null.
      expect(sortOf(`${prefix}-selector`, o), label).toBe(text ?? undefined);
      const kind = o.kind === "PodMonitor" ? POD_MONITOR : SERVICE_MONITOR;
      const ports = endpointsOf(o, kind).map(portText).filter(Boolean);
      expect(cell(`${prefix}-ports`, o), label).toBe(ports.length === 0 ? undefined : formatList(ports));
    }
    expect(cell("sm-ports", monitor())).toBe("web, metrics");
    expect(cell("sm-selector", monitor())).toBe("app=example-app");
  });

  it("Selector writes every selector as the built-in did: labels, then expressions, values as written", () => {
    const o = monitor();
    (o.spec as Record<string, unknown>).selector = { matchLabels: { app: "x" }, matchExpressions: [{ key: "b", operator: "Exists" }, { key: "a", operator: "In", values: ["2", "1"] }] };
    expect(cell("sm-selector", o)).toBe("app=x,b,a in (2,1)");
    (o.spec as Record<string, unknown>).selector = { matchLabels: { tier: "web", app: "x" }, matchExpressions: [{ key: "zone", operator: "NotIn", values: ["b", "a"] }] };
    expect(cell("sm-selector", o)).toBe(selectorText(monitorSelector(o)));
  });

  it("Prober, Module and Interval of a Probe", () => {
    const probe = obj({ apiVersion: "monitoring.coreos.com/v1", kind: "Probe", metadata: { name: "p", namespace: "default" }, spec: { prober: { url: "blackbox:9115" }, module: "http_2xx", interval: "30s" } });
    expect(["probe-prober", "probe-module", "probe-interval"].map((id) => cell(id, probe))).toEqual(["blackbox:9115", "http_2xx", "30s"]);
  });

  it("Groups and Rules of a PrometheusRule: numbers, the rules over every group", () => {
    const rule = obj(fixtures.rule);
    const variants: [string, KubeObject][] = [["the fixture", rule]];
    const add = (label: string, groups: unknown) => {
      const o = obj(fixtures.rule);
      (o.spec as Record<string, unknown>).groups = groups;
      variants.push([label, o]);
    };
    add("no groups", undefined);
    add("an empty list", []);
    add("a group without rules", [{ name: "a" }]);
    add("two groups", [{ name: "a", rules: [{ alert: "A", expr: "1" }] }, { name: "b", rules: [{ record: "r", expr: "1" }, { alert: "B", expr: "1" }] }]);
    // Only rules with an `alert` or `record` name count, a rule with both twice, as the built-in counted them.
    add("rules without a name", [{ name: "a", rules: [{ expr: "1" }, { alert: "", expr: "1" }, { alert: "A", expr: "1" }] }, { name: "b", rules: [{ record: "", expr: "1" }] }]);
    add("a rule with both names", [{ name: "a", rules: [{ alert: "A", record: "r", expr: "1" }] }]);
    add("groups without named rules", [{ name: "a", rules: [{ expr: "1" }] }, { name: "b", rules: [] }]);
    for (const [label, o] of variants) {
      expect(cell("rule-groups", o), label).toBe(String(ruleGroupsOf(o).length));
      expect(sortOf("rule-groups", o), label).toBe(ruleGroupsOf(o).length);
      expect(cell("rule-rules", o), label).toBe(String(ruleCount(o)));
      expect(sortOf("rule-rules", o), label).toBe(ruleCount(o));
    }
  });

  it("Status, Replicas, Version and Reason of a Prometheus or Alertmanager: the built-in state, tone, hover and texts", () => {
    const TONES: Record<string, string> = { success: "success", warning: "warning", danger: "danger" };
    for (const kind of ["Prometheus", "Alertmanager"]) {
      const prefix = kind === "Prometheus" ? "prom" : "am";
      for (const [label, o] of serverVariants(kind)) {
        const r = serverReadiness(o);
        expect(cell(`${prefix}-status`, o), label).toBe({ ready: "Available", degraded: "Degraded", failed: "Failed", pending: "Pending" }[r.state]);
        expect(sortOf(`${prefix}-status`, o), label).toBe(r.state);
        expect(windowColumn(`${prefix}-status`).filter!.value(o, { now: NOW }), label).toBe(r.state);
        expect(drawn(`${prefix}-status`, o), label).toEqual({ title: [r.reason, r.message].filter(Boolean).join(": ") || undefined, tone: TONES[SERVER_TONE[r.state]] });
        expect(cell(`${prefix}-replicas`, o), label).toBe(`${r.available ?? 0}/${r.desired}`);
        expect(cell(`${prefix}-reason`, o) || undefined, label).toBe(r.reason || undefined);
        expect(sortOf(`${prefix}-reason`, o) || undefined, label).toBe(r.reason || undefined);
      }
    }
    const p = prometheus();
    expect(cell("prom-version", p)).toBeUndefined();
    (p.status as Record<string, unknown>).version = "v3.5.0";
    expect(cell("prom-version", p)).toBe("v3.5.0");
    (p.spec as Record<string, unknown>).version = "v3.6.0";
    expect(cell("prom-version", p)).toBe("v3.6.0");
  });

  it("Replicas: available of replicas times shards, as the built-in column", () => {
    for (const shards of [undefined, 0, 1, 2, 3, 4, 7])
      for (const replicas of [undefined, 0, 1, 2, 3, 5]) {
        const o = prometheus();
        const spec = o.spec as Record<string, unknown>;
        spec.shards = shards;
        spec.replicas = replicas;
        if (shards === undefined) delete spec.shards;
        if (replicas === undefined) delete spec.replicas;
        const r = serverReadiness(o);
        expect(cell("prom-replicas", o), `${shards} × ${replicas}`).toBe(`${r.available ?? 0}/${r.desired}`);
      }
    const big = prometheus();
    Object.assign(big.spec as Record<string, unknown>, { shards: 5, replicas: 4 });
    expect(cell("prom-replicas", big)).toBe("1/20");
  });
});

// ---------- The built-in provider (a reference for the API that is missing) ----------

describe("the monitors judged across objects (the built-in provider, kept as the reference)", () => {
  it("selects two Services for the example monitor, none for the orphan; a Prometheus picks up only frontend monitors", () => {
    const services = fixtures.services.map((s) => obj(s));
    const targets = new Map<string, Labels[]>([["default", services.map(labelsOf)]]);
    const found = judgeMonitors(SERVICE_MONITOR, [monitor(), obj(fixtures.orphanMonitor)], [prometheus()], targets, () => undefined);
    expect(found).toEqual([
      { uid: "sm-example-app", namespaces: ["default"], selected: 2, pickedBy: ["default/prometheus"] },
      { uid: "sm-orphan", namespaces: ["default"], selected: 0, pickedBy: [] },
    ]);
    // Without a list of the namespace, nothing is judged; with every namespace, neither.
    expect(judgeMonitors(SERVICE_MONITOR, [monitor()], [], undefined, () => undefined)[0]).toEqual({ uid: "sm-example-app", namespaces: ["default"], selected: undefined, pickedBy: undefined });
    const any = monitor();
    (any.spec as Record<string, unknown>).namespaceSelector = { any: true };
    expect(judgeMonitors(SERVICE_MONITOR, [any], [], targets, () => undefined)[0]!.selected).toBeUndefined();
  });

  it("reads a Prometheus's selectors: null selects nothing, a null namespace selector its own namespace, terms need labels", () => {
    const p = prometheus();
    const other = monitor();
    other.metadata.namespace = "apps";
    expect(pickedUpBy([p], SERVICE_MONITOR, other, () => undefined).by).toEqual([]);
    (p.spec as Record<string, unknown>).serviceMonitorNamespaceSelector = { matchLabels: { team: "x" } };
    expect(pickedUpBy([p], SERVICE_MONITOR, other, () => undefined)).toEqual({ by: [], unknown: true });
    expect(pickedUpBy([p], SERVICE_MONITOR, other, () => ({ team: "x" })).by).toHaveLength(1);
    expect(pickedUpBy([p], { kind: "Probe" }, other, () => ({ team: "x" })).by).toEqual([]);
    const ignoring = prometheus();
    (ignoring.spec as Record<string, unknown>).ignoreNamespaceSelectors = true;
    const listed = monitor();
    (listed.spec as Record<string, unknown>).namespaceSelector = { matchNames: ["apps"] };
    expect(targetNamespaces(listed, [ignoring])).toEqual({ type: "list", names: ["default"] });
    expect(targetNamespaces(listed, [ignoring, prometheus()])).toEqual({ type: "list", names: ["apps", "default"] });
  });
});

// ---------- The manifest ----------

describe("the manifest", () => {
  it("lists the six kinds in the section prometheusOperator after Sealed Secrets, with its icon, counter and an untitled details section of order 20", () => {
    expect(c.sections).toEqual([{ section: "prometheusOperator", title: "Prometheus Operator", icon: "prometheusOperator", after: "sealedSecrets" }]);
    expect(c.kinds.map((k) => [k.kind, k.title, k.icon, k.order])).toEqual([
      ["ServiceMonitor", "Service Monitors", "serviceMonitor", 10],
      ["PodMonitor", "Pod Monitors", "podMonitor", 11],
      ["Probe", "Probes", "probe", 12],
      ["PrometheusRule", "Prometheus Rules", "prometheusRule", 20],
      ["Prometheus", "Prometheuses", "prometheus", 30],
      ["Alertmanager", "Alertmanagers", "alertmanager", 31],
    ]);
    // The counter counts what the built-in counted: not the monitors no Prometheus picks up (a warning, not notified).
    expect(c.sectionBadges).toEqual([
      {
        section: "prometheusOperator",
        label: { one: "{{count}} object needs attention", other: "{{count}} objects need attention" },
        rules: RULES.filter((r) => r.notify).map((r) => r.id),
      },
    ]);
    expect(c.detailsSections).toEqual([
      { id: "prometheus-operator", title: "Prometheus Operator", kinds: c.kinds.map((k) => ({ group: k.group, kind: k.kind })), placement: "section", order: 20, heading: false },
    ]);
  });

  it("asks only to read the kinds it shows, PrometheusAgents, and the Services, Pods and Namespaces it looks at", () => {
    expect(manifest.permissions.rules).toEqual([
      {
        namespaces: { type: "all" },
        kinds: {
          type: "only",
          kinds: [...c.kinds.map((k) => ({ group: k.group, kind: k.kind })), { group: "monitoring.coreos.com", kind: "PrometheusAgent" }, ...["Service", "Pod", "Namespace"].map((kind) => ({ group: "", kind }))],
        },
        actions: ["read"],
      },
    ]);
    expect(manifest).not.toHaveProperty("contributes.actions");
    expect([PROMETHEUS.kind, ALERTMANAGER.kind]).toEqual(["Prometheus", "Alertmanager"]);
  });
});
