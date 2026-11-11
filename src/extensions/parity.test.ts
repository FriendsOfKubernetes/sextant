// Extension API 5 (ADR-0169) in the window: lists three deep, a load balancer's middlewares in its namespace, a target
// in either of two groups, the routes Traefik skips numbered, `{{missing}}` naming a plain lookup, and what a table's
// `problem` case reads of the rules. Whatever cannot be told is no problem, and is told apart as "cannot tell".
import { describe, expect, it } from "vitest";
import type { KubeObject, ProblemCondition, ProblemContribution } from "../api";
import type { Problem } from "../features/problems/model";
import type { JudgeContext, JudgedRows, SourceDef } from "../features/problems/sources";
import type { SourceState } from "../features/problems/store";
import { judgeAcross, rowOf, type AcrossTarget } from "./problemsAcross";
import { detectRule, evaluate, heldItems, positionsOf, renderMessage, type Lookup } from "./problemRules";
import { rowProblemState } from "./rowProblems";

const IR = { group: "traefik.io", kind: "IngressRoute" };
const MW = { group: "traefik.io", kind: "Middleware" };
const LEGACY_MW = { group: "traefik.containo.us", kind: "Middleware" };
const OPTION = { group: "traefik.io", kind: "TLSOption" };

const def = (kind: { group: string; kind: string }): SourceDef => ({ category: "ext:t:t", kind: { ...kind, version: "v1alpha1" }, fieldSelector: null, discovered: true });
const MW_DEF = def(MW);
const LEGACY_DEF = def(LEGACY_MW);
const OPTION_DEF = def(OPTION);

const notProvider: ProblemCondition = { type: "not", of: { type: "contains", path: ".name", values: ["@"], ignoreCase: false } };
const ROUTE_SERVICE_MIDDLEWARES: ProblemCondition = {
  type: "missing",
  path: ".spec.routes[*].services[*].middlewares[*]",
  kind: MW,
  alsoKinds: [LEGACY_MW],
  namePath: ".name",
  namespacePath: ".namespace",
  itemWhen: notProvider,
  enclosingNamespacePath: ".namespace",
  enclosingNamespaceWhen: notProvider,
};

const rule = (when: ProblemCondition, message = "Middleware {{missing}}", id = "r"): ProblemContribution => ({
  id,
  title: id,
  kind: IR,
  when,
  graceMinutes: 0,
  notify: true,
  message,
  toldThroughOwner: false,
});

const route = (spec: unknown, name = "web"): KubeObject => ({ apiVersion: "traefik.io/v1alpha1", kind: "IngressRoute", metadata: { name, namespace: "shop", uid: `u-${name}` }, spec });

function problemOf(r: ProblemContribution, o: KubeObject): Problem {
  const [found] = detectRule(r, o);
  expect(found).toBeDefined();
  return {
    ...found!,
    key: `${o.metadata!.uid}|x`,
    notifyKey: `${o.metadata!.uid}|x`,
    category: "ext:t:t",
    uid: o.metadata!.uid!,
    object: { kind: { ...IR, version: "v1alpha1" }, namespace: o.metadata!.namespace ?? null, name: o.metadata!.name! },
    firstSeen: 0,
    activeAt: 0,
  };
}

const named = (namespace: string, name: string): KubeObject => ({ metadata: { name, namespace, uid: `${namespace}-${name}` } });
const rows = (objects: KubeObject[], over: Partial<JudgedRows> = {}): JudgedRows => ({
  status: "ready",
  rows: new Map(objects.map((o) => [o.metadata!.uid!, rowOf([])(o)])),
  truncated: false,
  namespaces: null,
  ...over,
});

function context(lists: Map<SourceDef, JudgedRows | undefined>): JudgeContext {
  return { rows: undefined, target: (d) => lists.get(d), problemUids: () => new Set() };
}

const TARGETS: AcrossTarget[] = [
  { ...MW, namespaced: true, def: MW_DEF },
  { ...LEGACY_MW, namespaced: true, def: LEGACY_DEF },
  { ...OPTION, namespaced: true, def: OPTION_DEF },
];

