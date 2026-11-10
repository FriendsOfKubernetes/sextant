// The model and the manifest's declarative parts. The manifest's problem rules, the HTTPProxy kind's "Only problems"
// and the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx,
// loaded at run time so the type check stays inside the extension) and compared with the model they replace — the
// reading of Sextant's former built-in view (#233, ADR-0107), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import delegationJson from "../fixtures/delegation.json";
import extensionJson from "../fixtures/extension.json";
import proxiesJson from "../fixtures/proxies.json";
import en from "./locales/en.json";
import {
  contourProblems,
  CONTOUR_GRACE_MS,
  delegationFor,
  delegationsOf,
  delegationTree,
  EXTENSION_SERVICE,
  explain,
  extensionFields,
  firstError,
  fqdnOf,
  HEALTH_TONE,
  healthOf,
  HTTP_PROXY,
  includesOf,
  indexRows,
  isProblem,
  joinPrefixes,
  PROXY_HEALTH,
  proxyRow,
  proxyState,
  rootsReaching,
  routesOf,
  sameKind,
  servedInPart,
  shares,
  TLS_DELEGATION,
  tlsOf,
  tlsText,
  toldThroughInvalid,
  validCondition,
  type KindOf,
  type ProxyRow,
} from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const proxies = proxiesJson as unknown as KubeObject[];
const [root, blog, orphan, duplicate, fresh] = proxies as [KubeObject, KubeObject, KubeObject, KubeObject, KubeObject];
const delegation = delegationJson as unknown as KubeObject;
const extension = extensionJson as unknown as KubeObject;
const sp = (o: KubeObject) => o.spec as Record<string, unknown>;

