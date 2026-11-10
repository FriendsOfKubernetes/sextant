// @vitest-environment node
// The manifest's declarative parts — the columns and the problem rules — judged by Sextant's own window engine
// (src/extensions/problemRules.ts and columns.tsx, loaded at run time so the type check stays inside the extension)
// and compared with what the built-in mesh views computed (ADR-0089): the built-in columns (`columns.tsx`, ported
// below over the engines ported unchanged into `engine/`) and the built-in problems (`meshProblems` over the whole
// configuration, as the built-in store held it) against the rules over the backend's judges' facts (ADR-0168), on
// the built-in fixtures and variants of them. Where the extension API cannot say what the built-in said (README,
// "Requirements and limits"), the difference is pinned here.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import manifest from "../sextant-extension.json";
import bookinfo from "../fixtures/bookinfo.json";
import { parseAuthorizationPolicy } from "./engine/authz";
import { allDestinations, parseDestinationRule, parseIstioGateway, parseServiceEntry, parseVirtualService, ROOT_NAMESPACE, serviceOfHost } from "./engine/istio";
import { MESH_KINDS } from "./engine/kinds";
import { parsePeerAuthentication } from "./engine/mtls";
import { meshProblems, type AnalysisInput } from "./engine/problems";
import judgeCalls from "../fixtures/judge-calls.json";
import { factId, JUDGE_IDS, JUDGES, REASON_VALUES, type JudgeId, type JudgedInput, type JudgedOutput } from "./judges";
import { arr, get, record, str } from "./engine/util";
import en from "./locales/en.json";

// The backend runs here as built (`backend/main.ts` through the SDK's `defineBackend`), its component's host module
// replaced by a stand-in that refuses every call, as Sextant refuses them while a judge runs.
vi.mock("sextant:extension/host@1.0.0", () => ({
  call: () => {
    throw Object.assign(new Error("refused"), { payload: { code: "denied", message: "no host call while judging" } });
  },
  log: () => undefined,
}));

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  lookups?: { group: string; kind: string; name: string; namespace?: string; anyOf?: string }[];
}
interface Detected {
  reason: string;
  message?: string;
  lookups?: Verdict["lookups"];
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
let handle: (method: string, params: string) => Promise<string>;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  ({ handle } = await import("../backend/main"));
  engine = (await import(/* @vite-ignore */ joinPath(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ joinPath(here, "../../../src/extensions/columns.tsx"))) as Columns;
});

const NOW = Date.parse("2026-11-01T12:00:00Z");
type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const cell = (id: string, obj: KubeObject) => columns.computedColumn(`ext:sextant.mesh:${id}`, columnOf(id)).searchText(obj, { now: NOW, t: (k) => k }) ?? "";
function hover(id: string, obj: KubeObject): string | undefined {
  const node = columns.computedColumn(`ext:sextant.mesh:${id}`, columnOf(id)).render(obj, { now: NOW }) as { props?: { title?: string } } | null;
  return node?.props?.title;
}

// ---------- The built-in columns (`columns.tsx` of the built-in view), ported ----------

