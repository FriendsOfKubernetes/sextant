// The model and the manifest's declarative parts. The manifest's problem rules, the kinds' "Only problems" and the
// columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run
// time so the type check stays inside the extension) and compared with the model they replace — the reading of
// Sextant's former built-in Traefik view (ADR-0108), ported unchanged — on its fixtures and variants of them. Where the
// extension API cannot say what the built-in said (README, "Requirements and limits"), the difference is pinned here.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import fixtures from "../fixtures/objects.json";
import {
  breaks,
  builtInProblems,
  checkRef,
  hostsOf,
  INGRESS_ROUTE,
  INGRESS_ROUTE_TCP,
  INGRESS_ROUTE_UDP,
  judge,
  LEGACY_GROUP,
  listsFor,
  lookupOf,
  middlewareRefs,
  middlewareType,
  MIDDLEWARE,
  nameKey,
  referencesOf,
  refOf,
  routeSpec,
  secretsOf,
  SERVERS_TRANSPORT,
  SERVERS_TRANSPORT_TCP,
  skipSecrets,
  TLS_OPTION,
  TLS_STORE,
  TRAEFIK_GROUP,
  TRAEFIK_KINDS,
  TRAEFIK_SERVICE,
  traefikServiceRefs,
  traefikServiceType,
  get,
  str,
  type NameList,
  type Ref,
  type Served,
} from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const fx = fixtures as unknown as Record<string, KubeObject> & { services: KubeObject[]; secrets: KubeObject[] };
const names = (list: { kind: string; name: string }[]) => list.map((r) => `${r.kind} ${r.name}`);
type Kind = { group: string; kind: string };

/** A list read in full, holding `objects`. */
const list = (objects: { namespace: string; name: string }[]): NameList => ({
  ready: true,
  error: false,
  forbidden: [],
  capped: false,
  namespaces: null,
  names: new Set(objects.map((o) => nameKey(o.namespace, o.name))),
});
const servedIn = (...groups: string[]): Served =>
  new Map(
    ["IngressRoute", "IngressRouteTCP", "IngressRouteUDP", "Middleware", "MiddlewareTCP", "TraefikService", "TLSOption", "TLSStore", "ServersTransport", "ServersTransportTCP"].map(
      (k) => [k, { own: groups.includes(TRAEFIK_GROUP), legacy: groups.includes(LEGACY_GROUP) }],
    ),
  );

/** A lookup over the fixtures (`gone`: names to treat as missing; `unread`: kinds whose lists are unknown). */
function fixtureLookup(gone: string[] = [], unread: string[] = []) {
  const objects = Object.values(fx)
    .flatMap((v) => (Array.isArray(v) ? v : typeof v === "object" ? [v] : []))
    .filter((o) => !gone.includes(o.metadata?.name ?? ""));
  return lookupOf(servedIn(TRAEFIK_GROUP), (group, kind) =>
    unread.includes(kind)
      ? undefined
      : list(objects.filter((o) => o.kind === kind && (o.apiVersion?.startsWith(`${group}/`) || (group === "" && !o.apiVersion?.includes("/")))).map((o) => ({ namespace: o.metadata.namespace ?? "", name: o.metadata.name }))),
  );
}

describe("the model, in the shapes of Traefik's types (ported from the built-in view)", () => {
  it("reads routes, their match rules, middlewares, services and TLS", () => {
    const spec = routeSpec(INGRESS_ROUTE, fx.ingressRoute!);
    expect(spec.entryPoints).toEqual(["websecure"]);
    expect(spec.routes.map((r) => [r.match, r.priority, names(r.middlewares), names(r.services)])).toEqual([
      ["Host(`foo.example.net`) && PathPrefix(`/bar`)", 10, ["Middleware secured"], ["Service foo"]],
      ["Host(`foo.example.net`) && PathPrefix(`/wrr`)", undefined, [], ["TraefikService wrr1"]],
      ["PathPrefix(`/dashboard`)", undefined, [], ["TraefikService api"]],
    ]);
    expect(spec.routes[2]!.services[0]!.provider).toBe("internal");
    expect(spec.tls).toMatchObject({ secretName: "supersecret", options: { kind: "TLSOption", name: "opt" }, domains: ["foo.example.net"], passthrough: false });
    expect(routeSpec(INGRESS_ROUTE_TCP, fx.tcpRoute!).tls?.passthrough).toBe(true);
    expect(routeSpec(INGRESS_ROUTE_UDP, fx.udpRoute!).routes[0]!.services.map((s) => [s.name, s.port])).toEqual([["foo", 8080]]);
  });

  it("finds exact hosts in Host and HostSNI rules (not regular expressions or *)", () => {
    expect(hostsOf("Host(`a.example.com`) || Host(`B.example.com`) && PathPrefix(`/x`)")).toEqual(["a.example.com", "b.example.com"]);
    expect(hostsOf('Host("a.example.com", "c.example.com")')).toEqual(["a.example.com", "c.example.com"]);
    expect(hostsOf("HostSNI(`*`)")).toEqual([]);
    expect(hostsOf("HostRegexp(`^.+\\.example\\.com$`)")).toEqual([]);
  });

  it("resolves a reference's namespace and provider as Traefik does", () => {
    expect(refOf("Middleware", "auth", undefined, "shop", "route")).toMatchObject({ namespace: "shop", crossNamespace: false });
    expect(refOf("Middleware", "auth", "infra", "shop", "route")).toMatchObject({ namespace: "infra", crossNamespace: true });
    expect(refOf("Middleware", "auth@file", "infra", "shop", "route")).toMatchObject({ name: "auth", provider: "file", namespace: "shop", crossNamespace: false });
  });

  it("lists every reference of the other kinds", () => {
    expect(names(traefikServiceRefs(fx.wrr!))).toEqual(["Service svc1", "TraefikService mirror1"]);
    expect(traefikServiceRefs(fx.mirror!).map((r) => [r.name, r.place, r.weight])).toEqual([
      ["svc1", "service", undefined],
      ["svc2", "mirror", 20],
    ]);
    expect(names(middlewareRefs(fx.chain!))).toEqual(["Middleware https-only", "Middleware known-ips", "Middleware auth-users"]);
    expect(names(middlewareRefs(fx.authUsers!))).toEqual(["Secret authsecret"]);
    expect(names(secretsOf(TLS_OPTION, fx.tlsOption!))).toEqual(["Secret client-ca"]);
    expect(names(secretsOf(TLS_STORE, fx.tlsStore!))).toEqual(["Secret default-certificate"]);
    expect(names(secretsOf(SERVERS_TRANSPORT, fx.transport!))).toEqual(["Secret foobar"]);
  });

  it("every reference of a route is listed once, in order", () => {
    expect(names(referencesOf(INGRESS_ROUTE, fx.ingressRoute!))).toEqual([
      "Service foo",
      "Middleware secured",
      "TraefikService wrr1",
      "TraefikService api",
      "Secret supersecret",
      "TLSOption opt",
    ]);
  });
});