describe("lists three deep and the namespace of the object holding a list (ADR-0169)", () => {
  const spec = {
    routes: [
      {
        services: [
          { name: "api", namespace: "backend", middlewares: [{ name: "auth" }, { name: "strip", namespace: "edge" }, { name: "x@file" }] },
          { name: "web@file", namespace: "other", middlewares: [{ name: "gzip" }] },
        ],
      },
      { services: [{ name: "plain", middlewares: [{ name: "retry" }] }] },
    ],
  };

  it("reads each item with its holder, and a path that does not end in a field's items reads nothing", () => {
    expect(heldItems(route(spec), ".spec.routes[*].services[*].middlewares[*]").map(({ item, holder }) => [(item as { name: string }).name, (holder as { name: string }).name])).toEqual([
      ["auth", "api"],
      ["strip", "api"],
      ["x@file", "api"],
      ["gzip", "web@file"],
      ["retry", "plain"],
    ]);
    expect(heldItems({ spec: { mirroring: { name: "m", namespace: "n", middlewares: [{ name: "a" }] } } }, ".spec.mirroring.middlewares[*]")).toEqual([
      { item: { name: "a" }, holder: { name: "m", namespace: "n", middlewares: [{ name: "a" }] } },
    ]);
    expect(heldItems(route(spec), ".spec.routes[*]")).toEqual([
      { item: spec.routes[0], holder: spec },
      { item: spec.routes[1], holder: spec },
    ]);
    expect(heldItems(route(spec), ".spec.routes[0][*]")).toEqual([]);
  });

  it("looks a middleware up in its own namespace, else its load balancer's, else the route's — a provider's load balancer naming none", () => {
    const verdict = evaluate(ROUTE_SERVICE_MIDDLEWARES, route(spec));
    expect(verdict.holds).toBe(true);
    expect(verdict.lookups!.map((l) => [l.name, l.namespace ?? "(own)", l.also])).toEqual([
      ["auth", "backend", [LEGACY_MW]],
      ["strip", "edge", [LEGACY_MW]],
      ["gzip", "(own)", [LEGACY_MW]],
      ["retry", "(own)", [LEGACY_MW]],
    ]);
  });

  it("gates an item's own namespace by `namespaceWhen`", () => {
    const transport: ProblemCondition = {
      type: "missing",
      path: ".spec.routes[*].services[*]",
      kind: { group: "traefik.io", kind: "ServersTransport" },
      namePath: ".serversTransport",
      namespacePath: ".namespace",
      namespaceWhen: notProvider,
    };
    const o = route({ routes: [{ services: [{ name: "a", namespace: "x", serversTransport: "t" }, { name: "b@file", namespace: "y", serversTransport: "u" }] }] });
    expect(evaluate(transport, o).lookups!.map((l) => [l.name, l.namespace])).toEqual([
      ["t", "x"],
      ["u", undefined],
    ]);
  });
});

describe("a target in more kinds (alsoKinds, ADR-0169)", () => {
  const r = rule(ROUTE_SERVICE_MIDDLEWARES);
  const o = route({ routes: [{ services: [{ name: "api", middlewares: [{ name: "auth" }] }] }] });
  const served = (kinds: { group: string; kind: string }[]) => (k: { group: string; kind: string }) => kinds.some((s) => s.group === k.group && s.kind === k.kind);

  it("stands only when no served kind has it, a kind not served having no objects", () => {
    const both = served([MW, LEGACY_MW]);
    const p = problemOf(r, o);
    const judge = (lists: Map<SourceDef, JudgedRows | undefined>, isServed = both, untold?: Set<string>) =>
      judgeAcross([p], context(lists), { rules: new Map([[r.id, r]]), targets: TARGETS, served: isServed }, untold);
    // Only in the old group: found, as the built-in view said ("legacy only", not broken).
    expect(judge(new Map([[MW_DEF, rows([])], [LEGACY_DEF, rows([named("shop", "auth")])]]))).toEqual([]);
    expect(judge(new Map([[MW_DEF, rows([])], [LEGACY_DEF, rows([])]]))).toHaveLength(1);
    // The old group not served: nothing there.
    expect(judge(new Map([[MW_DEF, rows([])]]), served([MW]))).toHaveLength(1);
    // Neither served: nothing anywhere, as the built-in view called it.
    expect(judge(new Map(), served([]))).toHaveLength(1);
    // Served but not read: cannot tell, and said so.
    const untold = new Set<string>();
    expect(judge(new Map([[MW_DEF, rows([])], [LEGACY_DEF, rows([], { status: "loading" })]]), both, untold)).toEqual([]);
    expect([...untold]).toEqual(["u-web"]);
    const untold2 = new Set<string>();
    expect(judge(new Map([[MW_DEF, rows([])]]), both, untold2)).toEqual([]);
    expect([...untold2]).toEqual(["u-web"]);
  });
});