const join = (values: readonly (string | undefined)[]) => values.filter(Boolean).join(", ");
function firstPlus(values: readonly string[]): string {
  const [first, ...rest] = values;
  if (!first) return "";
  return rest.length > 0 ? `${first} +${rest.length}` : first;
}
function scopeText(obj: KubeObject, selectorPath: string[] = ["spec", "selector", "matchLabels"]): string {
  const selector = record(get(obj, ...selectorPath));
  if (Object.keys(selector).length > 0) return join(Object.entries(selector).map(([k, v]) => `${k}=${String(v)}`));
  return obj.metadata.namespace === ROOT_NAMESPACE ? en["scope.mesh"] : en["scope.namespace"];
}
const BUILT_IN: Record<string, (o: KubeObject) => string | number | undefined> = {
  "vs-hosts": (o) => firstPlus(parseVirtualService(o).hosts),
  "vs-gateways": (o) => join(parseVirtualService(o).gateways),
  "vs-routes": (o) => parseVirtualService(o).http.length + parseVirtualService(o).l4.length,
  "dr-host": (o) => str(get(o, "spec", "host")),
  "dr-subsets": (o) => join(parseDestinationRule(o).subsets.map((s) => s.name)),
  "dr-tls": (o) => parseDestinationRule(o).tlsMode,
  "gw-servers": (o) => join(parseIstioGateway(o).servers.map((s) => `${s.port ?? ""}/${s.protocol ?? ""}`)),
  "gw-hosts": (o) => firstPlus([...new Set(parseIstioGateway(o).servers.flatMap((s) => s.hosts))]),
  "se-hosts": (o) => firstPlus(parseServiceEntry(o).hosts),
  "se-location": (o) => parseServiceEntry(o).location,
  "se-resolution": (o) => parseServiceEntry(o).resolution,
  "sc-applies": (o) => scopeText(o, ["spec", "workloadSelector", "labels"]),
  "sc-egress": (o) => arr(get(o, "spec", "egress")).flatMap((e) => arr(get(e, "hosts"))).length,
  "we-address": (o) => str(get(o, "spec", "address")),
  "we-sa": (o) => str(get(o, "spec", "serviceAccount")),
  "pa-applies": (o) => scopeText(o),
  "pa-mtls": (o) => str(get(o, "spec", "mtls", "mode")) ?? "UNSET",
  "ra-applies": (o) => scopeText(o),
  "ra-issuers": (o) => join(arr(get(o, "spec", "jwtRules")).map((r) => str(get(r, "issuer")))),
  "ap-action": (o) => parseAuthorizationPolicy(o).action,
  "ap-applies": (o) => (parseAuthorizationPolicy(o).targetRef ? en["scope.targetRef"] : scopeText(o)),
  "ap-rules": (o) => parseAuthorizationPolicy(o).rules.length,
  "tm-applies": (o) => scopeText(o),
  "sp-routes": (o) => arr(get(o, "spec", "routes")).length,
  "srv-port": (o) => String(get(o, "spec", "port") ?? ""),
  "srv-protocol": (o) => str(get(o, "spec", "proxyProtocol")),
  "srv-selector": (o) => scopeText(o, ["spec", "podSelector", "matchLabels"]),
  "hr-parents": (o) => join(arr(get(o, "spec", "parentRefs")).map((p) => `${str(get(p, "kind")) ?? ""} ${str(get(p, "name")) ?? ""}`)),
  "hr-hosts": (o) => firstPlus(arr(get(o, "spec", "hostnames")).map(String)),
  "lap-target": (o) => `${str(get(o, "spec", "targetRef", "kind")) ?? ""} ${str(get(o, "spec", "targetRef", "name")) ?? ""}`,
  "lap-auth": (o) => join(arr(get(o, "spec", "requiredAuthenticationRefs")).map((r) => str(get(r, "name")))),
  "sa-server": (o) => str(get(o, "spec", "server", "name")) ?? scopeText(o, ["spec", "server", "selector", "matchLabels"]),
  "mtls-ids": (o) => join([...arr(get(o, "spec", "identities")).map(String), ...arr(get(o, "spec", "identityRefs")).map((r) => str(get(r, "name")))]),
  "na-networks": (o) => join(arr(get(o, "spec", "networks")).map((n) => str(get(n, "cidr")))),
};
const builtIn = (id: string, obj: KubeObject) => {
  const v = BUILT_IN[id]!(obj);
  return v === undefined ? "" : String(v);
};
/** The built-in hover of a hosts column: every host, one per line. */
const BUILT_IN_HOVER: Record<string, (o: KubeObject) => string[]> = {
  "vs-hosts": (o) => parseVirtualService(o).hosts,
  "se-hosts": (o) => parseServiceEntry(o).hosts,
  "gw-hosts": (o) => [...new Set(parseIstioGateway(o).servers.flatMap((s) => s.hosts))],
  "hr-hosts": (o) => arr(get(o, "spec", "hostnames")).map(String),
};

// ---------- Objects ----------

let seq = 0;
function obj(apiVersion: string, kind: string, namespace: string, name: string, spec: unknown, extra: Record<string, unknown> = {}): KubeObject {
  seq++;
  return { apiVersion, kind, metadata: { namespace, name, uid: `${kind}-${name}-${seq}`, creationTimestamp: `2026-01-0${(seq % 9) + 1}T00:00:00Z`, ...extra }, spec } as KubeObject;
}
const fx = bookinfo as unknown as Record<string, KubeObject[]>;
const NET = "networking.istio.io/v1";
const SEC = "security.istio.io/v1";
const LP = "policy.linkerd.io/v1beta3";
const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);