describe("what the references find (ported from the built-in view)", () => {
  it("everything there: ok; api@internal always exists", () => {
    const lookup = fixtureLookup();
    // wrr1 is the fixture TraefikService `wrr`; its child mirror1 is not among the fixtures.
    expect(judge(INGRESS_ROUTE, fx.ingressRoute!, lookup).health).toBe("ok");
    expect(judge(TRAEFIK_SERVICE, fx.mirror!, lookup).health).toBe("ok");
  });

  it("a missing Middleware, Service, TLSOption or Secret breaks the object; a missing TLSStore or route TLS Secret does not", () => {
    for (const gone of ["secured", "foo", "opt"]) expect(judge(INGRESS_ROUTE, fx.ingressRoute!, fixtureLookup([gone])).health).toBe("failed");
    expect(judge(MIDDLEWARE, fx.authUsers!, fixtureLookup(["authsecret"])).health).toBe("failed");
    const noTls = judge(INGRESS_ROUTE, fx.ingressRoute!, fixtureLookup(["supersecret"]));
    expect(noTls.health).toBe("partial");
    expect(noTls.checks.find((c) => c.ref.kind === "Secret")?.state).toBe("missing");
    const withStore = copy(fx.ingressRoute!);
    (withStore.spec as { tls: Record<string, unknown> }).tls.store = { name: "nostore" };
    const j = judge(INGRESS_ROUTE, withStore, fixtureLookup());
    expect(j.health).toBe("partial");
    expect(j.checks.find((c) => c.ref.kind === "TLSStore")?.state).toBe("missing");
  });

  it("another namespace, another provider or an unread list is partial, never failed", () => {
    const lookup = fixtureLookup();
    expect(checkRef(refOf("Middleware", "secured", "default", "elsewhere", "route"), lookup)).toBe("crossNamespace");
    expect(checkRef(refOf("Middleware", "x@file", undefined, "default", "route"), lookup)).toBe("otherProvider");
    expect(judge(INGRESS_ROUTE, fx.ingressRoute!, fixtureLookup([], ["Middleware"])).health).toBe("partial");
  });

  it("a route Traefik skips by its shape, and a service kind it does not know", () => {
    const bad = copy(fx.ingressRoute!);
    const routes = (bad.spec as { routes: Record<string, unknown>[] }).routes;
    routes[0]!.match = "";
    routes[1]!.kind = "Regex";
    expect(judge(INGRESS_ROUTE, bad, fixtureLookup()).issues).toEqual([
      { type: "emptyMatch", route: 0 },
      { type: "unsupportedKind", route: 1, value: "Regex" },
    ]);
    const badKind = copy(fx.ingressRoute!);
    (badKind.spec as { routes: { services: Record<string, unknown>[] }[] }).routes[0]!.services[0]!.kind = "ExternalName";
    expect(judge(INGRESS_ROUTE, badKind, fixtureLookup()).checks.find((c) => c.ref.name === "foo")?.state).toBe("badKind");
  });

  it("where both groups are served: a target only in the old group is 'legacy only' from traefik.io, found from the old group", () => {
    const lookup = lookupOf(servedIn(TRAEFIK_GROUP, LEGACY_GROUP), (group, kind) =>
      kind === "Middleware" ? list(group === LEGACY_GROUP ? [{ namespace: "default", name: "secured" }] : []) : list([]),
    );
    const secured = refOf("Middleware", "secured", undefined, "default", "route");
    expect(checkRef(secured, lookup)).toBe("legacyOnly");
    expect(checkRef(secured, lookup, true)).toBe("found");
    const both = lookupOf(servedIn(TRAEFIK_GROUP, LEGACY_GROUP), (_, kind) => list(kind === "Middleware" ? [{ namespace: "default", name: "secured" }] : []));
    const [check] = judge(INGRESS_ROUTE, fx.ingressRoute!, both, (r) => r.kind !== "Middleware").checks;
    expect(check).toMatchObject({ state: "found", legacyToo: true });
  });

  it("the details watch, for one object, each kind its references name in the group the lookup reads, in their namespaces", () => {
    expect(listsFor(INGRESS_ROUTE, fx.ingressRoute!, servedIn(TRAEFIK_GROUP))).toEqual([
      { group: "", kind: "Service", namespaces: ["default"], waited: true },
      { group: TRAEFIK_GROUP, kind: "Middleware", namespaces: ["default"], waited: true },
      { group: TRAEFIK_GROUP, kind: "TraefikService", namespaces: ["default"], waited: true },
      { group: "", kind: "Secret", namespaces: ["default"], waited: false },
      { group: TRAEFIK_GROUP, kind: "TLSOption", namespaces: ["default"], waited: true },
    ]);
    expect(listsFor(INGRESS_ROUTE, fx.ingressRoute!, servedIn(TRAEFIK_GROUP, LEGACY_GROUP)).filter((w) => w.kind === "Middleware").map((w) => w.group)).toEqual([TRAEFIK_GROUP, LEGACY_GROUP]);
  });
});

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Lookup {
  group: string;
  kind: string;
  name: string;
  namespace?: string;
  anyOf?: string;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  graceMs?: number;
  notify: boolean;
  lookups?: Lookup[];
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
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
let columns: Columns;
let formatList: (items: string[]) => string;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  ({ formatList } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/format.ts"))) as { formatList: (items: string[]) => string });
});

const NOW = Date.parse("2026-11-01T12:00:00Z");
const holdsNow = (condition: unknown, obj: KubeObject) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && (v.activeFrom === undefined || v.activeFrom <= NOW) && (v.until === undefined || v.until > NOW);
};

type Rule = (typeof manifest.contributes.problems)[number];
const rules = manifest.contributes.problems as Rule[];

// ---------- The world the variants are judged in ----------

/** The objects that exist, by kind (with its group): `namespace/name`, every list read in full. */
type World = Map<string, Set<string>>;
const NAMESPACES = ["default", "other"];
function worldOf(group: string): World {
  const world: World = new Map();
  const add = (g: string, kind: string, names: string[]) => {
    const set = world.get(`${g}/${kind}`) ?? new Set<string>();
    for (const ns of NAMESPACES) for (const n of names) set.add(nameKey(ns, n));
    world.set(`${g}/${kind}`, set);
  };
  add("", "Service", ["foo", "svc1", "svc2"]);
  add(group, "TraefikService", ["ts1", "wrr1", "mirror1"]);
  add(group, "Middleware", ["secured", "https-only", "known-ips", "auth-users"]);
  add(group, "MiddlewareTCP", []);
  add(group, "TLSOption", ["opt"]);
  add(group, "TLSStore", []);
  add(group, "ServersTransport", ["st-ok"]);
  add(group, "ServersTransportTCP", []);
  add(group, "IngressRoute", ["parent"]);
  return world;
}
const lookupIn = (world: World, group: string) =>
  lookupOf(servedIn(group), (g, kind) => ({ ready: true, error: false, forbidden: [], capped: false, namespaces: null, names: world.get(`${g}/${kind}`) ?? new Set<string>() }));

