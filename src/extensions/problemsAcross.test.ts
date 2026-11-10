// Rules across objects (ADR-0144): what stands once the rows say what the rules look up — and that whatever cannot be
// told is no problem.
import { describe, expect, it } from "vitest";
import type { KubeObject, ProblemCondition, ProblemContribution } from "../api";
import type { Problem } from "../features/problems/model";
import type { JudgeContext, JudgedRows, SourceDef } from "../features/problems/sources";
import { factsOf, judgeAcross, rowOf, type AcrossTarget } from "./problemsAcross";
import { detectRule } from "./problemRules";

const QUEUE = { group: "kueue.x-k8s.io", kind: "ClusterQueue" };
const QUEUE_DEF: SourceDef = {
  category: "ext:demo",
  kind: { ...QUEUE, version: "v1beta1" },
  fieldSelector: null,
  discovered: true,
};
const SECRETLESS_DEF: SourceDef = { ...QUEUE_DEF, kind: { group: "demo.example.com", version: "v1", kind: "Store" } };

const rule = (over: Partial<ProblemContribution>): ProblemContribution => ({
  id: "r",
  title: "R",
  kind: { group: "kueue.x-k8s.io", kind: "LocalQueue" },
  when: { type: "exists", path: ".metadata.name" },
  graceMinutes: 0,
  notify: true,
  message: "m",
  toldThroughOwner: false,
  ...over,
});

const MISSING = rule({
  id: "queue-missing",
  when: {
    type: "all",
    of: [
      { type: "exists", path: ".spec.clusterQueue" },
      { type: "missing", path: ".spec.clusterQueue", kind: QUEUE },
    ],
  },
});
const OWNED = rule({ id: "owned", toldThroughOwner: true });
const NEWEST = rule({ id: "newest", kind: { group: "build.openshift.io", kind: "Build" }, newestPer: "openshift.io/build-config.name" });
const RULES = new Map([MISSING, OWNED, NEWEST].map((r) => [r.id, r]));

interface Obj extends KubeObject {
  metadata: { name: string; namespace?: string; uid: string } & Record<string, unknown>;
}

function obj(name: string, over: Record<string, unknown> & { metadata?: Record<string, unknown> } = {}): Obj {
  return { apiVersion: "v1", kind: "X", ...over, metadata: { name, namespace: "team-a", uid: `u-${name}`, ...over.metadata } } as Obj;
}