/** Objects of each kind the columns are compared on: the fixtures and variants of every field a column reads. */
const OBJECTS: Record<string, KubeObject[]> = {
  VirtualService: [
    ...fx.virtualServices!,
    obj(NET, "VirtualService", "shop", "delegate", { http: [{ route: [{ destination: { host: "a" } }] }] }),
    obj(NET, "VirtualService", "shop", "none", {}),
    obj(NET, "VirtualService", "shop", "tcp", { hosts: ["db"], tcp: [{ route: [{ destination: { host: "db" } }] }], tls: [{ match: [{ sniHosts: ["x"] }], route: [] }] }),
    obj(NET, "VirtualService", "shop", "gw1", { hosts: ["a"], gateways: ["public"] }),
    obj(NET, "VirtualService", "shop", "gw2", { hosts: ["a"], gateways: ["mesh", "istio-ingress/public"] }),
    obj(NET, "VirtualService", "shop", "gw3", { hosts: ["a"], gateways: ["public", "mesh"] }),
    obj(NET, "VirtualService", "shop", "gw4", { hosts: ["a"], gateways: ["a/x", "b", "mesh"] }),
    obj(NET, "VirtualService", "shop", "gw5", { hosts: ["a"], gateways: ["a/x", "b/y", "c/z", "mesh"] }),
    obj(NET, "VirtualService", "shop", "gw-empty", { hosts: ["a"], gateways: [] }),
    ...[1, 2, 3, 19, 20].map((n) => obj(NET, "VirtualService", "shop", `hosts-${n}`, { hosts: hosts(n) })),
  ],
  DestinationRule: [
    ...fx.destinationRules!,
    obj(NET, "DestinationRule", "shop", "plain", { host: "x" }),
    obj(NET, "DestinationRule", "shop", "tls", { host: "x", trafficPolicy: { tls: { mode: "SIMPLE" } }, subsets: [{ name: "a" }, { name: "b", labels: { v: "b" } }] }),
  ],
  Gateway: [
    ...fx.gateways!,
    obj(NET, "Gateway", "gw", "two", {
      selector: { istio: "ingress" },
      servers: [
        { port: { number: 80, protocol: "HTTP" }, hosts: ["*"] },
        { port: { number: 443, protocol: "HTTPS" }, hosts: ["*"] },
      ],
    }),
    obj(NET, "Gateway", "gw", "partial", { servers: [{ port: { number: 80 }, hosts: ["a.example.com"] }, { port: { protocol: "TCP" } }, {}] }),
    obj(NET, "Gateway", "gw", "empty", {}),
  ],
  ServiceEntry: [
    obj(NET, "ServiceEntry", "shop", "ext", { hosts: ["api.example.com"], location: "MESH_EXTERNAL", resolution: "DNS" }),
    obj(NET, "ServiceEntry", "shop", "many", { hosts: hosts(3), location: "MESH_INTERNAL" }),
    obj(NET, "ServiceEntry", "shop", "none", {}),
  ],
  Sidecar: [
    obj(NET, "Sidecar", "shop", "ns", { egress: [{ hosts: ["./*", "istio-system/*"] }, { hosts: ["a/b"] }] }),
    obj(NET, "Sidecar", "istio-system", "root", {}),
    obj(NET, "Sidecar", "shop", "wl", { workloadSelector: { labels: { app: "web", tier: "front" } } }),
  ],
  WorkloadEntry: [obj(NET, "WorkloadEntry", "shop", "vm", { address: "10.0.0.5", serviceAccount: "vm-sa" }), obj(NET, "WorkloadEntry", "shop", "bare", {})],
  PeerAuthentication: [
    ...fx.peerAuthentications!,
    obj(SEC, "PeerAuthentication", "istio-system", "mesh", { mtls: { mode: "STRICT" } }),
    obj(SEC, "PeerAuthentication", "shop", "wl", { selector: { matchLabels: { app: "web" } } }),
  ],
  RequestAuthentication: [
    obj(SEC, "RequestAuthentication", "shop", "jwt", { selector: { matchLabels: { app: "web" } }, jwtRules: [{ issuer: "https://a" }, { issuer: "https://b" }, {}] }),
    obj(SEC, "RequestAuthentication", "shop", "ns", {}),
  ],
  AuthorizationPolicy: [
    ...fx.authorizationPolicies!,
    obj(SEC, "AuthorizationPolicy", "shop", "deny", { action: "DENY", rules: [{}, {}] }),
    obj(SEC, "AuthorizationPolicy", "shop", "odd", { action: "WHATEVER" }),
    obj(SEC, "AuthorizationPolicy", "shop", "gw", { targetRef: { kind: "Gateway", name: "x" }, action: "CUSTOM" }),
    obj(SEC, "AuthorizationPolicy", "shop", "gws", { targetRefs: [{ kind: "Gateway", name: "x" }] }),
    obj(SEC, "AuthorizationPolicy", "istio-system", "root", {}),
  ],
  Telemetry: [obj("telemetry.istio.io/v1", "Telemetry", "istio-system", "mesh", {}), obj("telemetry.istio.io/v1", "Telemetry", "shop", "wl", { selector: { matchLabels: { app: "web" } } })],
  ServiceProfile: [obj("linkerd.io/v1alpha2", "ServiceProfile", "shop", "web.shop.svc.cluster.local", { routes: [{ name: "a" }, { name: "b" }] }), obj("linkerd.io/v1alpha2", "ServiceProfile", "shop", "x", {})],
  Server: [
    obj(LP, "Server", "shop", "http", { port: 8080, proxyProtocol: "HTTP/2", podSelector: { matchLabels: { app: "web" } } }),
    obj(LP, "Server", "shop", "named", { port: "http" }),
  ],
  HTTPRoute: [
    obj(LP, "HTTPRoute", "shop", "r", { parentRefs: [{ kind: "Server", name: "http" }, { name: "x" }], hostnames: ["a.example.com", "b.example.com"] }),
    obj(LP, "HTTPRoute", "shop", "bare", {}),
  ],
  "policy.linkerd.io/AuthorizationPolicy": [
    obj("policy.linkerd.io/v1alpha1", "AuthorizationPolicy", "shop", "p", { targetRef: { kind: "Server", name: "http" }, requiredAuthenticationRefs: [{ name: "a" }, { name: "b" }] }),
    obj("policy.linkerd.io/v1alpha1", "AuthorizationPolicy", "shop", "ns", { targetRef: { kind: "Namespace", name: "shop" } }),
  ],
  ServerAuthorization: [
    obj("policy.linkerd.io/v1beta1", "ServerAuthorization", "shop", "by-name", { server: { name: "http" } }),
    obj("policy.linkerd.io/v1beta1", "ServerAuthorization", "shop", "by-labels", { server: { selector: { matchLabels: { app: "web" } } } }),
    obj("policy.linkerd.io/v1beta1", "ServerAuthorization", "shop", "none", {}),
  ],
  MeshTLSAuthentication: [obj("policy.linkerd.io/v1alpha1", "MeshTLSAuthentication", "shop", "m", { identities: ["a.shop.serviceaccount.identity.linkerd.cluster.local"], identityRefs: [{ kind: "ServiceAccount", name: "web" }] })],
  NetworkAuthentication: [obj("policy.linkerd.io/v1alpha1", "NetworkAuthentication", "shop", "n", { networks: [{ cidr: "10.0.0.0/8" }, { cidr: "0.0.0.0/0", except: ["10.0.0.0/8"] }] })],
};
const objectsOf = (group: string, kind: string) => OBJECTS[`${group}/${kind}`] ?? OBJECTS[kind] ?? [];