describe("the model", () => {
  it("reads Contour's states, including the CRD's default NotReconciled", () => {
    expect(proxies.map(proxyState)).toEqual(["invalid", "valid", "orphaned", "invalid", "pending"]);
    // An include that is not found leaves the rest served; a duplicate host drops the virtual host.
    expect(servedInPart(root)).toBe(true);
    expect(servedInPart(duplicate)).toBe(false);
    expect(explain(duplicate)).toMatchObject({ key: "duplicateVhost", params: { fqdn: "root.bar.com" } });
    expect(explain(fresh)).toEqual({ key: "pendingClass", params: { class: "contour-internal" } });
    expect(explain(orphan)).toEqual({ key: "orphaned" });
  });

  it("splits requests by weight as Contour does, a mirror's weight being its percent", () => {
    const [weighted, plain] = routesOf(blog);
    expect(shares(weighted!.services)).toEqual([90, 10, 20]);
    expect(shares(plain!.services)).toEqual([50, 50]);
    // Some weights set: a service without one gets nothing; a mirror without a weight copies everything.
    expect(shares([{ name: "a", weight: 3, mirror: false }, { name: "b", mirror: false }, { name: "m", mirror: true }])).toEqual([100, 0, 100]);
    expect(plain!.conditions).toEqual(["prefix=/admin", "header x-env exact=staging"]);
  });

  it("reads a delegated Secret and the delegation that allows it", () => {
    const tls = tlsOf(root)!;
    expect(tls.secret).toEqual({ namespace: "www-admin", name: "example-com-wildcard", delegated: true });
    expect(delegationFor([delegation], tls.secret!, "roots")).toBe(delegation);
    expect(delegationFor([delegation], tls.secret!, "other")).toBeUndefined();
    expect(delegationFor([delegation], { namespace: "www-admin", name: "shared-ca", delegated: true }, "any")).toBe(delegation);
  });

  it("builds the delegation tree, prefixes concatenated, a missing include marked", () => {
    expect(includesOf(root).map((i) => `${i.namespace}/${i.name} ${i.prefix}`)).toEqual(["marketing/blogsite /blog", "marketing/missing-site /missing"]);
    // As Contour's mergePathMatchConditions: concatenated, slashes collapsed, a trailing slash kept.
    expect(joinPrefixes(["/api", "/v1/"])).toBe("/api/v1/");
    expect(joinPrefixes(["/blog", "/"])).toBe("/blog/");
    expect(joinPrefixes(["/", "/blog"])).toBe("/blog");
    expect(joinPrefixes(["/a/", "/b"])).toBe("/a/b");
    expect(joinPrefixes(["///", "/"])).toBe("/");
    expect(joinPrefixes([undefined, "/"])).toBe("/");
    expect(joinPrefixes([])).toBe("/");
    const index = indexRows(proxies.map(proxyRow));
    expect(rootsReaching(index, "marketing/blogsite")).toEqual(["roots/root-blog"]);
    expect(rootsReaching(index, "marketing/old-blog")).toEqual([]);
    const { node } = delegationTree(index, "roots/root-blog");
    expect(node.children.map((c) => [c.key, c.prefix, Boolean(c.row)])).toEqual([
      ["marketing/blogsite", "/blog", true],
      ["marketing/missing-site", "/missing", false],
    ]);
    // Focused on an included proxy: only the branches that lead to it.
    expect(delegationTree(index, "roots/root-blog", "marketing/blogsite").node.children.map((c) => c.key)).toEqual(["marketing/blogsite"]);
  });

  it("marks an include cycle", () => {
    const a = proxyRow(blog);
    const index = indexRows([{ ...a, includes: [{ key: "marketing/blogsite", conditions: [], tcp: false }] }]);
    const { node } = delegationTree(index, "marketing/blogsite");
    expect(node.children[0]).toMatchObject({ cycle: true, children: [] });
  });

  it("tells an orphan under an invalid proxy through that proxy (the built-in judgement across proxies)", () => {
    const row = (name: string, state: ProxyRow["state"], includes: string[] = [], isRoot = false): ProxyRow => ({
      namespace: "ns",
      name,
      root: isRoot,
      state,
      includes: includes.map((i) => ({ key: `ns/${i}`, conditions: [], tcp: false })),
    });
    const rows = [row("root", "invalid", ["a"], true), row("a", "orphaned", ["b"]), row("b", "orphaned"), row("loose", "orphaned")];
    const problem = (name: string, reason: string) => ({ reason, namespace: "ns", name });
    const kept = toldThroughInvalid([problem("root", "TLSError"), problem("a", "Orphaned"), problem("b", "Orphaned"), problem("loose", "Orphaned")], rows);
    expect(kept.map((p) => p.name)).toEqual(["root", "loose"]);
  });
});

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  notify: boolean;
  ownerUid?: string;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  width?: string;
  filter?: { type: string; value(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): unknown };
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Across {
  factsOf(rules: readonly unknown[], keyOf: (kind: { group: string; kind: string }) => string): Map<string, unknown[]>;
  rowOf(newestLabels: readonly string[], facts: readonly unknown[], keepLabels: boolean, valuePaths: readonly string[], referrers: readonly unknown[]): (obj: KubeObject) => unknown;
  judgeAcross(problems: readonly unknown[], context: unknown, options: { rules: Map<string, unknown>; targets: unknown[] }): { object: { namespace: string; name: string } }[];
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
let across: Across;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  across = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemsAcross.ts"))) as Across;
});

const c = manifest.contributes;
const rulesOf = (kind: KindOf) => c.problems.filter((r) => sameKind(r.kind, kind));
/** The problems the manifest's rules find in `obj`, as the window finds them object by object. */
const windowProblems = (kind: KindOf, obj: KubeObject): Detected[] => rulesOf(kind).flatMap((rule) => engine.detectRule(rule, obj));

function expectSameProblems(kind: KindOf, obj: KubeObject): void {
  const expected = contourProblems(kind, obj).map((d) => ({ reason: d.reason, message: d.message ?? "", since: d.since, graceMs: d.graceMs, notify: d.notify }));
  const found = windowProblems(kind, obj).map((d) => ({ reason: d.reason, message: d.message, since: d.since, graceMs: d.graceMs, notify: d.notify ?? true }));
  expect(found, `${kind.kind} ${obj.metadata.name}`).toEqual(expected);
}