/** The problem `detectRule` finds in `o` by `r`, as the store keeps it. */
function problemOf(r: ProblemContribution, o: Obj): Problem {
  const [found] = detectRule(r, o);
  expect(found).toBeDefined();
  return {
    ...found!,
    key: `${o.metadata.uid}|${found!.reason}`,
    notifyKey: `${o.metadata.uid}|${r.id}`,
    category: "ext:demo",
    uid: o.metadata.uid,
    object: { kind: { group: "", version: "v1", kind: "X" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name },
    firstSeen: 0,
    activeAt: 0,
  };
}

const rows = (objects: Obj[], over: Partial<JudgedRows> = {}): JudgedRows => ({
  status: "ready",
  rows: new Map(objects.map((o) => [o.metadata.uid, rowOf(["openshift.io/build-config.name"])(o)])),
  truncated: false,
  namespaces: null,
  ...over,
});

function context(over: { own?: JudgedRows; queues?: JudgedRows; problemUids?: string[] } = {}): JudgeContext {
  return {
    rows: over.own,
    target: (def) => (def === QUEUE_DEF ? over.queues : undefined),
    problemUids: () => new Set(over.problemUids ?? []),
  };
}

const TARGETS: AcrossTarget[] = [
  { ...QUEUE, namespaced: false, def: QUEUE_DEF },
  { group: "demo.example.com", kind: "Store", namespaced: true, def: SECRETLESS_DEF },
];
const judge = (problems: Problem[], ctx: JudgeContext) => judgeAcross(problems, ctx, { rules: RULES, targets: TARGETS });

describe("missing of a list (#404)", () => {
  const SERVICE = { group: "", kind: "Service" };
  const SERVICE_DEF: SourceDef = { ...QUEUE_DEF, kind: { group: "", version: "v1", kind: "Service" } };
  const ROUTES = rule({
    id: "route-service-missing",
    kind: { group: "traefik.io", kind: "IngressRoute" },
    when: {
      type: "missing",
      path: ".spec.routes[*].services[*]",
      kind: SERVICE,
      namePath: ".name",
      namespacePath: ".namespace",
      itemWhen: { type: "not", of: { type: "contains", path: ".name", values: ["@"], ignoreCase: false } },
    },
    message: "Missing: {{missing}}",
  });
  const rules = new Map([[ROUTES.id, ROUTES]]);
  const targets: AcrossTarget[] = [{ ...SERVICE, namespaced: true, def: SERVICE_DEF }];
  const svc = (name: string, ns: string) => obj(name, { metadata: { name, namespace: ns, uid: `s-${ns}-${name}` } });
  const services = (objects: Obj[], over: Partial<JudgedRows> = {}): JudgedRows => ({
    status: "ready",
    rows: new Map(objects.map((o) => [o.metadata.uid, rowOf([])(o)])),
    truncated: false,
    namespaces: null,
    ...over,
  });
  const route = obj("r", { spec: { routes: [{ services: [{ name: "web" }, { name: "api", namespace: "team-b" }] }, { services: [{ name: "x@file" }] }] } });
  const judged = (rows: JudgedRows) =>
    judgeAcross([problemOf(ROUTES, route)], { rows: undefined, target: (def) => (def === SERVICE_DEF ? rows : undefined), problemUids: () => new Set() }, { rules, targets });

  it("stands when any item names an object that is not there, and names it", () => {
    expect(judged(services([svc("web", "team-a"), svc("api", "team-b")]))).toEqual([]);
    const [p] = judged(services([svc("web", "team-a")]));
    expect(p?.message).toBe("Missing: team-b/api");
    expect(judged(services([]))[0]?.message).toBe("Missing: web, team-b/api");
  });

  it("cannot tell while the list is not read in full", () => {
    expect(judged(services([], { truncated: true }))).toEqual([]);
  });
});

describe("toldThroughReferrer (#404)", () => {
  const PROXY = { group: "projectcontour.io", kind: "HTTPProxy" };
  const invalid: ProblemCondition = { type: "equals", path: ".status.currentStatus", value: "invalid" };
  const ORPHAN = rule({
    id: "orphaned",
    kind: PROXY,
    when: { type: "equals", path: ".status.currentStatus", value: "orphaned" },
    toldThroughReferrer: { path: ".spec.includes", namePath: ".name", namespacePath: ".namespace", when: invalid },
  });
  const rules = new Map([[ORPHAN.id, ORPHAN]]);
  const facts = factsOf([ORPHAN], (k) => `${k.group}/${k.kind}`.toLowerCase()).get("projectcontour.io/httpproxy") ?? [];
  const proxy = (name: string, status: string, includes: { name: string; namespace?: string }[] = []) =>
    obj(name, { metadata: { name, namespace: "team-a", uid: `p-${name}` }, spec: { includes }, status: { currentStatus: status } });
  const own = (objects: Obj[], over: Partial<JudgedRows> = {}): JudgedRows => ({
    status: "ready",
    rows: new Map(objects.map((o) => [o.metadata.uid, rowOf([], facts, false, [], [ORPHAN.toldThroughReferrer!])(o)])),
    truncated: false,
    namespaces: null,
    ...over,
  });
  const judged = (orphan: Obj, rows: JudgedRows) =>
    judgeAcross([problemOf(ORPHAN, orphan)], { rows, target: () => undefined, problemUids: () => new Set() }, { rules, targets: [] });

  it("is told by an invalid proxy above it, directly or through others", () => {
    const leaf = proxy("leaf", "orphaned");
    expect(judged(leaf, own([proxy("root", "invalid", [{ name: "leaf" }]), leaf]))).toEqual([]);
    const mid = proxy("mid", "orphaned", [{ name: "leaf" }]);
    expect(judged(leaf, own([proxy("root", "invalid", [{ name: "mid" }]), mid, leaf]))).toEqual([]);
    expect(judged(leaf, own([proxy("root", "valid", [{ name: "leaf" }]), leaf]))).toHaveLength(1);
    expect(judged(leaf, own([proxy("other", "invalid", [{ name: "leaf", namespace: "team-b" }]), leaf]))).toHaveLength(1);
    expect(judged(leaf, own([leaf]))).toHaveLength(1);
  });

  it("reads one object as a list of one in its other paths (#404)", () => {
    const tcp = rule({ ...ORPHAN, id: "orphaned-tcp", toldThroughReferrer: { ...ORPHAN.toldThroughReferrer!, alsoPaths: [".spec.tcpproxy.include"] } });
    const leaf = proxy("leaf", "orphaned");
    const root = obj("root", { metadata: { name: "root", namespace: "team-a", uid: "p-root" }, spec: { tcpproxy: { include: { name: "leaf" } } }, status: { currentStatus: "invalid" } });
    const tcpFacts = factsOf([tcp], (k) => `${k.group}/${k.kind}`.toLowerCase()).get("projectcontour.io/httpproxy") ?? [];
    const rows: JudgedRows = { status: "ready", rows: new Map([root, leaf].map((o) => [o.metadata.uid, rowOf([], tcpFacts, false, [], [tcp.toldThroughReferrer!])(o)])), truncated: false, namespaces: null };
    expect(judgeAcross([problemOf(tcp, leaf)], { rows, target: () => undefined, problemUids: () => new Set() }, { rules: new Map([[tcp.id, tcp]]), targets: [] })).toEqual([]);
  });

  it("cannot tell while its own rows are not read in full", () => {
    const leaf = proxy("leaf", "orphaned");
    expect(judged(leaf, own([leaf], { truncated: true }))).toEqual([]);
  });
});

describe("relatedBy (#404)", () => {
  const HPA = { group: "autoscaling", kind: "HorizontalPodAutoscaler" };
  const HPA_DEF: SourceDef = { ...QUEUE_DEF, kind: { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" } };
  const scalesCpu: ProblemCondition = { type: "exists", path: ".spec.metrics[resource.name=\"cpu\"]" };
  const CONFLICT = rule({
    id: "hpa-conflict",
    kind: { group: "autoscaling.k8s.io", kind: "VerticalPodAutoscaler" },
    when: {
      type: "relatedBy",
      kind: HPA,
      pairs: [
        { theirs: ".spec.scaleTargetRef.name", ours: ".spec.targetRef.name" },
        { theirs: ".spec.scaleTargetRef.kind", ours: ".spec.targetRef.kind" },
      ],
      when: scalesCpu,
    },
  });
  const rules = new Map([[CONFLICT.id, CONFLICT]]);
  const targets: AcrossTarget[] = [{ ...HPA, namespaced: true, def: HPA_DEF }];
  const facts = factsOf([CONFLICT], (k) => `${k.group}/${k.kind}`.toLowerCase()).get("autoscaling/horizontalpodautoscaler") ?? [];
  const hpaRows = (objects: Obj[], over: Partial<JudgedRows> = {}): JudgedRows => ({
    status: "ready",
    rows: new Map(objects.map((o) => [o.metadata.uid, rowOf([], facts, false, [".spec.scaleTargetRef.name", ".spec.scaleTargetRef.kind"])(o)])),
    truncated: false,
    namespaces: null,
    ...over,
  });
  const hpa = (name: string, ns: string, target: string, metric: string) =>
    obj(name, { metadata: { name, namespace: ns, uid: `h-${ns}-${name}` }, spec: { scaleTargetRef: { kind: "Deployment", name: target }, metrics: [{ resource: { name: metric } }] } });
  const vpa = obj("v", { spec: { targetRef: { kind: "Deployment", name: "web" } } });
  const judged = (rows: JudgedRows) =>
    judgeAcross([problemOf(CONFLICT, vpa)], { rows: undefined, target: (def) => (def === HPA_DEF ? rows : undefined), problemUids: () => new Set() }, { rules, targets });

  it("stands where an object of the namespace holds the same texts and its own condition", () => {
    expect(judged(hpaRows([hpa("web", "team-a", "web", "cpu")]))).toHaveLength(1);
    expect(judged(hpaRows([hpa("any-name", "team-a", "web", "cpu")]))).toHaveLength(1);
    expect(judged(hpaRows([hpa("web", "team-a", "web", "memory")]))).toEqual([]);
    expect(judged(hpaRows([hpa("web", "team-b", "web", "cpu")]))).toEqual([]);
    expect(judged(hpaRows([hpa("api", "team-a", "api", "cpu")]))).toEqual([]);
  });

  it("cannot tell while the list is not read in full or not watched there", () => {
    expect(judged(hpaRows([hpa("web", "team-a", "web", "cpu")], { truncated: true }))).toEqual([]);
    expect(judged(hpaRows([hpa("web", "team-a", "web", "cpu")], { namespaces: ["team-b"] }))).toEqual([]);
  });
});

describe("selectsNone (#404)", () => {
  const SERVICE = { group: "", kind: "Service" };
  const SERVICE_DEF: SourceDef = { ...QUEUE_DEF, kind: { group: "", version: "v1", kind: "Service" } };
  const SELECTS = rule({
    id: "selects-nothing",
    kind: { group: "monitoring.coreos.com", kind: "ServiceMonitor" },
    when: { type: "selectsNone", kind: SERVICE, selector: ".spec.selector", anyNamespacesPath: ".spec.namespaceSelector.any", namespacesPath: ".spec.namespaceSelector.matchNames" },
  });
  const targets: AcrossTarget[] = [{ ...SERVICE, namespaced: true, def: SERVICE_DEF }];
  const svc = (name: string, ns: string, labels: Record<string, string>) => obj(name, { metadata: { name, namespace: ns, uid: `s-${ns}-${name}`, labels } });
  const rowsOf = (objects: Obj[], over: Partial<JudgedRows> = {}): JudgedRows => ({
    status: "ready",
    rows: new Map(objects.map((o) => [o.metadata.uid, rowOf([], [], true)(o)])),
    truncated: false,
    namespaces: null,
    ...over,
  });
  const judged = (monitor: Obj, services: JudgedRows) =>
    judgeAcross([problemOf(SELECTS, monitor)], { rows: undefined, target: (def) => (def === SERVICE_DEF ? services : undefined), problemUids: () => new Set() }, { rules: new Map([[SELECTS.id, SELECTS]]), targets });
  const monitor = (spec: Record<string, unknown>) => obj("m", { spec });

  it("stands where no Service in the namespaces it covers has the labels", () => {
    const web = monitor({ selector: { matchLabels: { app: "web" } } });
    expect(judged(web, rowsOf([svc("web", "team-a", { app: "web" })]))).toEqual([]);
    expect(judged(web, rowsOf([svc("web", "team-b", { app: "web" }), svc("api", "team-a", { app: "api" })]))).toHaveLength(1);
    const anywhere = monitor({ selector: { matchLabels: { app: "web" } }, namespaceSelector: { any: true } });
    expect(judged(anywhere, rowsOf([svc("web", "team-b", { app: "web" })]))).toEqual([]);
    const named = monitor({ selector: { matchExpressions: [{ key: "tier", operator: "In", values: ["front"] }] }, namespaceSelector: { matchNames: ["team-b"] } });
    expect(judged(named, rowsOf([svc("x", "team-b", { tier: "front" })]))).toEqual([]);
    expect(judged(named, rowsOf([svc("x", "team-a", { tier: "front" })]))).toHaveLength(1);
  });

  it("cannot tell while the Services are not read in full or not watched there", () => {
    const web = monitor({ selector: { matchLabels: { app: "web" } } });
    expect(judged(web, rowsOf([], { truncated: true }))).toEqual([]);
    expect(judged(web, rowsOf([], { namespaces: ["team-b"] }))).toEqual([]);
    expect(judged(monitor({ selector: {}, namespaceSelector: { any: true } }), rowsOf([], { namespaces: ["team-a"] }))).toEqual([]);
    expect(judged(web, rowsOf([], { namespaces: ["team-a"] }))).toHaveLength(1);
  });
});

describe("missing", () => {
  const local = obj("lq", { spec: { clusterQueue: "gpu" } });
  const problem = problemOf(MISSING, local);

  it("stands only when the read list has no such name", () => {
    expect(problem.lookups).toEqual([{ ...QUEUE, name: "gpu" }]);
    expect(judge([problem], context({ queues: rows([obj("cpu", { metadata: { name: "cpu", namespace: undefined, uid: "q1" } })]) }))).toEqual([problem]);
    expect(judge([problem], context({ queues: rows([obj("gpu", { metadata: { name: "gpu", namespace: undefined, uid: "q2" } })]) }))).toEqual([]);
  });

  it("is judged by the rule that found it, whatever group it notifies in (#409)", () => {
    const grouped = { ...MISSING, group: "no-such-rule" };
    const rules = new Map([[grouped.id, grouped]]);
    const p = problemOf(grouped, local);
    expect(p.group).toBe("no-such-rule");
    const ctx = context({ queues: rows([obj("gpu", { metadata: { name: "gpu", namespace: undefined, uid: "q2" } })]) });
    expect(judgeAcross([p], ctx, { rules, targets: TARGETS })).toEqual([]);
  });

  it("is no problem while the list cannot tell: loading, failed, capped, not watched", () => {
    for (const queues of [
      undefined,
      rows([], { status: "loading" }),
      rows([], { status: "error" }),
      rows([], { truncated: true }),
    ]) {
      expect(judge([problem], context({ queues }))).toEqual([]);
    }
  });

  it("looks a namespaced kind up in the object's namespace, and only where its source watches", () => {
    const store = rule({ id: "store-missing", when: { type: "missing", path: ".spec.store", kind: { group: "demo.example.com", kind: "Store" } } });
    const judgeStore = (p: Problem, stores: JudgedRows) =>
      judgeAcross([p], { rows: undefined, target: (def) => (def === SECRETLESS_DEF ? stores : undefined), problemUids: () => new Set() }, {
        rules: new Map([[store.id, store]]),
        targets: TARGETS,
      });
    const p = problemOf(store, obj("app", { spec: { store: "main" } }));
    const other = { ...obj("main"), metadata: { name: "main", namespace: "team-b", uid: "s1" } };
    expect(judgeStore(p, rows([other]))).toEqual([p]);
    expect(judgeStore(p, rows([obj("main", { metadata: { name: "main", namespace: "team-a", uid: "s2" } })]))).toEqual([]);
    // The source does not read team-a: it cannot tell.
    expect(judgeStore(p, rows([], { namespaces: ["team-b"] }))).toEqual([]);
    expect(judgeStore(p, rows([], { namespaces: ["team-a"] }))).toEqual([p]);
  });

  it("names nothing when the path holds no text, so nothing is missing", () => {
    expect(detectRule(MISSING, obj("lq", { spec: { clusterQueue: "" } }))).toEqual([]);
    expect(detectRule(rule({ when: { type: "missing", path: ".spec.q", kind: QUEUE } }), obj("lq", { spec: { q: 3 } }))).toEqual([]);
  });
});

describe("toldThroughOwner", () => {
  const owned = obj("pod", { metadata: { name: "pod", namespace: "team-a", uid: "u-pod", ownerReferences: [{ uid: "u-rs", controller: true }] } as never });

  it("is told by the controller while it has a problem of the extension", () => {
    const problem = problemOf(OWNED, owned);
    expect(problem.ownerUid).toBe("u-rs");
    expect(judge([problem], context({ problemUids: ["u-rs"] }))).toEqual([]);
    expect(judge([problem], context({ problemUids: ["u-other"] }))).toEqual([problem]);
  });

  it("stands for an object without a controller", () => {
    const loose = obj("pod", { metadata: { name: "pod", namespace: "team-a", uid: "u-pod", ownerReferences: [{ uid: "u-rs" }] } as never });
    expect(problemOf(OWNED, loose).ownerUid).toBeUndefined();
  });
});

describe("newestBy (#404)", () => {
  const BY = rule({ id: "by", kind: { group: "build.openshift.io", kind: "Build" }, newestPer: "openshift.io/build-config.name", newestBy: '.metadata.annotations["openshift.io/build.number"]' });
  const build = (name: string, created: string, number: string) =>
    obj(name, { metadata: { name, namespace: "team-a", uid: `u-${name}`, creationTimestamp: created, labels: { "openshift.io/build-config.name": "app" }, annotations: { "openshift.io/build.number": number } } });
  // Created later but with a smaller number: the number ranks newest.
  const nine = build("app-9", "2026-11-03T10:00:00Z", "9");
  const ten = build("app-10", "2026-11-02T10:00:00Z", "10");
  const rows: JudgedRows = {
    status: "ready",
    rows: new Map([nine, ten].map((o) => [o.metadata.uid, rowOf(["openshift.io/build-config.name"], [], false, [], [], BY.newestBy)(o)])),
    truncated: false,
    namespaces: null,
  };
  it("ranks newest by the number", () => {
    const judged = judgeAcross([problemOf(BY, nine), problemOf(BY, ten)], { rows, target: () => undefined, problemUids: () => new Set() }, { rules: new Map([[BY.id, BY]]), targets: [] });
    expect(judged.map((p) => p.uid)).toEqual(["u-app-10"]);
  });
});

describe("newestPer", () => {
  const build = (name: string, created: string, config?: string) =>
    obj(name, {
      metadata: {
        name,
        namespace: "team-a",
        uid: `u-${name}`,
        creationTimestamp: created,
        ...(config ? { labels: { "openshift.io/build-config.name": config } } : {}),
      },
    });
  const old = build("app-1", "2026-11-01T10:00:00Z", "app");
  const latest = build("app-2", "2026-11-02T10:00:00Z", "app");
  const alone = build("one-off", "2026-10-01T10:00:00Z");

  it("leaves the problem only on the newest object with the same label value; one without it is judged alone", () => {
    const own = rows([old, latest, alone]);
    const problems = [old, latest, alone].map((b) => problemOf(NEWEST, b));
    expect(judge(problems, context({ own })).map((p) => p.object.name)).toEqual(["app-2", "one-off"]);
  });

  it("tells nothing until its own rows are read", () => {
    expect(judge([problemOf(NEWEST, latest)], context({ own: rows([], { status: "loading" }) }))).toEqual([]);
  });
});