/** A broken reference: its kind, namespace and name. */
const triple = (kind: string, namespace: string, name: string) => `${kind} ${namespace}/${name}`;

/** Where in its object a varied reference is: the place the readings tell apart for what the rules cover. */
type Loc = "routes" | "tcpRoutes" | "udpRoutes" | "weighted" | "hrw" | "mirroring" | "mirrors" | "failover" | "fallback" | "errors" | "other" | `${MwLoc}Mw`;
type MwLoc = "weighted" | "hrw" | "mirroring" | "mirrors" | "failover" | "errors";

/**
 * Whether the rules judge a broken reference the built-in found (README, "Requirements and limits"): every reference
 * but a service kind Traefik does not know and a route service's own middlewares; in the old group (60 rules in all)
 * not the TraefikServices and transports of mirrors and failover services, nor the middlewares of load balancers other
 * than weighted services.
 */
function covered(ref: Ref, loc: Loc, group: string): boolean {
  if (ref.badKind) return false;
  const io = group === TRAEFIK_GROUP;
  if (ref.place === "middleware") return loc === "weightedMw" || (io && loc.endsWith("Mw"));
  // The old group never had ServersTransportTCP (the built-in called every such reference of it missing); an
  // IngressRouteUDP's services name no servers transport in Traefik's CRD, the built-in read one all the same.
  if (ref.kind === "ServersTransportTCP") return loc === "tcpRoutes" && io;
  if (!io && (ref.kind === "TraefikService" || ref.kind === "ServersTransport") && ["mirrors", "failover", "fallback"].includes(loc)) return false;
  return true;
}

/** The built-in category's problems of `obj`: the broken references (those the rules cover, else all) and skipped routes. */
function builtIn(kind: Kind, obj: KubeObject, world: World, loc: Loc): { broken: string[]; uncovered: string[]; skipped: boolean; refs: string[] } {
  const judgement = judge(kind, obj, lookupIn(world, kind.group), skipSecrets);
  const broken = judgement.checks.filter(breaks);
  const problems = builtInProblems(obj.metadata.namespace ?? "", judgement);
  return {
    broken: [...new Set(broken.filter((c) => covered(c.ref, loc, kind.group)).map((c) => triple(c.ref.kind, c.ref.namespace, c.ref.name)))].sort(),
    uncovered: [...new Set(broken.filter((c) => !covered(c.ref, loc, kind.group)).map((c) => triple(c.ref.kind, c.ref.namespace, c.ref.name)))].sort(),
    skipped: problems.some((p) => p.reason === "SkippedRoute"),
    refs: problems.find((p) => p.reason === "MissingReference")?.refs ?? [],
  };
}

const MISSING = /^Refers to objects that do not exist: (\S+) (.+)\. Traefik skips what depends on them\.$/;

/**
 * The extension's problems of `obj`, as the window keeps them (`judgeAcross`, every list read in full): a rule's single
 * lookups must all be missing, of each list at least one; `{{missing}}` names the missing ones (`namespace/name` where
 * another namespace) in the UI language's list.
 */
function extension(kind: Kind, obj: KubeObject, world: World): { broken: string[]; skipped: boolean; messages: string[] } {
  const ns = obj.metadata.namespace ?? "";
  const broken = new Set<string>();
  const messages: string[] = [];
  let skipped = false;
  for (const rule of rules.filter((r) => r.kind.group === kind.group && r.kind.kind === kind.kind)) {
    // `notify` left out: Rust reads it as true (`#[serde(default = "yes")]`).
    for (const d of engine.detectRule({ notify: true, ...rule }, obj)) {
      expect(d.notify).toBe(true);
      expect((rule as { notify?: boolean }).notify).toBeUndefined();
      expect(d.graceMs).toBe(2 * 60_000);
      if (d.reason === "SkippedRoute") {
        expect(d.group).toBe("skipped-route");
        expect(d.message).toBe("Traefik skips some of its routes: an empty match rule or a kind other than Rule.");
        skipped = true;
        continue;
      }
      expect(d.reason).toBe("MissingReference");
      expect(d.group).toBe("missing-reference");
      const gone = (l: Lookup) => !world.get(`${l.group}/${l.kind}`)?.has(nameKey(l.namespace ?? ns, l.name));
      const lookups = d.lookups ?? [];
      const single = lookups.filter((l) => l.anyOf === undefined);
      const listed = lookups.filter((l) => l.anyOf !== undefined);
      if (!single.every(gone)) continue;
      const missing = listed.filter(gone);
      if (listed.length > 0 && missing.length === 0) continue;
      for (const l of [...single, ...missing]) broken.add(triple(l.kind, l.namespace ?? ns, l.name));
      messages.push((d.message ?? "").split("{{missing}}").join(formatList([...new Set(missing.map((l) => (l.namespace && l.namespace !== ns ? `${l.namespace}/${l.name}` : l.name)))])));
    }
  }
  return { broken: [...broken].sort(), skipped, messages };
}

const asGroup = (obj: KubeObject, group: string): KubeObject => ({ ...copy(obj), apiVersion: `${group}/v1alpha1` });

// ---------- Variants ----------

/** A load balancer spec in every shape the readings tell apart. */
function balancers(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of ["svc1", "ts1", "gone", "api@internal", "x@file", "", undefined]) {
    for (const kind of [undefined, "", "Service", "TraefikService", "ExternalName"]) {
      for (const namespace of [undefined, "", "default", "other"]) {
        for (const serversTransport of [undefined, "", "st-ok", "st-gone", "t@file"]) {
          const lb: Record<string, unknown> = { port: 80 };
          if (name !== undefined) lb.name = name;
          if (kind !== undefined) lb.kind = kind;
          if (namespace !== undefined) lb.namespace = namespace;
          if (serversTransport !== undefined) lb.serversTransport = serversTransport;
          // Another provider's service with a namespace and a transport: pinned apart (the transport's namespace).
          if (name?.includes("@") && namespace === "other" && serversTransport) continue;
          out.push(lb);
        }
      }
    }
  }
  return out;
}

/** A reference to a middleware, a parent or a chained middleware in every shape. */
function plainRefs(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of ["secured", "parent", "gone", "x@file", "", undefined]) {
    for (const namespace of [undefined, "", "default", "other"]) {
      const ref: Record<string, unknown> = {};
      if (name !== undefined) ref.name = name;
      if (namespace !== undefined) ref.namespace = namespace;
      out.push(ref);
    }
  }
  return out;
}