const withStatus = (o: KubeObject, status: Record<string, unknown> | undefined): KubeObject => {
  const next = copy(o);
  if (status === undefined) delete (next as { status?: unknown }).status;
  else next.status = status;
  return next;
};
const validCond = (status: string, errors: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  type: "Valid",
  status,
  reason: status === "True" ? "Valid" : "ErrorPresent",
  lastTransitionTime: "2026-10-21T08:00:00Z",
  errors,
  ...extra,
});
const ORPHAN_ERR = { type: "Orphaned", status: "True", reason: "Orphaned", message: "not part of a delegation chain from a root" };
const TLS_ERR = { type: "TLSError", status: "True", reason: "SecretNotValid", message: 'Secret "web/gone" not found' };

/** The fixtures and variants of their statuses: Contour's own words, older ones, none. */
function proxyVariants(): KubeObject[] {
  const out: KubeObject[] = proxies.map(copy);
  for (const base of [root, blog, orphan]) {
    out.push(
      withStatus(base, undefined),
      withStatus(base, { currentStatus: "NotReconciled", description: "Waiting for controller" }),
      // An older status without `currentStatus`: the Valid condition decides.
      withStatus(base, { conditions: [validCond("True")] }),
      withStatus(base, { conditions: [validCond("False", [TLS_ERR])] }),
      withStatus(base, { conditions: [validCond("False", [ORPHAN_ERR])] }),
      withStatus(base, { conditions: [validCond("False", [TLS_ERR, ORPHAN_ERR])] }),
      withStatus(base, { conditions: [validCond("False", [])], description: "something went wrong" }),
      withStatus(base, { conditions: [validCond("Unknown")] }),
      withStatus(base, { conditions: [{ type: "Valid", errors: [TLS_ERR] }] }),
      withStatus(base, { currentStatus: "other", conditions: [validCond("False", [TLS_ERR])] }),
      // Contour's words win over the condition.
      withStatus(base, { currentStatus: "valid", conditions: [validCond("False", [TLS_ERR])] }),
      withStatus(base, { currentStatus: "invalid", conditions: [validCond("False", [ORPHAN_ERR])] }),
      withStatus(base, { currentStatus: "invalid", description: "no condition" }),
      withStatus(base, { currentStatus: "orphaned", conditions: [validCond("False", [TLS_ERR])] }),
      withStatus(base, { currentStatus: "invalid", conditions: [validCond("False", [{ type: "TLSError", message: "no reason" }])] }),
      withStatus(base, { currentStatus: "invalid", conditions: [validCond("False", [{ type: "TLSError", reason: "SecretNotValid" }])], description: "from the description" }),
    );
  }
  return out;
}

