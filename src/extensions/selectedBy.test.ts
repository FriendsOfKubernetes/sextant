// Who selects an object (ADR-0169): `selectedByNone` (a ServiceMonitor no Prometheus picks up) and
// `selectsNone.selectedBy` (where a monitor looks when its Prometheuses ignore namespace selectors), read as Prometheus
// Operator reads its selectors — and whatever the rows cannot tell is no problem (ADR-0144).
import { describe, expect, it } from "vitest";
import type { KubeObject, ProblemContribution } from "../api";
import type { Problem } from "../features/problems/model";
import type { JudgedRows, SourceDef } from "../features/problems/sources";
import { judgeAcross, lookedUp, rowOf, selectingPaths, type AcrossTarget } from "./problemsAcross";
import { detectRule, placeholderText } from "./problemRules";
import { lookupRefs } from "../features/mcp-diagnostics/problems";

const MONITORING = "monitoring.coreos.com";
const PROMETHEUS = { group: MONITORING, kind: "Prometheus" };
const AGENT = { group: MONITORING, kind: "PrometheusAgent" };
const SERVICE = { group: "", kind: "Service" };
const NAMESPACE = { group: "", kind: "Namespace" };
const def = (kind: { group: string; kind: string }): SourceDef => ({ category: "ext:demo", kind: { ...kind, version: "v1" }, fieldSelector: null, discovered: true });
const DEFS = { prom: def(PROMETHEUS), agent: def(AGENT), svc: def(SERVICE), ns: def(NAMESPACE) };

const rule = (over: Partial<ProblemContribution>): ProblemContribution => ({
  id: "r",
  title: "R",
  kind: { group: MONITORING, kind: "ServiceMonitor" },
  when: { type: "exists", path: ".metadata.name" },
  graceMinutes: 0,
  notify: true,
  message: "m",
  toldThroughOwner: false,
  ...over,
});

const NOT_PICKED_UP = rule({
  id: "not-picked-up",
  when: { type: "selectedByNone", kind: PROMETHEUS, alsoKinds: [AGENT], selector: ".spec.serviceMonitorSelector", namespaceSelector: ".spec.serviceMonitorNamespaceSelector" },
});
const IGNORES = { type: "equals", path: ".spec.ignoreNamespaceSelectors", value: true } as const;
const SELECTS_NOTHING = rule({
  id: "selects-nothing",
  when: {
    type: "selectsNone",
    kind: SERVICE,
    selector: ".spec.selector",
    anyNamespacesPath: ".spec.namespaceSelector.any",
    namespacesPath: ".spec.namespaceSelector.matchNames",
    namedOnly: true,
    selectedBy: { kind: PROMETHEUS, alsoKinds: [AGENT], selector: ".spec.serviceMonitorSelector", namespaceSelector: ".spec.serviceMonitorNamespaceSelector", ownNamespaceWhen: IGNORES },
  },
  message: "Selects no Service in the namespaces: {{selectsNone:namespaces}}",
});
const RULES = [NOT_PICKED_UP, SELECTS_NOTHING];
const keyOf = (k: { group: string; kind: string }) => `${k.group}/${k.kind}`.toLowerCase();
const SELECTING = selectingPaths(RULES, keyOf);

type Obj = KubeObject & { metadata: { name: string; namespace?: string; uid: string } & Record<string, unknown> };
const object = (name: string, namespace: string | undefined, over: Record<string, unknown> = {}, labels: Record<string, string> = {}): Obj =>
  ({ apiVersion: "v1", kind: "X", ...over, metadata: { name, ...(namespace ? { namespace } : {}), uid: `${namespace ?? ""}-${name}`, labels } }) as Obj;

const prom = (name: string, namespace: string, spec: Record<string, unknown>) => object(name, namespace, { spec });
const svc = (name: string, namespace: string, labels: Record<string, string>) => object(name, namespace, {}, labels);
const ns = (name: string, labels: Record<string, string> = {}) => object(name, undefined, {}, labels);