type Variant = [label: string, kind: string, obj: KubeObject, loc: Loc];

/** Objects with one reference varied, beside found ones (two broken ones in one list are named together). */
function variants(): Variant[] {
  const out: Variant[] = [];
  const route = (base: KubeObject, lb: Record<string, unknown>) => {
    const o = copy(base);
    const routes = (o.spec as { routes: { services: Record<string, unknown>[] }[] }).routes;
    routes[0]!.services = [lb, { name: "foo", port: 80 }];
    if (routes[1]) routes[1].services.push({ ...lb, port: 81 });
    return o;
  };
  for (const lb of balancers()) {
    const label = JSON.stringify(lb);
    out.push([`route ${label}`, "IngressRoute", route(fx.ingressRoute!, lb), "routes"]);
    out.push([`tcp route ${label}`, "IngressRouteTCP", route(fx.tcpRoute!, lb), "tcpRoutes"]);
    out.push([`udp route ${label}`, "IngressRouteUDP", route(fx.udpRoute!, lb), "udpRoutes"]);
    const weighted = copy(fx.wrr!);
    (weighted.spec as { weighted: { services: unknown[] } }).weighted.services.push(lb);
    out.push([`weighted ${label}`, "TraefikService", weighted, "weighted"]);
    const hrw = copy(fx.wrr!);
    hrw.spec = { highestRandomWeight: { services: [{ name: "svc2", port: 80 }, lb] } };
    out.push([`hrw ${label}`, "TraefikService", hrw, "hrw"]);
    const mirroring = copy(fx.mirror!);
    (mirroring.spec as { mirroring: Record<string, unknown> }).mirroring = { ...lb, mirrors: [{ name: "svc2", port: 80, percent: 20 }] };
    out.push([`mirroring ${label}`, "TraefikService", mirroring, "mirroring"]);
    const mirrors = copy(fx.mirror!);
    (mirrors.spec as { mirroring: { mirrors: unknown[] } }).mirroring.mirrors.push({ ...lb, percent: 10 });
    out.push([`mirrors ${label}`, "TraefikService", mirrors, "mirrors"]);
    const failover = copy(fx.mirror!);
    failover.spec = { failover: { service: lb, fallback: { name: "svc2", port: 80 } } };
    out.push([`failover ${label}`, "TraefikService", failover, "failover"]);
    const fallback = copy(fx.mirror!);
    fallback.spec = { failover: { service: { name: "svc1", port: 80 }, fallback: lb } };
    out.push([`fallback ${label}`, "TraefikService", fallback, "fallback"]);
    const errors = copy(fx.httpsOnly!);
    errors.spec = { errors: { status: ["500-599"], query: "/{status}.html", service: lb } };
    out.push([`errors ${label}`, "Middleware", errors, "errors"]);
  }
  for (const ref of plainRefs()) {
    const label = JSON.stringify(ref);
    const mw = copy(fx.ingressRoute!);
    (mw.spec as { routes: { middlewares?: unknown[] }[] }).routes[1]!.middlewares = [{ name: "https-only" }, ref];
    out.push([`route middleware ${label}`, "IngressRoute", mw, "other"]);
    const tcpMw = copy(fx.tcpRoute!);
    (tcpMw.spec as { routes: { middlewares?: unknown[] }[] }).routes[0]!.middlewares = [ref];
    out.push([`tcp route middleware ${label}`, "IngressRouteTCP", tcpMw, "other"]);
    // A load balancer's own middlewares, at each place (the load balancer in the object's namespace).
    const lb = { name: "svc1", port: 80, middlewares: [{ name: "secured" }, ref] };
    const places: [MwLoc, string, KubeObject][] = [
      ["weighted", "TraefikService", { ...copy(fx.wrr!), spec: { weighted: { services: [lb, { name: "svc2", port: 80 }] } } }],
      ["hrw", "TraefikService", { ...copy(fx.wrr!), spec: { highestRandomWeight: { services: [{ name: "svc2", port: 80 }, lb] } } }],
      ["mirroring", "TraefikService", { ...copy(fx.mirror!), spec: { mirroring: { ...lb, mirrors: [{ name: "svc2", port: 80, percent: 20 }] } } }],
      ["mirrors", "TraefikService", { ...copy(fx.mirror!), spec: { mirroring: { name: "svc2", port: 80, mirrors: [{ ...lb, percent: 20 }] } } }],
      ["failover", "TraefikService", { ...copy(fx.mirror!), spec: { failover: { service: { name: "svc2", port: 80 }, fallback: lb } } }],
      ["errors", "Middleware", { ...copy(fx.httpsOnly!), spec: { errors: { status: ["500"], query: "/", service: lb } } }],
    ];
    for (const [where, kind, obj] of places) out.push([`${where} service middleware ${label}`, kind, copy(obj), `${where}Mw`]);
    const parent = copy(fx.ingressRoute!);
    (parent.spec as Record<string, unknown>).parentRefs = [ref, { name: "parent" }];
    out.push([`parent ${label}`, "IngressRoute", parent, "other"]);
    const chain = copy(fx.chain!);
    (chain.spec as { chain: { middlewares: unknown[] } }).chain.middlewares.push(ref);
    out.push([`chain ${label}`, "Middleware", chain, "other"]);
    for (const [kind, base] of [
      ["IngressRoute", fx.ingressRoute!],
      ["IngressRouteTCP", fx.tcpRoute!],
    ] as const) {
      const options = copy(base);
      const spec = options.spec as { tls?: Record<string, unknown> };
      spec.tls = { ...(spec.tls ?? {}), options: ref.name === "secured" ? { ...ref, name: "opt" } : ref };
      out.push([`${kind} tls options ${label}`, kind, options, "other"]);
    }
  }
  for (const [kind, base] of [
    ["IngressRoute", fx.ingressRoute!],
    ["IngressRouteTCP", fx.tcpRoute!],
  ] as const) {
    for (const match of ["Host(`a`)", "", undefined]) {
      for (const routeKind of [undefined, "", "Rule", "Regex"]) {
        const o = copy(base);
        const routes = (o.spec as { routes: Record<string, unknown>[] }).routes;
        if (match === undefined) delete routes[0]!.match;
        else routes[0]!.match = match;
        if (routeKind === undefined) delete routes[0]!.kind;
        else routes[0]!.kind = routeKind;
        out.push([`${kind} route match ${String(match)} kind ${String(routeKind)}`, kind, o, "other"]);
      }
    }
    const none = copy(base);
    delete (none.spec as Record<string, unknown>).routes;
    out.push([`${kind} without routes`, kind, none, "other"]);
  }
  return out;
}