describe("the problem rules, judged by the window, against the built-in detector", () => {
  it("find invalid and orphaned proxies with Contour's reason, message and time; a proxy not processed yet is none", () => {
    for (const o of proxyVariants()) expectSameProblems(HTTP_PROXY, o);
    expect(windowProblems(HTTP_PROXY, root)).toMatchObject([{ reason: "IncludeNotFound", graceMs: CONTOUR_GRACE_MS }]);
    expect(windowProblems(HTTP_PROXY, orphan)).toMatchObject([{ reason: "Orphaned" }]);
    expect(windowProblems(HTTP_PROXY, blog)).toEqual([]);
    expect(windowProblems(HTTP_PROXY, fresh)).toEqual([]);
    expect(rulesOf(EXTENSION_SERVICE)).toEqual([]);
    expect(rulesOf(TLS_DELEGATION)).toEqual([]);
  });

  it("each in a group of its own state, as the built-in's", () => {
    for (const o of proxyVariants()) {
      expect(
        windowProblems(HTTP_PROXY, o).map((d) => d.group),
        o.metadata.name,
      ).toEqual(contourProblems(HTTP_PROXY, o).map((d) => d.group));
    }
  });

  it("tell an orphan through an invalid proxy above it, as the built-in judgement across proxies", () => {
    const keyOf = (k: { group: string; kind: string }) => `${k.group}/${k.kind}`.toLowerCase();
    const rules = c.problems.filter((r) => sameKind(r.kind, HTTP_PROXY));
    const facts = across.factsOf(rules, keyOf).get(keyOf(HTTP_PROXY)) ?? [];
    const referrers = rules.flatMap((r) => ("toldThroughReferrer" in r && r.toldThroughReferrer ? [r.toldThroughReferrer] : []));
    expect(referrers).toHaveLength(1);
    const toRow = across.rowOf([], facts, false, [], referrers);
    type Inc = { name: string; namespace?: string };
    const proxy = (ns: string, name: string, state: "valid" | "invalid" | "orphaned" | "condition", includes: Inc[] = [], tcp?: Inc): KubeObject => {
      const status =
        state === "condition"
          ? { conditions: [validCond("False", [TLS_ERR])] }
          : { currentStatus: state, conditions: [validCond(state === "valid" ? "True" : "False", state === "orphaned" ? [ORPHAN_ERR] : state === "invalid" ? [TLS_ERR] : [])] };
      return {
        apiVersion: "projectcontour.io/v1",
        kind: "HTTPProxy",
        metadata: { name, namespace: ns, uid: `${ns}-${name}` },
        spec: { includes, ...(tcp ? { tcpproxy: { include: tcp } } : {}) },
        status,
      } as unknown as KubeObject;
    };
    /** The orphans each side tells, by `namespace/name`. */
    const told = (objects: KubeObject[]) => {
      const builtIn = toldThroughInvalid(
        objects.flatMap((o) => contourProblems(HTTP_PROXY, o).map((d) => ({ reason: d.reason, namespace: o.metadata.namespace ?? "", name: o.metadata.name }))),
        objects.map(proxyRow),
      ).map((p) => `${p.namespace}/${p.name}`);
      const problems = objects.flatMap((o) =>
        windowProblems(HTTP_PROXY, o).map((d) => ({ ...d, uid: o.metadata.uid, object: { kind: HTTP_PROXY, namespace: o.metadata.namespace, name: o.metadata.name } })),
      );
      const rows = { status: "ready", rows: new Map(objects.map((o) => [o.metadata.uid, toRow(o)])), truncated: false, namespaces: null };
      const kept = across
        .judgeAcross(problems, { rows, target: () => undefined, problemUids: () => new Set() }, { rules: new Map(rules.map((r) => [r.id, r])), targets: [] })
        .map((p) => `${p.object.namespace}/${p.object.name}`);
      return { builtIn: builtIn.sort(), kept: kept.sort() };
    };
    const sites = Array.from({ length: 20 }, (_, i) => proxy("sites", `site-${i}`, "orphaned"));
    const scenarios: KubeObject[][] = [
      // One broken root with 20 includes in another namespace: one problem.
      [proxy("roots", "root", "invalid", sites.map((s) => ({ name: s.metadata.name, namespace: "sites" }))), ...sites],
      // A chain: an invalid root, an orphaned middle, an orphaned leaf in the middle's own namespace (no namespace given).
      [proxy("a", "root", "invalid", [{ name: "mid", namespace: "b" }]), proxy("b", "mid", "orphaned", [{ name: "leaf" }]), proxy("b", "leaf", "orphaned")],
      // Invalid by its condition only (no `currentStatus`), three levels up.
      [proxy("a", "root", "condition", [{ name: "x" }]), proxy("a", "x", "orphaned", [{ name: "y" }]), proxy("a", "y", "orphaned", [{ name: "z" }]), proxy("a", "z", "orphaned")],
      // Under valid and orphaned proxies only, or included by nobody: problems of their own.
      [proxy("a", "root", "valid", [{ name: "x" }]), proxy("a", "x", "orphaned"), proxy("a", "loose", "orphaned")],
      [proxy("a", "x", "orphaned", [{ name: "y" }]), proxy("a", "y", "orphaned", [{ name: "x" }])],
      // The same name in another namespace is not included.
      [proxy("a", "root", "invalid", [{ name: "x" }]), proxy("b", "x", "orphaned")],
      // A cycle under an invalid proxy, and a second root, valid, that includes the same orphan.
      [proxy("a", "bad", "invalid", [{ name: "x" }]), proxy("a", "x", "orphaned", [{ name: "y" }]), proxy("a", "y", "orphaned", [{ name: "x" }]), proxy("a", "good", "valid", [{ name: "y" }])],
      // An invalid proxy that is itself orphaned-looking is not "invalid": the orphan under it stays.
      [proxy("a", "o1", "orphaned", [{ name: "o2" }]), proxy("a", "o2", "orphaned")],
    ];
    for (const objects of scenarios) {
      const { builtIn, kept } = told(objects);
      expect(kept, JSON.stringify(builtIn)).toEqual(builtIn);
    }
    expect(told(scenarios[0]!).kept).toEqual(["roots/root"]);
    // Through a TCP proxy's include (`tcpproxy.include`, else the older `tcpproxy.includes`), in its own namespace or another.
    const tcp = [
      [proxy("a", "root", "invalid", [], { name: "db" }), proxy("a", "db", "orphaned")],
      [proxy("a", "root", "invalid", [{ name: "web" }], { name: "db", namespace: "b" }), proxy("a", "web", "orphaned"), proxy("b", "db", "orphaned")],
      [proxy("a", "root", "valid", [], { name: "db" }), proxy("a", "db", "orphaned")],
    ];
    const older = proxy("a", "root", "invalid");
    (older.spec as Record<string, unknown>).tcpproxy = { includes: { name: "db" } };
    tcp.push([older, proxy("a", "db", "orphaned")]);
    for (const objects of tcp) {
      const { builtIn, kept } = told(objects);
      expect(kept, JSON.stringify(builtIn)).toEqual(builtIn);
    }
    expect(told(tcp[0]!).kept).toEqual(["a/root"]);
  });

  it("are counted on the section, as the built-in counter counted the category", () => {
    expect(c.sectionBadges).toEqual([
      { section: "contour", rules: ["proxy-invalid", "proxy-orphaned"], label: { one: "{{count}} HTTPProxy needs attention", other: "{{count}} HTTPProxies need attention" } },
    ]);
  });
});