describe("the columns, against the built-in ones", () => {
  it("are the built-in columns of every kind, in its order and widths, after the namespace", () => {
    for (const def of MESH_KINDS) {
      const own = manifest.contributes.columns.filter((c) => c.kind.group === def.kind.group && c.kind.kind === def.kind.kind);
      expect(own.length, def.kind.kind).toBeGreaterThan(0);
      expect(own[0]!.afterColumn).toBe("namespace");
      own.slice(1).forEach((c, i) => expect(c.afterColumn).toBe(own[i]!.id));
    }
    const titles = manifest.contributes.columns.map((c) => `${c.kind.kind}:${c.title}:${c.width}`);
    expect(titles).toEqual([
      "VirtualService:Hosts:minmax(160px, 2fr)",
      "VirtualService:Gateways:minmax(120px, 2fr)",
      "VirtualService:Routes:80px",
      "DestinationRule:Host:minmax(160px, 2fr)",
      "DestinationRule:Subsets:minmax(100px, 1fr)",
      "DestinationRule:TLS mode:minmax(100px, 1fr)",
      "Gateway:Servers:minmax(120px, 1fr)",
      "Gateway:Hosts:minmax(160px, 2fr)",
      "ServiceEntry:Hosts:minmax(160px, 2fr)",
      "ServiceEntry:Location:120px",
      "ServiceEntry:Resolution:110px",
      "Sidecar:Applies to:minmax(140px, 2fr)",
      "Sidecar:Egress hosts:110px",
      "WorkloadEntry:Address:minmax(120px, 1fr)",
      "WorkloadEntry:Service account:minmax(120px, 1fr)",
      "PeerAuthentication:Applies to:minmax(140px, 2fr)",
      "PeerAuthentication:mTLS mode:120px",
      "RequestAuthentication:Applies to:minmax(140px, 2fr)",
      "RequestAuthentication:Issuers:minmax(160px, 2fr)",
      "AuthorizationPolicy:Action:90px",
      "AuthorizationPolicy:Applies to:minmax(140px, 2fr)",
      "AuthorizationPolicy:Rules:70px",
      "Telemetry:Applies to:minmax(140px, 2fr)",
      "ServiceProfile:Routes:80px",
      "Server:Port:90px",
      "Server:Protocol:120px",
      "Server:Pod selector:minmax(140px, 2fr)",
      "HTTPRoute:Parents:minmax(140px, 2fr)",
      "HTTPRoute:Hosts:minmax(160px, 2fr)",
      "AuthorizationPolicy:Target:minmax(140px, 2fr)",
      "AuthorizationPolicy:Authentications:minmax(140px, 2fr)",
      "ServerAuthorization:Server:minmax(140px, 2fr)",
      "MeshTLSAuthentication:Identities:minmax(160px, 3fr)",
      "NetworkAuthentication:Networks:minmax(160px, 3fr)",
    ]);
    // The CRDs' own printer columns are left out, as the built-in view registered its own columns.
    for (const k of manifest.contributes.kinds) expect(k.printerColumns, k.kind).toBe(false);
  });

  it("show what the built-in columns showed on every object", () => {
    let compared = 0;
    for (const c of manifest.contributes.columns) {
      for (const o of objectsOf(c.kind.group, c.kind.kind)) {
        const want = builtIn(c.id, o);
        // The built-in's `"Kind name"` of a missing part kept its space; Sextant trims a cell.
        expect(cell(c.id, o), `${c.id} ${o.metadata.name}`).toBe(want.trim());
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(80);
  });

  it("hover a hosts column's hosts, one per line, as the built-in", () => {
    for (const id of Object.keys(BUILT_IN_HOVER)) {
      const c = columnOf(id);
      for (const o of objectsOf(c.kind.group, c.kind.kind)) {
        const list = BUILT_IN_HOVER[id]!(o);
        expect(hover(id, o), `${id} ${o.metadata.name}`).toBe(list.length > 0 ? list.join("\n") : undefined);
      }
    }
  });

  it("a ServiceEntry's short host in full and in lower case, as the built-in wrote it", () => {
    for (const hosts of [["Billing"], [" Api.Example.COM ", "*", "x"], ["*.Wild.example.com", "short"]]) {
      const o = obj(NET, "ServiceEntry", "shop", "short", { hosts });
      expect(cell("se-hosts", o), hosts.join()).toBe(builtIn("se-hosts", o));
      expect(hover("se-hosts", o), hosts.join()).toBe(parseServiceEntry(o).hosts.join("\n"));
    }
  });

  it("a Gateway's hosts without their namespace part, in lower case, each once: the first and how many more", () => {
    const g = obj(NET, "Gateway", "gw", "many", { servers: [{ hosts: ["shop/A.example.com", "b.example.com"] }, { hosts: ["b.example.com", "*/b.example.com", "./c.example.com"] }] });
    expect(builtIn("gw-hosts", g)).toBe("a.example.com +2");
    expect(cell("gw-hosts", g)).toBe(builtIn("gw-hosts", g));
  });

  it("a VirtualService's gateways with their namespace, however many", () => {
    for (const gateways of [["a", "b", "c"], ["a", "x/b", "mesh", "c", "d"], [], undefined]) {
      const o = obj(NET, "VirtualService", "shop", "g", gateways === undefined ? { hosts: ["a"] } : { hosts: ["a"], gateways });
      expect(cell("vs-gateways", o), JSON.stringify(gateways)).toBe(builtIn("vs-gateways", o));
    }
  });

  it("hosts columns of any length: the first and how many more", () => {
    for (const n of [25, 100]) {
      const o = obj(NET, "VirtualService", "shop", "many", { hosts: hosts(n) });
      expect(cell("vs-hosts", o)).toBe(builtIn("vs-hosts", o));
    }
  });

  it("a Mesh TLS Authentication's identities with their repeats, as the built-in", () => {
    const o = obj("policy.linkerd.io/v1alpha1", "MeshTLSAuthentication", "shop", "dup", { identities: ["web", "a"], identityRefs: [{ kind: "ServiceAccount", name: "web" }] });
    expect(cell("mtls-ids", o)).toBe(builtIn("mtls-ids", o));
    expect(cell("mtls-ids", o)).toBe("web, a, web");
  });

  it("numbers sort as numbers", () => {
    const vs = OBJECTS.VirtualService!.find((o) => o.metadata.name === "tcp")!;
    expect(columns.computedColumn("x", columnOf("vs-routes")).value(vs)).toBe(2);
  });
});

// ---------- The problems: the backend's judges and the rules over their facts ----------

type Rule = (typeof manifest.contributes.problems)[number];
const rules = manifest.contributes.problems as Rule[];
type Judge = (typeof manifest.contributes.problemJudges)[number];
const judgesOf = manifest.contributes.problemJudges as Judge[];
type Need = { kind: { group: string; kind: string }; namespace?: string; name?: string };
type Found = { uid: string; reason: string; message: string; needs: Need[] };

const groupOf = (o: KubeObject) => (o.apiVersion?.includes("/") ? o.apiVersion.split("/")[0]! : "");
const reads = (judge: Judge, o: KubeObject) => judge.reads.find((r) => r.kind.group === groupOf(o) && r.kind.kind === o.kind);

/** An object as Sextant sends it to `judge`: who it is and the values at the declared paths; `null` when not read. */
function sent(judge: Judge, o: KubeObject): JudgedInput | null {
  const read = reads(judge, o);
  if (!read) return null;
  const values: Record<string, unknown> = {};
  for (const path of read.paths) {
    const value = path === ".spec" ? o.spec : path === ".metadata.name" ? o.metadata.name : undefined;
    if (value !== undefined) values[path] = value;
  }
  return {
    apiVersion: o.apiVersion!,
    kind: o.kind!,
    metadata: { name: o.metadata.name, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}), uid: o.metadata.uid!, ...(o.metadata.creationTimestamp ? { creationTimestamp: o.metadata.creationTimestamp } : {}) },
    values,
  };
}