describe("the problem rules, against the built-in category `traefik`", () => {
  it("are in the extension's own opt-in category, counted on the section in the built-in counter's words", () => {
    expect(manifest.contributes.problemCategories).toEqual([{ id: "traefik", title: "Traefik references", optIn: true }]);
    for (const rule of rules) expect(rule.category).toBe("traefik");
    expect(manifest.contributes.sectionBadges).toEqual([
      { section: "traefik", label: { one: "{{count}} Traefik object has a broken reference", other: "{{count}} Traefik objects have a broken reference" } },
    ]);
    expect(rules).toHaveLength(60);
    // The rules judge the kinds the built-in found problems of, in both groups.
    const judged = new Set(rules.map((r) => `${r.kind.group}/${r.kind.kind}`));
    expect([...judged].sort()).toEqual(
      ["IngressRoute", "IngressRouteTCP", "IngressRouteUDP", "Middleware", "TraefikService"].flatMap((k) => [`${TRAEFIK_GROUP}/${k}`, `${LEGACY_GROUP}/${k}`]).sort(),
    );
  });

  for (const group of [TRAEFIK_GROUP, LEGACY_GROUP]) {
    it(`find every broken reference the built-in found on ${group}'s objects that the rules cover, in any namespace`, () => {
      const world = worldOf(group);
      let problems = 0;
      let uncovered = 0;
      let crossNamespace = 0;
      for (const [label, kindName, base, loc] of variants()) {
        const obj = asGroup(base, group);
        const kind = { group, kind: kindName };
        const want = builtIn(kind, obj, world, loc);
        const got = extension(kind, obj, world);
        expect(got.broken, label).toEqual(want.broken);
        expect(got.skipped, label).toBe(want.skipped);
        if (want.broken.length > 0) problems++;
        if (want.broken.some((b) => b.includes(" other/"))) crossNamespace++;
        if (want.uncovered.length > 0) uncovered++;
      }
      expect(problems).toBeGreaterThan(1500);
      expect(crossNamespace).toBeGreaterThan(300);
      // What the rules leave out: unknown service kinds.
      expect(uncovered).toBeGreaterThan(100);
    });
  }

  it("name what is missing in the built-in message's words", () => {
    const world = worldOf(TRAEFIK_GROUP);
    const route = copy(fx.udpRoute!);
    (route.spec as { routes: { services: unknown[] }[] }).routes[0]!.services = [{ name: "gone-a", port: 1 }, { name: "foo", port: 1 }, { name: "gone-b", port: 1 }];
    expect(builtIn(INGRESS_ROUTE_UDP, route, world, "udpRoutes").refs).toEqual(["Service gone-a", "Service gone-b"]);
    expect(extension(INGRESS_ROUTE_UDP, route, world).messages).toEqual([`Refers to objects that do not exist: Service ${formatList(["gone-a", "gone-b"])}. Traefik skips what depends on them.`]);
    // Another namespace as `namespace/name`, as the built-in wrote it.
    const cross = copy(fx.chain!);
    (cross.spec as { chain: { middlewares: unknown[] } }).chain.middlewares = [{ name: "gone", namespace: "other" }];
    expect(builtIn(MIDDLEWARE, cross, world, "other").refs).toEqual(["Middleware other/gone"]);
    expect(extension(MIDDLEWARE, cross, world).messages).toEqual(["Refers to objects that do not exist: Middleware other/gone. Traefik skips what depends on them."]);
    for (const [label, kindName, base, loc] of variants()) {
      const kind = { group: TRAEFIK_GROUP, kind: kindName };
      for (const message of extension(kind, base, world).messages) {
        const m = MISSING.exec(message);
        expect(m, `${label}: ${message}`).not.toBeNull();
        // Every named reference is one the built-in named broken, of the kind the message says.
        const named = builtIn(kind, base, world, loc).broken;
        for (const name of m![2]!.split(/, | and /)) {
          const qualified = name.includes("/") ? name : `${base.metadata.namespace}/${name}`;
          // A TLS option's message names it without its namespace (pinned below).
          if (m![1] === "TLSOption") expect(named.some((n) => n.startsWith("TLSOption ") && n.endsWith(`/${name}`)), `${label}: ${message}`).toBe(true);
          else expect(named, `${label}: ${message}`).toContain(`${m![1]} ${qualified}`);
        }
      }
    }
  });

  it("find nothing on the fixtures, where everything they name exists", () => {
    for (const [key, obj] of Object.entries(fx)) {
      if (Array.isArray(obj) || typeof obj !== "object") continue;
      const def = TRAEFIK_KINDS.find((d) => d.kind.kind === obj.kind && d.kind.group === TRAEFIK_GROUP)!;
      expect(extension(def.kind, obj, worldOf(TRAEFIK_GROUP)), key).toEqual({ broken: [], skipped: false, messages: [] });
    }
  });

  it("differ where the API cannot say it", () => {
    const world = worldOf(TRAEFIK_GROUP);
    // A route service's own middlewares (a list in a list of a list) and an unknown service kind: the built-in found
    // them, the rules do not.
    const route = copy(fx.ingressRoute!);
    const routes = (route.spec as { routes: { services: Record<string, unknown>[] }[] }).routes;
    routes[0]!.services[0]!.middlewares = [{ name: "gone-mw" }];
    routes[1]!.services[0]!.kind = "ExternalName";
    expect(builtIn(INGRESS_ROUTE, route, world, "routes").uncovered).toEqual(["Middleware default/gone-mw", "Service default/wrr1"]);
    expect(extension(INGRESS_ROUTE, route, world).broken).toEqual([]);
    // In the old group (60 rules in all), a mirroring service's own middlewares and a failover's TraefikService are
    // left to the details; in traefik.io they are judged.
    const mirror = copy(fx.mirror!);
    (mirror.spec as { mirroring: Record<string, unknown> }).mirroring.middlewares = [{ name: "gone-mw" }];
    const failover = copy(fx.mirror!);
    failover.spec = { failover: { service: { name: "gone-ts", kind: "TraefikService" }, fallback: { name: "svc1", port: 80 } } };
    const oldWorld = worldOf(LEGACY_GROUP);
    const legacy = { group: LEGACY_GROUP, kind: "TraefikService" };
    expect(builtIn(legacy, asGroup(mirror, LEGACY_GROUP), oldWorld, "mirroringMw").uncovered).toEqual(["Middleware default/gone-mw"]);
    expect(extension(legacy, asGroup(mirror, LEGACY_GROUP), oldWorld).broken).toEqual([]);
    expect(extension(TRAEFIK_SERVICE, mirror, world).broken).toEqual(["Middleware default/gone-mw"]);
    expect(builtIn(legacy, asGroup(failover, LEGACY_GROUP), oldWorld, "failover").uncovered).toEqual(["TraefikService default/gone-ts"]);
    expect(extension(legacy, asGroup(failover, LEGACY_GROUP), oldWorld).broken).toEqual([]);
    expect(extension(TRAEFIK_SERVICE, failover, world).broken).toEqual(["TraefikService default/gone-ts"]);
    // A weighted service's middlewares are looked up in the namespace they name, else the TraefikService's; the built-in
    // took the service's namespace for one naming none.
    const weighted = copy(fx.wrr!);
    (weighted.spec as { weighted: { services: Record<string, unknown>[] } }).weighted.services[0] = { name: "svc1", namespace: "other", port: 80, middlewares: [{ name: "only-here" }] };
    const here2 = new Map(world);
    here2.set(`${TRAEFIK_GROUP}/Middleware`, new Set([...world.get(`${TRAEFIK_GROUP}/Middleware`)!, nameKey("default", "only-here")]));
    expect(builtIn(TRAEFIK_SERVICE, weighted, here2, "weightedMw").broken).toEqual(["Middleware other/only-here"]);
    expect(extension(TRAEFIK_SERVICE, weighted, here2).broken).toEqual([]);
    // Another provider's service naming a namespace: the built-in looked its transport up in the object's namespace
    // (the service's own namespace was not used for another provider's name); the item's namespace is used here.
    const provider = copy(fx.ingressRoute!);
    (provider.spec as { routes: { services: Record<string, unknown>[] }[] }).routes[0]!.services = [{ name: "api@internal", namespace: "other", serversTransport: "gone-st" }];
    expect(builtIn(INGRESS_ROUTE, provider, world, "routes").broken).toEqual(["ServersTransport default/gone-st"]);
    expect(extension(INGRESS_ROUTE, provider, world).broken).toEqual(["ServersTransport other/gone-st"]);
    // One problem per kind of reference and place: the built-in had one per object naming every broken reference.
    const two = copy(fx.ingressRoute!);
    const tr = (two.spec as { routes: { services: Record<string, unknown>[]; middlewares?: unknown[] }[] }).routes;
    tr[0]!.services[0]!.name = "gone";
    tr[0]!.middlewares = [{ name: "gone" }];
    expect(builtIn(INGRESS_ROUTE, two, world, "routes").refs).toEqual(["Service gone", "Middleware gone"]);
    expect(extension(INGRESS_ROUTE, two, world).messages).toHaveLength(2);
    // A reference naming its own namespace is written by its name alone, as the built-in wrote it.
    const own = copy(fx.ingressRoute!);
    (own.spec as { routes: { middlewares: Record<string, unknown>[] }[] }).routes[0]!.middlewares[0]!.name = "gone";
    expect(builtIn(INGRESS_ROUTE, own, world, "routes").refs).toEqual(["Middleware gone"]);
    expect(extension(INGRESS_ROUTE, own, world).messages).toEqual(["Refers to objects that do not exist: Middleware gone. Traefik skips what depends on them."]);
    // A missing TLS option in another namespace: its message names it without the namespace (`{{missing}}` is lists only).
    const opt = copy(fx.ingressRoute!);
    (opt.spec as { tls: Record<string, unknown> }).tls.options = { name: "gone", namespace: "other" };
    expect(builtIn(INGRESS_ROUTE, opt, world, "other").refs).toEqual(["TLSOption other/gone"]);
    expect(extension(INGRESS_ROUTE, opt, world).messages).toEqual(["Refers to objects that do not exist: TLSOption gone. Traefik skips what depends on them."]);
    // The built-in message numbered the skipped routes; the rule's says "some of its routes".
    const skipped = copy(fx.ingressRoute!);
    (skipped.spec as { routes: Record<string, unknown>[] }).routes[1]!.match = "";
    const rule = rules.find((r) => r.id === "ir-k")!;
    expect(builtInProblems("default", judge(INGRESS_ROUTE, skipped, lookupIn(world, TRAEFIK_GROUP), skipSecrets))).toEqual([{ reason: "SkippedRoute", routes: ["2"] }]);
    expect(engine.detectRule(rule, skipped).map((d) => d.message)).toEqual(["Traefik skips some of its routes: an empty match rule or a kind other than Rule."]);
    // A match of blanks only: the built-in trimmed it; a match step compares the text as written.
    const blank = copy(fx.ingressRoute!);
    (blank.spec as { routes: Record<string, unknown>[] }).routes[0]!.match = "  ";
    expect(builtIn(INGRESS_ROUTE, blank, world, "other").skipped).toBe(true);
    expect(engine.detectRule(rule, blank)).toEqual([]);
    // Both groups served, the target only in the old one: the built-in called it "legacy only" (open); the traefik.io
    // rule looks only in traefik.io.
    const wrr = copy(fx.wrr!);
    (wrr.spec as { weighted: { services: unknown[] } }).weighted.services = [{ name: "old-ts", kind: "TraefikService" }];
    const both = lookupOf(servedIn(TRAEFIK_GROUP, LEGACY_GROUP), (g, kind) => list(kind === "TraefikService" && g === LEGACY_GROUP ? [{ namespace: "default", name: "old-ts" }] : []));
    expect(judge(TRAEFIK_SERVICE, wrr, both, skipSecrets).checks.map((c) => c.state)).toEqual(["legacyOnly"]);
    expect(extension(TRAEFIK_SERVICE, wrr, world).broken).toEqual(["TraefikService default/old-ts"]);
  });
});