describe("`{{missing}}` names a plain lookup from sextantApi 5 (ADR-0169)", () => {
  const r = rule({ type: "missing", path: ".spec.tls.options.name", kind: OPTION, namespacePath: ".spec.tls.options.namespace" }, "TLSOption {{missing}} is gone.");
  const o = route({ tls: { options: { name: "strict", namespace: "edge" } } });
  const run = (api: number) =>
    judgeAcross([problemOf(r, o)], context(new Map([[OPTION_DEF, rows([])]])), { rules: new Map([[r.id, r]]), targets: TARGETS, api })[0]?.message;
  it("with its namespace when not the object's own", () => {
    expect(run(5)).toBe("TLSOption edge/strict is gone.");
    // An API-4 manifest keeps what 0.30.0 showed.
    expect(run(4)).toBe("TLSOption  is gone.");
  });
});

describe("`|positions` and trimmed matches (ADR-0169)", () => {
  const o = route({ routes: [{ match: "Host(`a`)" }, { match: "  " }, { match: "Host(`b`)", kind: "Other" }, {}, { match: "Host(`c`)", kind: "Rule" }] });
  it("numbers the routes Traefik skips: a blank match or a kind other than Rule, each once, in order", () => {
    expect(positionsOf(o, '.spec.routes[match~="",*]')).toEqual([2, 4]);
    expect(positionsOf(o, '.spec.routes[kind~!="",kind!="Rule",*]')).toEqual([3]);
    expect(positionsOf(o, ".spec.routes[*].match")).toBeUndefined();
    expect(positionsOf(o, '.spec.nothing[match~="",*]')).toBeUndefined();
    expect(renderMessage('Traefik skips its routes {{.spec.routes[match~="",*] + .spec.routes[kind~!="",kind!="Rule",*]|positions}}.', o)).toBe(
      "Traefik skips its routes 2, 3, 4.",
    );
    expect(renderMessage('{{.spec.routes[match="zzz",*]|positions}}', o)).toBe("");
  });
});

describe("what a table's `problem` case reads (ADR-0169)", () => {
  const o = route({}, "web");
  const source = (over: Partial<SourceState>): SourceState => ({
    key: "k",
    clusterId: "c",
    category: "ext:t:t",
    def: def(IR),
    status: "ready",
    problems: [],
    truncated: false,
    ...over,
  });
  const problem = (over: Partial<Problem> = {}): Problem => ({
    ...problemOf(rule({ type: "exists", path: ".metadata.name" }), o),
    ...over,
  });

  it("a problem first, in its grace too; then still reading; then cannot tell", () => {
    expect(rowProblemState([source({ problems: [problem({ activeAt: Date.now() + 60_000 })] })], IR, o, Date.now(), true)).toBe("found");
    expect(rowProblemState([source({ problems: [problem({ until: 1 })] })], IR, o, Date.now(), true)).toBeUndefined();
    expect(rowProblemState([source({ status: "loading" })], IR, o, Date.now(), true)).toBe("checking");
    expect(rowProblemState([source({})], IR, o, Date.now(), false)).toBe("checking");
    expect(rowProblemState([source({ untold: new Set(["u-web"]) })], IR, o, Date.now(), true)).toBe("unknown");
    expect(rowProblemState([source({ truncated: true })], IR, o, Date.now(), true)).toBe("unknown");
    expect(rowProblemState([source({ def: { ...def(IR), namespaces: ["other"] } })], IR, o, Date.now(), true)).toBe("unknown");
    expect(rowProblemState([], IR, o, Date.now(), true)).toBe("unknown");
    expect(rowProblemState([source({})], IR, o, Date.now(), true)).toBeUndefined();
  });

  it("is a condition only a table's context answers", () => {
    const found: ProblemCondition = { type: "problem" };
    const unknown: ProblemCondition = { type: "problem", state: "unknown" };
    expect(evaluate(found, o).holds).toBe(false);
    expect(evaluate(found, o, { problemState: () => "found" }).holds).toBe(true);
    expect(evaluate(unknown, o, { problemState: () => "found" }).holds).toBe(false);
    expect(evaluate({ type: "not", of: unknown }, o, { problemState: () => "unknown" }).holds).toBe(false);
  });

  it("keeps a plain missing's lookup of more kinds for agents too", () => {
    const lookups = evaluate({ type: "missing", path: ".spec.tls.options.name", kind: OPTION, alsoKinds: [{ group: "traefik.containo.us", kind: "TLSOption" }] }, route({ tls: { options: { name: "x" } } })).lookups as Lookup[];
    expect(lookups[0]!.also).toEqual([{ group: "traefik.containo.us", kind: "TLSOption" }]);
  });
});