/**
 * The namespaces whose lists could not be read (refused there) — of Services only (`services`, as the built-in store's
 * Services watch could be refused), or of every kind (`all`): the window sends none of their objects and says so for
 * each `partial` read (`JudgedPartial`).
 */
type Unread = readonly string[];
type Refused = "services" | "all";

const refusedKind = (refused: Refused, kind: { group: string; kind: string }) => refused === "all" || (kind.group === "" && kind.kind === "Service");

/** The input Sextant sends a judge: the objects read and, for a `partial` read read in part, where it was not. */
function inputOf(j: Judge, world: KubeObject[], unread: Unread, refused: Refused): { objects: JudgedInput[]; partial?: unknown[] } {
  const hidden = (o: KubeObject) => refusedKind(refused, { group: groupOf(o), kind: o.kind! }) && unread.includes(o.metadata.namespace ?? "");
  const objects = world.filter((o) => !hidden(o)).map((o) => sent(j, o)).filter((o): o is JudgedInput => o !== null);
  const partial = j.reads
    .filter((r) => (r as { partial?: boolean }).partial && unread.length > 0 && refusedKind(refused, r.kind))
    .map((r) => ({ kind: r.kind, unreadNamespaces: [...unread] }));
  return partial.length > 0 ? { objects, partial } : { objects };
}

/** Each judge's answer over the world, by judge id: the built backend's, through `handle` as Sextant calls it. */
async function answers(world: KubeObject[], unread: Unread = [], refused: Refused = "services"): Promise<Map<string, JudgedOutput[]>> {
  const out = new Map<string, JudgedOutput[]>();
  for (const j of judgesOf) out.set(j.id, JSON.parse(await handle(`problemJudge:${j.id}`, JSON.stringify(inputOf(j, world, unread, refused)))) as JudgedOutput[]);
  return out;
}

/**
 * The extension's problems, as the window keeps them: a rule's `judged` lookup holds where its judge's answer gives
 * the fact for the object, and `{{fact:<name>}}` shows the fact's texts (`withFacts` of `problemsAcross.ts`).
 */
async function extensionProblems(world: KubeObject[], unread: Unread = [], refused: Refused = "services"): Promise<Found[]> {
  const given = await answers(world, unread, refused);
  const out: Found[] = [];
  for (const o of world) {
    for (const rule of rules.filter((r) => r.kind.group === groupOf(o) && r.kind.kind === o.kind)) {
      for (const d of engine.detectRule(rule, o)) {
        const lookups = d.lookups ?? [];
        expect(lookups.length).toBe(1);
        const judged = (lookups[0] as { judged?: { judge: string; fact: string } }).judged!;
        // `each` (ADR-0168 amendment): one problem per entry of the fact the answer gives for the object.
        expect((rule.when as { each?: boolean }).each).toBe(true);
        for (const fact of given.get(judged.judge)!.filter((f) => f.uid === o.metadata.uid && f.fact === judged.fact))
          out.push({
            uid: o.metadata.uid!,
            reason: d.reason,
            message: (d.message ?? "").replace(/\{\{fact:([A-Za-z][A-Za-z0-9-]*)\}\}/g, (_, n: string) => fact.values?.[n] ?? ""),
            needs: fact.needs ?? [],
          });
      }
    }
  }
  return out;
}