// ---------- The kinds and "Only problems" ----------

describe("the kinds, against the built-in registrations", () => {
  const kinds = manifest.contributes.kinds;

  it("list both groups' kinds in the section `traefik`, with the built-in labels, icons and orders, without printer columns", () => {
    expect(manifest.contributes.sections).toEqual([{ section: "traefik", title: "Traefik", icon: "traefik", after: "linkerd" }]);
    expect(kinds.map((k) => [k.group, k.kind, k.order])).toEqual(TRAEFIK_KINDS.map((d) => [d.kind.group, d.kind.kind, d.order]));
    for (const k of kinds) {
      expect(k.section).toBe("traefik");
      expect(k.printerColumns).toBe(false);
    }
    const icon = (kind: string) => kinds.find((k) => k.kind === kind)!.icon;
    expect(["IngressRoute", "IngressRouteTCP", "IngressRouteUDP"].map(icon)).toEqual(["traefikRoute", "traefikRoute", "traefikRoute"]);
    expect(["Middleware", "MiddlewareTCP", "TraefikService"].map(icon)).toEqual(["traefikMiddleware", "traefikMiddleware", "traefikService"]);
    expect(["TLSOption", "TLSStore", "ServersTransport", "ServersTransportTCP"].map(icon)).toEqual(["tlsCertificates", "tlsCertificates", "config", "config"]);
  });

  it("offer \"Only problems\" where the built-in did — every kind but MiddlewareTCP — holding for none where no rule judges it", () => {
    const judged = new Set(rules.map((r) => `${r.kind.group}/${r.kind.kind}`));
    const objects = Object.values(fx).filter((o): o is KubeObject => !Array.isArray(o) && typeof o === "object");
    for (const k of kinds) {
      const key = `${k.group}/${k.kind}`;
      const filter = (k as { problemWhen?: unknown }).problemWhen;
      if (k.kind === "MiddlewareTCP") {
        expect(filter, key).toBeUndefined();
        expect(judged.has(key), key).toBe(false);
      } else if (judged.has(key)) expect(filter, key).toBeUndefined();
      else {
        // The built-in judged only their Secrets (TLS options, stores, transports), never for problems; UDP routes
        // name Services only in lists (README).
        expect(filter, key).toBeDefined();
        for (const o of objects) expect(holdsNow(filter, o), `${key} ${o.metadata.name}`).toBe(false);
      }
    }
  });

  it("the details section `traefik` on every kind of both groups, untitled, in place of the generic fields (order 20)", () => {
    expect(manifest.contributes.detailsSections[0]).toEqual(
      { id: "traefik", title: "Traefik", kinds: TRAEFIK_KINDS.map((d) => ({ group: d.kind.group, kind: d.kind.kind })), placement: "section", order: 20, heading: false },
    );
  });

  it("the route TLS Secret's certificate as Sextant's own view, after it (order 21), on the routes that name one", () => {
    const routes = ["traefik.io", "traefik.containo.us"].flatMap((group) => ["IngressRoute", "IngressRouteTCP"].map((kind) => ({ group, kind })));
    expect(manifest.contributes.detailsSections[1]).toEqual(
      { id: "certificate", title: "Certificate", kinds: routes, placement: "section", order: 21, certificate: { secretNamePath: ".spec.tls.secretName" } },
    );
    expect(manifest.contributes.detailsSections).toHaveLength(2);
  });

  it("read only what the built-in read: the Traefik kinds, Services and Secrets (metadata only), nothing changed", () => {
    expect(manifest.permissions.rules).toEqual([
      {
        namespaces: { type: "all" },
        kinds: { type: "only", kinds: [...TRAEFIK_KINDS.map((d) => ({ group: d.kind.group, kind: d.kind.kind })), { group: "", kind: "Service" }, { group: "", kind: "Secret" }] },
        actions: ["read"],
      },
    ]);
    expect((manifest.contributes as { actions?: unknown[] }).actions ?? []).toEqual([]);
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const prefixOf = (group: string) => (group === TRAEFIK_GROUP ? "" : "l-");
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.traefik:${id}`, columnOf(id));
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) || undefined;
function toneOf(id: string, obj: KubeObject): string | undefined {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  if (node?.props?.title !== undefined) node = node.props.children as typeof node;
  return node?.props?.tone;
}
const joined = (values: readonly (string | undefined)[]) => {
  const list = [...new Set(values.filter((v): v is string => Boolean(v)))];
  return list.length > 0 ? list.join(", ") : undefined;
};

describe("the columns, against the built-in ones", () => {
  it("are the built-in columns after the namespace, but the references' state and the routes' hosts", () => {
    const of = (group: string, kind: string) => manifest.contributes.columns.filter((c) => c.kind.group === group && c.kind.kind === kind).map((c) => [c.title, c.width]);
    for (const group of [TRAEFIK_GROUP, LEGACY_GROUP]) {
      expect(of(group, "IngressRoute")).toEqual([
        ["Entry points", "minmax(100px, 1fr)"],
        ["Services", "minmax(140px, 2fr)"],
        ["TLS", "70px"],
      ]);
      expect(of(group, "IngressRouteTCP")).toEqual(of(group, "IngressRoute"));
      expect(of(group, "IngressRouteUDP")).toEqual(of(group, "IngressRoute").slice(0, 2));
      expect(of(group, "Middleware")).toEqual([["Type", "minmax(120px, 1fr)"]]);
      expect(of(group, "MiddlewareTCP")).toEqual([["Type", "minmax(120px, 1fr)"]]);
      expect(of(group, "TraefikService")).toEqual([
        ["Strategy", "minmax(120px, 1fr)"],
        ["Services", "minmax(140px, 2fr)"],
      ]);
      expect(of(group, "TLSOption")).toEqual([
        ["Minimum TLS", "110px"],
        ["Client authentication", "minmax(120px, 1fr)"],
      ]);
      expect(of(group, "TLSStore")).toEqual([
        ["Default certificate", "minmax(140px, 1fr)"],
        ["Secrets", "minmax(140px, 2fr)"],
      ]);
      expect(of(group, "ServersTransport")).toEqual([
        ["Server name", "minmax(120px, 1fr)"],
        ["Verification", "110px"],
        ["Secrets", "minmax(140px, 2fr)"],
      ]);
    }
    expect(of(TRAEFIK_GROUP, "ServersTransportTCP")).toEqual(of(TRAEFIK_GROUP, "ServersTransport"));
    expect(of(LEGACY_GROUP, "ServersTransportTCP")).toEqual([]);
    // Each kind's columns follow one another from the namespace on, as the built-in lists had them.
    for (const c of manifest.contributes.columns) {
      const before = manifest.contributes.columns.filter((o) => o.kind.group === c.kind.group && o.kind.kind === c.kind.kind);
      const i = before.indexOf(c);
      expect(c.afterColumn).toBe(i === 0 ? "namespace" : before[i - 1]!.id);
    }
  });

  /** Routes in the shapes the readings tell apart. */
  function routes(): [string, string, KubeObject][] {
    const out: [string, string, KubeObject][] = [];
    for (const [kind, base] of [
      ["IngressRoute", fx.ingressRoute!],
      ["IngressRouteTCP", fx.tcpRoute!],
      ["IngressRouteUDP", fx.udpRoute!],
    ] as const) {
      out.push([kind, `${kind} fixture`, copy(base)]);
      const many = copy(base);
      const spec = many.spec as { routes: { services?: Record<string, unknown>[] }[]; entryPoints?: unknown; tls?: unknown };
      spec.routes.push({ services: [{ name: "foo" }, { name: "bar" }] }, { services: [] }, {});
      spec.entryPoints = [];
      out.push([kind, `${kind} more routes, no entry points`, many]);
      const ten = copy(base);
      const tenRoutes = (ten.spec as { routes: unknown[] }).routes;
      while (tenRoutes.length < 10) tenRoutes.push({ match: "PathPrefix(`/x`)", services: [{ name: `s${tenRoutes.length}` }, { name: "foo" }] });
      out.push([kind, `${kind} ten routes`, ten]);
      const tls = copy(base);
      (tls.spec as Record<string, unknown>).tls = { passthrough: true };
      out.push([kind, `${kind} passthrough`, tls]);
      const empty = copy(base);
      (empty.spec as Record<string, unknown>).tls = {};
      delete (empty.spec as Record<string, unknown>).entryPoints;
      out.push([kind, `${kind} empty TLS, no entry points`, empty]);
      const noTls = copy(base);
      delete (noTls.spec as Record<string, unknown>).tls;
      out.push([kind, `${kind} no TLS`, noTls]);
    }
    return out;
  }

  for (const group of [TRAEFIK_GROUP, LEGACY_GROUP]) {
    const p = prefixOf(group);
    it(`${group}: routes' entry points, services (each once, in order) and TLS`, () => {
      for (const [kindName, label, base] of routes()) {
        const obj = asGroup(base, group);
        const kind = { group, kind: kindName };
        const short = { IngressRoute: "ir", IngressRouteTCP: "irt", IngressRouteUDP: "iru" }[kindName]!;
        const spec = routeSpec(kind, obj);
        expect(cell(`${p}${short}-ep`, obj), label).toBe(joined(spec.entryPoints));
        expect(cell(`${p}${short}-svc`, obj), label).toBe(joined(spec.routes.flatMap((r) => r.services.map((s) => (s.provider ? `${s.name}@${s.provider}` : s.name)))));
        if (kindName === "IngressRouteUDP") continue;
        const tls = get(obj, "spec", "tls");
        expect(cell(`${p}${short}-tls`, obj), label).toBe(tls ? (get(tls, "passthrough") === true ? "Passthrough" : "TLS") : undefined);
        expect(windowColumn(`${p}${short}-tls`).value(obj) || undefined, label).toBe(tls ? "TLS" : undefined);
      }
    });

    it(`${group}: a middleware's type, a TraefikService's strategy and services`, () => {
      for (const key of ["chain", "httpsOnly", "knownIps", "authUsers"]) {
        const obj = asGroup(fx[key]!, group);
        expect(cell(`${p}mw-type`, obj), key).toBe(middlewareType(obj));
        expect(cell(`${p}mwt-type`, obj), key).toBe(middlewareType(obj));
      }
      const services = [fx.wrr!, fx.mirror!];
      const failover = copy(fx.mirror!);
      failover.spec = { failover: { service: { name: "main" }, fallback: { name: "spare", kind: "TraefikService" } } };
      const hrw = copy(fx.mirror!);
      hrw.spec = { highestRandomWeight: { services: [{ name: "a" }, { name: "b@file" }, { name: "a" }] } };
      const none = copy(fx.mirror!);
      none.spec = {};
      for (const base of [...services, failover, hrw, none]) {
        const obj = asGroup(base, group);
        const label = JSON.stringify(obj.spec);
        expect(cell(`${p}ts-strat`, obj), label).toBe(traefikServiceType(obj));
        const children = traefikServiceRefs(obj).filter((r) => r.kind === "Service" || r.kind === "TraefikService");
        expect(cell(`${p}ts-svc`, obj), label).toBe(joined(children.map((r) => (r.provider ? `${r.name}@${r.provider}` : r.name))));
      }
    });

    it(`${group}: TLS options, stores and servers transports with their settings and Secrets`, () => {
      const option = asGroup(fx.tlsOption!, group);
      expect(cell(`${p}to-min`, option)).toBe(str(get(option, "spec", "minVersion")));
      expect(cell(`${p}to-auth`, option)).toBe(str(get(option, "spec", "clientAuth", "clientAuthType")));
      const store = asGroup(fx.tlsStore!, group);
      const many = copy(store);
      (many.spec as Record<string, unknown>).certificates = [{ secretName: "a" }, { secretName: "default-certificate" }, { secretName: "b" }];
      for (const s of [store, many]) {
        expect(cell(`${p}tst-def`, s)).toBe(str(get(s, "spec", "defaultCertificate", "secretName")));
        expect(cell(`${p}tst-sec`, s)).toBe(joined(secretsOf(TLS_STORE, s).map((r) => r.name)));
      }
      const transports: [string, KubeObject][] = [["ServersTransport", asGroup(fx.transport!, group)]];
      const secure = copy(fx.transport!);
      (secure.spec as Record<string, unknown>).insecureSkipVerify = false;
      (secure.spec as Record<string, unknown>).rootCAs = [{ secret: "ca" }, { configMap: "cm" }];
      transports.push(["ServersTransport", asGroup(secure, group)]);
      if (group === TRAEFIK_GROUP) {
        const tcp = copy(fx.transport!);
        tcp.kind = "ServersTransportTCP";
        tcp.spec = { tls: { serverName: "tcp-name", insecureSkipVerify: true, rootCAsSecrets: ["x"], certificatesSecrets: ["x", "y"] } };
        transports.push(["ServersTransportTCP", tcp]);
        const plain = copy(tcp);
        plain.spec = { dialTimeout: "30s" };
        transports.push(["ServersTransportTCP", plain]);
      }
      for (const [kindName, obj] of transports) {
        const short = kindName === "ServersTransport" ? "st" : "stt";
        const kind = kindName === "ServersTransport" ? SERVERS_TRANSPORT : SERVERS_TRANSPORT_TCP;
        const spec = get(obj, "spec");
        const label = `${kindName} ${JSON.stringify(spec)}`;
        expect(cell(`${p}${short}-sni`, obj), label).toBe(str(get(spec, "serverName")) ?? str(get(spec, "tls", "serverName")));
        const insecure = (get(spec, "insecureSkipVerify") ?? get(spec, "tls", "insecureSkipVerify")) === true;
        expect(cell(`${p}${short}-insec`, obj), label).toBe(insecure ? "Not verified" : undefined);
        expect(toneOf(`${p}${short}-insec`, obj), label).toBe(insecure ? "warning" : undefined);
        expect(windowColumn(`${p}${short}-insec`).value(obj), label).toBe(String(insecure));
        expect(cell(`${p}${short}-sec`, obj), label).toBe(joined(secretsOf(kind, obj).map((r) => r.name)));
      }
    });
  }

  it("differ where the API cannot say it: no state column, no hosts, every key of a middleware", () => {
    const ids = manifest.contributes.columns.map((c) => c.id);
    expect(ids.some((id) => id.endsWith("-state") || id.endsWith("-hosts"))).toBe(false);
    const two = copy(fx.httpsOnly!);
    (two.spec as Record<string, unknown>).stripPrefix = { prefixes: ["/a"] };
    expect(middlewareType(two)).toBe("redirectScheme");
    // The built-in named the first key; `|keys` names every one.
    expect(cell("mw-type", two)).toContain("stripPrefix");
  });
});