describe("the kinds, the section and the details sections", () => {
  it("are the built-in section's", () => {
    expect(c.kinds.map((k) => [k.group, k.kind, k.section, k.title, k.icon, k.order, k.printerColumns])).toEqual([
      ["projectcontour.io", "HTTPProxy", "contour", "HTTP Proxies", "contourProxy", 10, false],
      ["projectcontour.io", "TLSCertificateDelegation", "contour", "TLS Certificate Delegations", "contourDelegation", 20, false],
      ["projectcontour.io", "ExtensionService", "contour", "Extension Services", "contourExtension", 30, false],
    ]);
    expect(c.sections).toEqual([{ section: "contour", title: "Contour", icon: "contour", after: "traefik" }]);
    expect(c.detailsSections.map((d) => [d.kinds[0]!.kind, d.title, d.order, d.placement, d.heading])).toEqual(
      ["HTTPProxy", "TLSCertificateDelegation", "ExtensionService"].map((k) => [k, k, 20, "section", false]),
    );
    expect(manifest.permissions.rules).toEqual([
      { namespaces: { type: "all" }, kinds: { type: "only", kinds: c.kinds.map((k) => ({ group: k.group, kind: k.kind })) }, actions: ["read"] },
    ]);
  });

  it("offer the HTTPProxy table's \"Only problems\" as the built-in filter: invalid or orphaned, no grace", () => {
    const when = c.kinds[0]!.problemWhen!;
    for (const o of proxyVariants()) expect(engine.evaluate(when, o).holds, JSON.stringify(o.status)).toBe(isProblem(o));
    expect(c.kinds.slice(1).every((k) => !("problemWhen" in k))).toBe(true);
  });
});

// ---------- The columns ----------

type Column = (typeof c.columns)[number];
const columnOf = (id: string) => c.columns.find((x) => x.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.contour:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = Date.parse("2026-10-23T10:00:00Z");
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) || undefined;
/** A cell's sort value. */
const sortOf = (id: string, obj: KubeObject) => windowColumn(id).value(obj);
/** A cell's filter value. */
const filterOf = (id: string, obj: KubeObject) => windowColumn(id).filter?.value(obj, { now: NOW, t: T });
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject): { title?: string; tone?: string } {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title: title || undefined, tone: node?.props?.tone };
}
const word = (key: string) => (en as Record<string, string>)[key];