/**
 * The built-in agents' view of the mesh findings (`agentMeshProblems` of `mcp-diagnostics/mesh.ts`): the findings of
 * what was read, kept only when everything they rest on was read.
 */
function builtInReadProblems(world: KubeObject[], unread: Unread): Found[] {
  const read = world.filter((o) => !unread.includes(o.metadata.namespace ?? ""));
  return builtInProblems(read, unread).filter((p) => p.needs.every((n) => (n.namespace === undefined ? unread.length === 0 : !unread.includes(n.namespace))));
}

/** The built-in category's problems over the world, as the built-in store held the configuration. */
function builtInProblems(world: KubeObject[], unread: Unread = []): Found[] {
  const of = (group: string, kind: string) => world.filter((o) => o.kind === kind && groupOf(o) === group);
  const virtualServices = of("networking.istio.io", "VirtualService").map(parseVirtualService);
  const destinationRules = of("networking.istio.io", "DestinationRule").map(parseDestinationRule);
  // The Services of the namespaces the objects name, at most 40 (store.ts `serviceNamespaces`).
  const namespaces = new Set<string>();
  for (const vs of virtualServices) {
    namespaces.add(vs.namespace);
    for (const d of allDestinations(vs)) {
      const s = serviceOfHost(d.fqdn);
      if (s) namespaces.add(s.namespace);
    }
  }
  for (const dr of destinationRules) {
    const s = serviceOfHost(dr.fqdn);
    if (s) namespaces.add(s.namespace);
  }
  namespaces.delete("");
  const known = namespaces.size <= 40 ? namespaces : new Set<string>();
  const services = new Set(of("", "Service").map((s) => `${s.metadata.namespace}/${s.metadata.name}`));
  const input: AnalysisInput = {
    virtualServices,
    destinationRules,
    gateways: of("networking.istio.io", "Gateway").map(parseIstioGateway),
    serviceEntries: of("networking.istio.io", "ServiceEntry").map(parseServiceEntry),
    peerAuthentications: of("security.istio.io", "PeerAuthentication").map(parsePeerAuthentication),
    // A namespace whose Services were refused is not known (`services.forbidden`).
    serviceExists: (ns, name) => (known.has(ns) && !unread.includes(ns) ? services.has(`${ns}/${name}`) : undefined),
  };
  return meshProblems(input).map((p) => ({
    uid: p.uid,
    // What the built-in agents' view required read to keep the finding (`MeshProblem.needs`).
    needs: p.needs.map((n) => ({ kind: { group: n.kind.group, kind: n.kind.kind }, ...(n.namespace !== null ? { namespace: n.namespace } : {}), ...(n.name ? { name: n.name } : {}) })),
    reason: p.reason,
    message: (en as Record<string, string>)[`problem.${p.reason}`]!.replace(/\{\{(\w+)\}\}/g, (_, k: string) => p.params[k] ?? ""),
  }));
}

const sorted = (list: Found[]) => [...list].sort((a, b) => `${a.uid}|${a.reason}|${a.message}`.localeCompare(`${b.uid}|${b.reason}|${b.message}`));
const reasonsOf = (list: Found[]) => [...new Set(list.map((p) => p.reason))].sort();

const at = (day: number) => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
const vsAt = (ns: string, name: string, spec: unknown, day = 10) => obj(NET, "VirtualService", ns, name, spec, { creationTimestamp: at(day) });
const drAt = (ns: string, name: string, spec: unknown) => obj(NET, "DestinationRule", ns, name, spec);
const svc = (ns: string, name: string) => ({ apiVersion: "v1", kind: "Service", metadata: { namespace: ns, name, uid: `svc-${ns}-${name}` } }) as KubeObject;
const route = (...hosts: string[]) => ({ http: [{ route: hosts.map((h) => ({ destination: { host: h.split("#")[0], ...(h.includes("#") ? { subset: h.split("#")[1] } : {}) } })) }] });