const rowsOf = (kind: { group: string; kind: string }, objects: Obj[], over: Partial<JudgedRows> = {}): JudgedRows => ({
  status: "ready",
  rows: new Map(
    objects.map((o) => [
      o.metadata.uid,
      rowOf([], kind === PROMETHEUS || kind === AGENT ? [IGNORES] : [], kind === SERVICE || kind === NAMESPACE, [], [], undefined, [], undefined, SELECTING.get(keyOf(kind)) ?? [])(o),
    ]),
  ),
  truncated: false,
  namespaces: null,
  ...over,
});

const TARGETS: AcrossTarget[] = [
  { ...PROMETHEUS, namespaced: true, def: DEFS.prom },
  { ...AGENT, namespaced: true, def: DEFS.agent },
  { ...SERVICE, namespaced: true, def: DEFS.svc },
  { ...NAMESPACE, namespaced: false, def: DEFS.ns },
];

function problemOf(r: ProblemContribution, o: Obj): Problem | undefined {
  const [found] = detectRule(r, o);
  if (!found) return undefined;
  return {
    ...found,
    key: `${o.metadata.uid}|${found.reason}`,
    notifyKey: `${o.metadata.uid}|${r.id}`,
    category: "ext:demo",
    uid: o.metadata.uid,
    object: { kind: { ...r.kind, version: "v1" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name },
    firstSeen: 0,
    activeAt: 0,
  };
}

interface Cluster {
  proms?: Obj[] | JudgedRows;
  agents?: Obj[] | JudgedRows | null;
  services?: Obj[] | JudgedRows;
  namespaces?: Obj[] | JudgedRows;
}

function judge(r: ProblemContribution, monitor: Obj, cluster: Cluster, untold?: Set<string>): Problem[] {
  const p = problemOf(r, monitor);
  if (!p) return [];
  const as = (kind: { group: string; kind: string }, v: Obj[] | JudgedRows | undefined) => (Array.isArray(v) ? rowsOf(kind, v) : v);
  const rows = new Map<SourceDef, JudgedRows | undefined>([
    [DEFS.prom, as(PROMETHEUS, cluster.proms ?? [])],
    [DEFS.agent, cluster.agents === null ? undefined : as(AGENT, cluster.agents ?? [])],
    [DEFS.svc, as(SERVICE, cluster.services ?? [])],
    [DEFS.ns, as(NAMESPACE, cluster.namespaces ?? [])],
  ]);
  // PrometheusAgent not served (`agents: null`): no objects of it.
  const served = (kind: { group: string; kind: string }) => !(cluster.agents === null && keyOf(kind) === keyOf(AGENT));
  return judgeAcross(
    [p],
    { rows: undefined, target: (d) => rows.get(d), problemUids: () => new Set() },
    { rules: new Map(RULES.map((x) => [x.id, x])), targets: TARGETS, served, api: 5 },
    untold,
  );
}

const monitor = (spec: Record<string, unknown>, labels: Record<string, string> = { team: "a" }, namespace = "apps") => object("m", namespace, { spec }, labels);

describe("selectedByNone (ADR-0169)", () => {
  const m = monitor({ selector: {} });

  it("stands when no Prometheus or PrometheusAgent selects the object's labels and namespace", () => {
    expect(judge(NOT_PICKED_UP, m, { proms: [prom("p", "monitoring", { serviceMonitorSelector: { matchLabels: { team: "b" } }, serviceMonitorNamespaceSelector: {} })] })).toHaveLength(1);
    expect(judge(NOT_PICKED_UP, m, { proms: [prom("p", "monitoring", { serviceMonitorSelector: { matchLabels: { team: "a" } }, serviceMonitorNamespaceSelector: {} })] })).toEqual([]);
    expect(judge(NOT_PICKED_UP, m, { agents: [prom("a", "monitoring", { serviceMonitorSelector: {}, serviceMonitorNamespaceSelector: {} })] })).toEqual([]);
  });

  it("reads a null selector as nothing and an empty one as everything", () => {
    expect(judge(NOT_PICKED_UP, m, { proms: [prom("p", "monitoring", { serviceMonitorNamespaceSelector: {} })] })).toHaveLength(1);
    expect(judge(NOT_PICKED_UP, m, { proms: [prom("p", "monitoring", { serviceMonitorSelector: null, serviceMonitorNamespaceSelector: {} })] })).toHaveLength(1);
    expect(judge(NOT_PICKED_UP, m, { proms: [prom("p", "monitoring", { serviceMonitorSelector: {}, serviceMonitorNamespaceSelector: {} })] })).toEqual([]);
  });

  it("reads a null namespace selector as the Prometheus' own namespace, an empty one as every namespace", () => {
    const own = prom("p", "apps", { serviceMonitorSelector: {} });
    const elsewhere = prom("p", "monitoring", { serviceMonitorSelector: {} });
    expect(judge(NOT_PICKED_UP, m, { proms: [own] })).toEqual([]);
    expect(judge(NOT_PICKED_UP, m, { proms: [elsewhere] })).toHaveLength(1);
    expect(judge(NOT_PICKED_UP, m, { proms: [prom("p", "monitoring", { serviceMonitorSelector: {}, serviceMonitorNamespaceSelector: {} })] })).toEqual([]);
  });

  it("matches a namespace selector against the Namespace's labels", () => {
    const byLabel = prom("p", "monitoring", { serviceMonitorSelector: {}, serviceMonitorNamespaceSelector: { matchLabels: { monitored: "yes" } } });
    expect(judge(NOT_PICKED_UP, m, { proms: [byLabel], namespaces: [ns("apps", { monitored: "yes" })] })).toEqual([]);
    expect(judge(NOT_PICKED_UP, m, { proms: [byLabel], namespaces: [ns("apps", { monitored: "no" })] })).toHaveLength(1);
  });

  it("does not hold with no Prometheus at all: the monitor may be for another collector", () => {
    expect(judge(NOT_PICKED_UP, m, {})).toEqual([]);
    expect(judge(NOT_PICKED_UP, m, { agents: null })).toEqual([]);
  });

  it("cannot tell while a list is not read in full or the Namespaces' labels are needed and unknown", () => {
    const other = [prom("p", "monitoring", { serviceMonitorSelector: { matchLabels: { team: "b" } }, serviceMonitorNamespaceSelector: {} })];
    for (const cluster of [
      { proms: rowsOf(PROMETHEUS, other, { truncated: true }) },
      { proms: rowsOf(PROMETHEUS, other, { status: "loading" }) },
      { proms: rowsOf(PROMETHEUS, other, { namespaces: ["monitoring"] }) },
      { proms: other, agents: rowsOf(AGENT, [], { status: "error" }) },
      { proms: [prom("p", "monitoring", { serviceMonitorSelector: {}, serviceMonitorNamespaceSelector: { matchLabels: { x: "y" } } })], namespaces: rowsOf(NAMESPACE, [], { status: "error" }) },
    ]) {
      const untold = new Set<string>();
      expect(judge(NOT_PICKED_UP, m, cluster, untold)).toEqual([]);
      expect(untold.has(m.metadata.uid)).toBe(true);
    }
    // One that picks it up is enough, whatever else cannot tell.
    const picks = prom("q", "monitoring", { serviceMonitorSelector: {}, serviceMonitorNamespaceSelector: {} });
    expect(judge(NOT_PICKED_UP, m, { proms: [picks], agents: rowsOf(AGENT, [], { status: "error" }) })).toEqual([]);
  });

  it("looks up the selecting kinds and the Namespaces, which an agent must read everywhere", () => {
    expect(lookedUp(NOT_PICKED_UP.when)).toEqual([PROMETHEUS, AGENT, NAMESPACE]);
    const p = problemOf(NOT_PICKED_UP, m)!;
    expect(lookupRefs(p, null)).toEqual([
      { ...PROMETHEUS, namespace: null },
      { ...AGENT, namespace: null },
      { ...NAMESPACE, namespace: null },
    ]);
  });
});

describe("selectsNone with selectedBy (ADR-0169)", () => {
  const web = (namespaceSelector?: Record<string, unknown>) => monitor({ selector: { matchLabels: { app: "web" } }, ...(namespaceSelector ? { namespaceSelector } : {}) });
  const picking = (ignore: boolean, name = "p") => prom(name, "monitoring", { serviceMonitorSelector: {}, serviceMonitorNamespaceSelector: {}, ...(ignore ? { ignoreNamespaceSelectors: true } : {}) });

  it("looks where it names, unless every Prometheus that picks it up ignores namespace selectors: then in its own", () => {
    const named = web({ matchNames: ["team-b"] });
    const services = [svc("web", "team-b", { app: "web" })];
    expect(judge(SELECTS_NOTHING, named, { proms: [picking(false)], services })).toEqual([]);
    const [p] = judge(SELECTS_NOTHING, named, { proms: [picking(true)], services });
    expect(p?.message).toBe("Selects no Service in the namespaces: apps");
    expect(judge(SELECTS_NOTHING, named, { proms: [picking(true)], services: [svc("web", "apps", { app: "web" })] })).toEqual([]);
  });

  it("looks in its own namespace too when some of them ignore namespace selectors", () => {
    const named = web({ matchNames: ["team-b", "team-a"] });
    const [p] = judge(SELECTS_NOTHING, named, { proms: [picking(true), picking(false, "q")], services: [] });
    expect(p?.message).toBe("Selects no Service in the namespaces: apps, team-a, team-b");
    expect(judge(SELECTS_NOTHING, named, { proms: [picking(true), picking(false, "q")], services: [svc("web", "apps", { app: "web" })] })).toEqual([]);
  });

  it("keeps what it names while the Prometheuses cannot tell or none picks it up", () => {
    const named = web({ matchNames: ["team-b"] });
    const [p] = judge(SELECTS_NOTHING, named, { proms: rowsOf(PROMETHEUS, [picking(true)], { truncated: true }), services: [] });
    expect(p?.message).toBe("Selects no Service in the namespaces: team-b");
    const [q] = judge(SELECTS_NOTHING, named, { services: [] });
    expect(q?.message).toBe("Selects no Service in the namespaces: team-b");
  });

  it("judges a monitor of every namespace only where every Prometheus that picks it up makes it look in its own (`namedOnly`)", () => {
    const anywhere = web({ any: true });
    expect(judge(SELECTS_NOTHING, anywhere, { proms: [picking(false)], services: [] })).toEqual([]);
    expect(judge(SELECTS_NOTHING, anywhere, { proms: [picking(true), picking(false, "q")], services: [] })).toEqual([]);
    const [p] = judge(SELECTS_NOTHING, anywhere, { proms: [picking(true)], services: [svc("web", "team-b", { app: "web" })] });
    expect(p?.message).toBe("Selects no Service in the namespaces: apps");
  });

  it("without selectedBy, `namedOnly` leaves a monitor of every namespace unjudged", () => {
    const plain = rule({ id: "plain", when: { type: "selectsNone", kind: SERVICE, selector: ".spec.selector", anyNamespacesPath: ".spec.namespaceSelector.any", namedOnly: true } });
    expect(detectRule(plain, web({ any: true }))).toEqual([]);
    expect(detectRule(plain, web())).toHaveLength(1);
  });

  it("looks up the Prometheuses and the Namespaces besides the Services", () => {
    expect(lookedUp(SELECTS_NOTHING.when)).toEqual([SERVICE, PROMETHEUS, AGENT, NAMESPACE]);
  });
});

describe("|uniqueKey (ADR-0169)", () => {
  it("keys a list's texts as the built-in table did: each once, sorted by code point, joined with `,`", () => {
    const o = { spec: { names: ["b", "a", "", "b", "a-b"] }, metadata: { namespace: "own" } };
    expect(placeholderText(o, ".spec.names|uniqueKey")).toBe("a,a-b,b");
    expect(placeholderText(o, ".spec.none ?? .metadata.namespace|uniqueKey")).toBe("own");
    expect(placeholderText({ spec: { names: [] }, metadata: { namespace: "own" } }, ".spec.names ?? .metadata.namespace|uniqueKey")).toBe("own");
  });
});