/** The built-in columns' values (src/features/contour/columns.tsx), ported. */
const BUILT_IN = {
  includes: (o: KubeObject) => includesOf(o).length || undefined,
  routes: (o: KubeObject) => routesOf(o).length || undefined,
  proxyReason: (o: KubeObject) => (proxyState(o) === "orphaned" ? "Orphaned" : firstError(o)?.reason),
  secrets: (o: KubeObject) => delegationsOf(o).map((d) => d.secretName).join(", "),
  targets: (o: KubeObject) => [...new Set(delegationsOf(o).flatMap((d) => d.targetNamespaces))].join(", "),
  services: (o: KubeObject) => extensionFields(o).services.map((s) => `${s.name}:${s.port ?? ""}`).join(", "),
  extensionReason: (o: KubeObject) => validCondition(o)?.errors[0]?.reason,
};

/** Variants of the proxies' specs: TLS, includes (HTTP and TCP), routes. */
function specVariants(): KubeObject[] {
  const out = proxyVariants();
  const withSpec = (spec: Record<string, unknown>, ns = "web") => {
    const o = copy(blog);
    o.metadata.namespace = ns;
    o.spec = spec;
    return o;
  };
  const includes = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `site-${i}`, conditions: [{ prefix: `/s${i}` }] }));
  out.push(
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: { passthrough: true } }, tcpproxy: { services: [{ name: "db", port: 5432 }] } }),
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: { secretName: "own-cert" } }, routes: [] }),
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: { secretName: "other/cert" } } }),
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: null } }),
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: { secretName: "" } } }),
    // Named with the proxy's own namespace, or a namespace that only begins like it.
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: { secretName: "web/cert" } } }),
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: { secretName: "webx/cert" } } }),
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: { secretName: "web" } } }),
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: { secretName: "web/" } } }),
    withSpec({ virtualhost: { fqdn: "a.example.com", tls: { secretName: "web/cert", passthrough: true } } }),
    withSpec({ includes: [] }),
    withSpec({ includes: [{ conditions: [] }] }),
    withSpec({ includes: [{ name: "" }, { name: "site" }, { name: "" }] }),
    withSpec({ includes: [{ name: "" }], tcpproxy: { include: { name: "tcp-backend" } } }),
    withSpec({ includes: includes(3), routes: [{}, {}, {}] }),
    withSpec({ tcpproxy: { include: { name: "tcp-backend", namespace: "db" } } }),
    withSpec({ tcpproxy: { includes: { name: "tcp-backend" } } }),
    withSpec({ tcpproxy: { include: { name: "" } } }),
    withSpec({ tcpproxy: { include: { namespace: "db" }, includes: { name: "ignored" } } }),
    ...[1, 2, 5, 17, 18, 40].map((n) => withSpec({ includes: includes(n), tcpproxy: { include: { name: "tcp-backend" } } })),
    withSpec({ includes: includes(25), tcpproxy: { includes: { name: "tcp-backend" } } }),
    withSpec({ includes: includes(25) }),
  );
  return out;
}