/** The fixtures and variants of every reason, with what each rests on. */
function world(): KubeObject[] {
  return [
    ...fx.virtualServices!,
    ...fx.destinationRules!,
    ...fx.gateways!,
    ...fx.peerAuthentications!,
    ...fx.services!,
    svc("shop", "ratings"),
    svc("pay", "billing"),
    obj(NET, "Gateway", "shop", "public", {}),
    obj(NET, "ServiceEntry", "shop", "ext", { hosts: ["api.example.com", "*.wild.example.com"] }),
    obj(SEC, "PeerAuthentication", "istio-system", "mesh", { mtls: { mode: "STRICT" } }),
    // Unknown hosts: a short name, a full name, an external one, one a ServiceEntry covers (no problem).
    vsAt("shop", "unknown", { hosts: ["u"], ...route("nope", "gone.pay.svc.cluster.local", "httpbin.org", "api.example.com", "x.wild.example.com") }),
    // Subsets: of a host with no DestinationRule, and one the rule does not define.
    vsAt("shop", "subsets", { hosts: ["s"], ...route("ratings#v1", "reviews#v9", "reviews#v1") }),
    // Gateways: in another namespace, past the fifth, a short name that exists, `mesh`.
    vsAt("shop", "gateways", { hosts: ["g"], gateways: ["istio-ingress/gone", "public", "public", "public", "mesh", "sixth-gone", "istio-ingress/public"] }),
    // `*` on the sidecars: past the tenth host, with blanks; and on a gateway only (valid).
    vsAt("shop", "star-late", { hosts: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", " * "], gateways: ["public", "x", "y", "z", "w", "v", "u", "t", "s", "r", "mesh"] }),
    vsAt("shop", "star-gateway", { hosts: ["*"], gateways: ["public"] }),
    // Conflicts: two on the sidecars for one host, an older catch-all on a gateway.
    vsAt("pay", "first", { hosts: ["billing"], ...route("billing") }, 1),
    vsAt("pay", "second", { hosts: ["billing"], ...route("billing") }, 2),
    vsAt("shop", "catch-all", { hosts: ["shop.example.com"], gateways: ["public"], http: [{ route: [{ destination: { host: "web" } }] }] }, 1),
    vsAt("shop", "shadowed", { hosts: ["shop.example.com"], gateways: ["public"], http: [{ match: [{ uri: { prefix: "/a" } }], route: [{ destination: { host: "web" } }] }] }, 3),
    // TLS: SIMPLE toward STRICT workloads; ISTIO_MUTUAL is fine; a workload selector is not judged.
    drAt("pay", "simple", { host: "billing", trafficPolicy: { tls: { mode: "SIMPLE" } } }),
    drAt("pay", "mutual", { host: "billing", trafficPolicy: { tls: { mode: "ISTIO_MUTUAL" } } }),
    drAt("pay", "selected", { host: "billing", workloadSelector: { matchLabels: { app: "x" } }, trafficPolicy: { tls: { mode: "DISABLE" } } }),
  ];
}

describe("the problem rules, against the built-in category", () => {
  it("are one rule per reason and finding, each judged by the backend, in the main category", () => {
    expect(new Set(rules.map((r) => r.reason))).toEqual(
      new Set(["UnknownHost", "MissingDestinationRule", "MissingSubset", "MissingGateway", "InvalidVirtualService", "ConflictingVirtualService", "TlsConflict"]),
    );
    for (const r of rules) {
      expect(r.when.type, r.id).toBe("judged");
      expect((r as { category?: string }).category, r.id).toBeUndefined();
      expect((r as { graceMinutes?: number }).graceMinutes ?? 0).toBe(0);
    }
    expect(judgesOf.map((j) => j.id).sort()).toEqual([...JUDGE_IDS].sort());
    // Each judge reads what its engine reads, and declares every fact its rules use.
    for (const j of judgesOf) {
      const declared = JUDGES[j.id as JudgeId];
      const flags = (r: { optional?: boolean; partial?: boolean }) => [r.optional ?? false, r.partial ?? false];
      expect(j.reads.map((r) => [r.kind.group, r.kind.kind, r.paths, ...flags(r)])).toEqual(declared.reads.map((r) => [r.group, r.kind, [r.path], ...flags(r)]));
      expect(j.facts.map((f) => f.id)).toEqual(declared.reasons.map(factId));
      for (const reason of declared.reasons) {
        const fact = j.facts.find((f) => f.id === factId(reason));
        expect(fact?.values, `${j.id} ${reason}`).toEqual(REASON_VALUES[reason]);
        expect(rules.filter((r) => (r.when as { fact?: string }).fact === fact!.id)).toHaveLength(1);
      }
    }
  });

  it("say exactly what the built-in category said, with its messages, on the fixtures and every variant", async () => {
    const w = world();
    const want = builtInProblems(w);
    expect(reasonsOf(want)).toEqual(["ConflictingVirtualService", "InvalidVirtualService", "MissingDestinationRule", "MissingGateway", "MissingSubset", "TlsConflict", "UnknownHost"]);
    expect(want.length).toBeGreaterThan(12);
    expect(sorted(await extensionProblems(w))).toEqual(sorted(want));
  });

  it("the cases the declarative rules missed: a gateway in another namespace, past the fifth, `*` past the tenth and with blanks", async () => {
    const w = world();
    const found = (await extensionProblems(w)).map((p) => p.message);
    expect(found).toContain("Bound to gateway istio-ingress/gone, which does not exist.");
    expect(found).toContain("Bound to gateway shop/sixth-gone, which does not exist.");
    const late = w.find((o) => o.metadata.name === "star-late")!.metadata.uid;
    expect((await extensionProblems(w)).filter((p) => p.uid === late).map((p) => p.reason)).toEqual(["InvalidVirtualService"]);
  });

  it("judge no host missing where the objects name more than 40 namespaces, as the built-in store watched none then", async () => {
    const many = [...Array.from({ length: 41 }, (_, i) => vsAt(`ns${i}`, "v", { hosts: ["a"], ...route("gone") })), svc("ns0", "other")];
    expect(builtInProblems(many)).toEqual([]);
    expect(await extensionProblems(many)).toEqual([]);
    const few = many.slice(0, 3);
    expect(sorted(await extensionProblems(few))).toEqual(sorted(builtInProblems(few)));
    expect(await extensionProblems(few)).toHaveLength(3);
  });

  it("tell every finding of a reason on one object, in the built-in order", async () => {
    const many = [vsAt("shop", "many", { hosts: ["a"], ...route("g1", "g2", "g3", "g4", "g5", "g6", "g7") }), svc("shop", "a")];
    const built = builtInProblems(many);
    expect(built).toHaveLength(7);
    expect((await extensionProblems(many)).map((p) => p.message)).toEqual(built.map((p) => p.message));
  });

  it("judge where the cluster serves no ServiceEntries, DestinationRules or PeerAuthentications, as the built-in took them as empty; not without Gateways", async () => {
    const optional = (j: Judge) => j.reads.filter((r) => (r as { optional?: boolean }).optional).map((r) => `${j.id}:${r.kind.kind}`);
    expect(judgesOf.flatMap(optional)).toEqual(["hosts:DestinationRule", "hosts:ServiceEntry", "tls:PeerAuthentication"]);
    // Without those kinds the world is the same as with none of their objects: the built-in's answer.
    const w = world().filter((o) => !["ServiceEntry", "DestinationRule", "PeerAuthentication"].includes(o.kind!));
    expect(sorted(await extensionProblems(w))).toEqual(sorted(builtInProblems(w)));
  });

  it("an object's finding goes to the object the built-in named (the newer VirtualService, the DestinationRule)", async () => {
    const w = world();
    const by = new Map(w.map((o) => [o.metadata.uid, o.metadata.name]));
    const ext = await extensionProblems(w);
    expect(ext.filter((p) => p.reason === "ConflictingVirtualService").map((p) => by.get(p.uid)).sort()).toEqual(["second", "shadowed"]);
    expect(ext.filter((p) => p.reason === "TlsConflict").map((p) => by.get(p.uid)).sort()).toEqual(["reviews", "simple"]);
  });

  it("count on the Istio section, and give \"Only problems\" to VirtualServices and DestinationRules, as the built-in did", () => {
    // As the built-in counter, which counted the findings, not the objects.
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "istio", count: "problems", label: { one: en.problemsCount_one, other: en.problemsCount_other } }]);
    const judged = new Set(rules.map((r) => `${r.kind.group}/${r.kind.kind}`));
    expect([...judged].sort()).toEqual(["networking.istio.io/DestinationRule", "networking.istio.io/VirtualService"]);
    for (const k of manifest.contributes.kinds) expect((k as { problemWhen?: unknown }).problemWhen, k.kind).toBeUndefined();
  });

  it("a namespace whose Services could not be read is unknown, as the built-in took a refused namespace's Services", async () => {
    const w = world();
    for (const unread of [["pay"], ["shop"], ["pay", "shop", "istio-ingress"]]) {
      const want = builtInProblems(w, unread);
      expect(sorted(await extensionProblems(w, unread)), unread.join()).toEqual(sorted(want));
    }
    // Refused in the namespace of a missing Service: no UnknownHost of it, where all read finds one.
    const host = (list: Found[]) => list.filter((p) => p.message.includes("gone.pay.svc.cluster.local")).length;
    expect(host(await extensionProblems(w))).toBe(1);
    expect(host(await extensionProblems(w, ["pay"]))).toBe(0);
  });

  it("where whole namespaces could not be read, tell a finding only when all it rests on was read, as the built-in agents' view", async () => {
    const w = world();
    for (const unread of [["pay"], ["istio-ingress"], ["istio-system"], ["shop", "pay"]]) {
      const got = await extensionProblems(w, unread, "all");
      expect(sorted(got), unread.join()).toEqual(sorted(builtInReadProblems(w, unread)));
    }
    // Everything read: the built-in screen's findings, each one.
    expect(sorted(builtInReadProblems(w, []))).toEqual(sorted(builtInProblems(w)));
    // An unreadable gateway namespace: its gateway is not called missing (the built-in screen did, judging the refused
    // list as whole).
    const gone = (list: Found[]) => list.some((p) => p.message === "Bound to gateway istio-ingress/gone, which does not exist.");
    expect(gone(await extensionProblems(w, ["istio-ingress"], "all"))).toBe(false);
    expect(gone(builtInProblems(w.filter((o) => o.metadata.namespace !== "istio-ingress")))).toBe(true);
  });

  it("each finding says what it rests on, as the built-in agents' view required it read", async () => {
    const w = world();
    const want = builtInProblems(w);
    const got = await extensionProblems(w);
    const key = (p: Found) => `${p.uid}|${p.message}`;
    expect(new Map(got.map((p) => [key(p), p.needs]))).toEqual(new Map(want.map((p) => [key(p), p.needs])));
    // Something to rest on but the object for every reason judged across objects; the object alone for the host `*`.
    for (const p of got) expect(p.needs.length > 0, p.reason).toBe(p.reason !== "InvalidVirtualService");
    // Only kinds the judge reads, at most 20.
    for (const p of got) {
      const rule = rules.find((r) => r.reason === p.reason)!;
      const j = judgesOf.find((x) => x.id === (rule.when as { judge: string }).judge)!;
      expect(p.needs.length).toBeLessThanOrEqual(20);
      for (const n of p.needs) expect(j.reads.some((r) => r.kind.group === n.kind.group && r.kind.kind === n.kind.kind), `${p.reason} ${n.kind.kind}`).toBe(true);
    }
  });

  it("answer the judge calls recorded in fixtures/judge-calls.json, which the real runtime answered alike", async () => {
    for (const call of judgeCalls as { judge: JudgeId; params: { objects: JudgedInput[] }; answer: JudgedOutput[] }[])
      expect(JSON.parse(await handle(`problemJudge:${call.judge}`, JSON.stringify(call.params))), call.judge).toEqual(call.answer);
  });
});