describe("the columns, against the built-in ones", () => {
  it("are placed after the namespace, in the built-in order, with the built-in widths", () => {
    for (const kind of c.kinds) {
      const own = c.columns.filter((x) => sameKind(x.kind, kind));
      expect(own[0]!.afterColumn).toBe("namespace");
      for (let i = 1; i < own.length; i++) expect(own[i]!.afterColumn).toBe(own[i - 1]!.id);
    }
    const of = (kind: KindOf) => c.columns.filter((x) => sameKind(x.kind, kind)).map((x) => [x.title, x.width]);
    expect(of(HTTP_PROXY)).toEqual([
      ["Status", "110px"],
      ["Host", "minmax(140px, 2fr)"],
      ["TLS Secret", "minmax(120px, 1fr)"],
      ["Includes", "90px"],
      ["Routes", "80px"],
      ["Reason", "minmax(100px, 1fr)"],
    ]);
    expect(of(TLS_DELEGATION)).toEqual([
      ["Secrets", "minmax(140px, 2fr)"],
      ["Target namespaces", "minmax(140px, 2fr)"],
    ]);
    expect(of(EXTENSION_SERVICE)).toEqual([
      ["Status", "110px"],
      ["Services", "minmax(140px, 2fr)"],
      ["Protocol", "90px"],
      ["Reason", "minmax(100px, 1fr)"],
    ]);
  });

  it("say a proxy's state in Contour's words and tone, sorted and filtered by its name", () => {
    const TONE = { success: "success", warning: "warning", danger: "danger", muted: "muted" } as const;
    for (const o of specVariants()) {
      const state = proxyState(o);
      expect(cell("proxy-status", o), JSON.stringify(o.status)).toBe(word(`state.${state}`));
      expect(drawn("proxy-status", o).tone).toBe(TONE[HEALTH_TONE[PROXY_HEALTH[state]] as keyof typeof TONE]);
      expect(sortOf("proxy-status", o)).toBe(state);
      expect(filterOf("proxy-status", o)).toBe(state);
    }
  });

  it("show the host, the TLS Secret, the counts and the reason as the built-in did", () => {
    for (const o of specVariants()) {
      const at = `${o.metadata.name} ${JSON.stringify(o.spec)} ${JSON.stringify(o.status)}`;
      expect(cell("proxy-fqdn", o), at).toBe(fqdnOf(o));
      const tls = tlsText(o);
      expect(cell("proxy-tls", o), at).toBe(tls === "" ? undefined : tls);
      expect(sortOf("proxy-tls", o), at).toBe(tls === "" ? undefined : tls);
      const n = BUILT_IN.includes(o);
      expect(cell("proxy-includes", o), at).toBe(n === undefined ? undefined : String(n));
      expect(sortOf("proxy-includes", o), at).toBe(n);
      expect(filterOf("proxy-includes", o), at).toBe(n);
      const r = BUILT_IN.routes(o);
      expect(cell("proxy-routes", o), at).toBe(r === undefined ? undefined : String(r));
      expect(sortOf("proxy-routes", o), at).toBe(r);
      expect(cell("proxy-reason", o), at).toBe(BUILT_IN.proxyReason(o));
    }
  });

  it("list a delegation's Secrets and target namespaces, each once", () => {
    const many = copy(delegation);
    sp(many).delegations = [
      { secretName: "a", targetNamespaces: ["x", "y"] },
      { secretName: "b", targetNamespaces: ["y", "z"] },
      { secretName: "c", targetNamespaces: ["*"] },
      { secretName: "", targetNamespaces: ["unnamed"] },
      ...Array.from({ length: 9 }, (_, i) => ({ secretName: `s${i}`, targetNamespaces: [`ns${i}`, "x"] })),
    ];
    const none = copy(delegation);
    sp(none).delegations = [];
    for (const o of [delegation, many, none]) {
      expect(cell("delegation-secrets", o) ?? "").toBe(BUILT_IN.secrets(o));
      expect(cell("delegation-targets", o) ?? "").toBe(BUILT_IN.targets(o));
    }
  });

  it("say an ExtensionService's state, services, protocol and reason", () => {
    const variants = [extension, ...["True", "False", "Unknown"].map((s) => withStatus(extension, { conditions: [validCond(s, s === "False" ? [TLS_ERR] : [])] })), withStatus(extension, undefined)];
    const noPort = copy(extension);
    sp(noPort).services = [{ name: "a" }, { name: "b", port: 80 }, { port: 81 }];
    variants.push(noPort);
    const TONE = { success: "success", warning: "warning", danger: "danger", muted: "muted" } as const;
    for (const o of variants) {
      const health = healthOf(EXTENSION_SERVICE, o);
      expect(cell("extension-status", o)).toBe(word(`health.${health}`));
      expect(drawn("extension-status", o).tone).toBe(TONE[HEALTH_TONE[health] as keyof typeof TONE]);
      expect(filterOf("extension-status", o)).toBe(health);
      expect(cell("extension-services", o) ?? "").toBe(BUILT_IN.services(o));
      expect(cell("extension-protocol", o)).toBe(extensionFields(o).protocol);
      expect(cell("extension-reason", o)).toBe(BUILT_IN.extensionReason(o));
    }
  });
});
