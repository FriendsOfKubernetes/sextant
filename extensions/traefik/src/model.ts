// What the extension reads from Traefik's CRDs (group `traefik.io`, and the older `traefik.containo.us` where a cluster
// still serves it): the routes with their match rules, entry points, middlewares, TLS and services, and every reference
// an object makes to another object — in the shapes of Traefik's own types (`pkg/provider/kubernetes/crd/traefikio/
// v1alpha1`). Traefik writes no status on any of these kinds, so nothing here reads one: what can be judged is whether
// the objects the references name exist. Pure functions: the former built-in view's model and reference checks
// (ADR-0108, `model.ts` and `resolve.ts`), ported unchanged, with the lookup the details judge with.
//
// What a reference finds. What cannot be judged stays open, never "fine" and never "broken":
//   - a reference into another namespace: Traefik follows it only when the provider runs with `allowCrossNamespace`
//     (off by default), a flag of Traefik's static configuration that no object shows;
//   - `name@provider`: an object of another provider (file, …) Sextant cannot see — except Traefik's own `@internal`
//     services (`api@internal`, `noop@internal`, …), which always exist;
//   - a list that could not be read.
// A TLSStore reference of a route is shown but never breaks it: Traefik's routers do not use it (only the store named
// `default` exists). Nor does a route's TLS Secret: Traefik logs that it cannot load it (`getTLSHTTP`) and still builds
// the router, answering with a certificate picked by the requested name among those it holds, else its default one.
// Where a cluster serves both groups, Traefik v3 reads only `traefik.io`: a reference from a `traefik.io` object is
// looked up there, and a target that exists only in `traefik.containo.us` is "legacy only" (Traefik 2.10 reads both,
// v3 does not; which one runs no object shows) — open, never fine and never broken.
import type { KindRef, KubeObject, UiTone } from "@sextant/extension-sdk";

// ---------- Reading fields (as Sextant's own `status` helpers) ----------

export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// ---------- The kinds ----------

export const TRAEFIK_GROUP = "traefik.io";
/** Traefik v2's group; Traefik 2.10 reads both, v3 only `traefik.io`. */
export const LEGACY_GROUP = "traefik.containo.us";
export const TRAEFIK_GROUPS = [TRAEFIK_GROUP, LEGACY_GROUP] as const;

const k = (group: string, kind: string): KindRef => ({ group, version: "v1alpha1", kind });

export const INGRESS_ROUTE = k(TRAEFIK_GROUP, "IngressRoute");
export const INGRESS_ROUTE_TCP = k(TRAEFIK_GROUP, "IngressRouteTCP");
export const INGRESS_ROUTE_UDP = k(TRAEFIK_GROUP, "IngressRouteUDP");
export const MIDDLEWARE = k(TRAEFIK_GROUP, "Middleware");
export const MIDDLEWARE_TCP = k(TRAEFIK_GROUP, "MiddlewareTCP");
export const TLS_OPTION = k(TRAEFIK_GROUP, "TLSOption");
export const TLS_STORE = k(TRAEFIK_GROUP, "TLSStore");
export const TRAEFIK_SERVICE = k(TRAEFIK_GROUP, "TraefikService");
export const SERVERS_TRANSPORT = k(TRAEFIK_GROUP, "ServersTransport");
export const SERVERS_TRANSPORT_TCP = k(TRAEFIK_GROUP, "ServersTransportTCP");

export const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
export const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };

export interface TraefikKind {
  kind: KindRef;
  order: number;
  /** Key under `sidebar` (the built-in view's sidebar labels). */
  label: string;
}

const OWN_KINDS: readonly Omit<TraefikKind, "kind">[] = [
  { order: 10, label: "ingressRoutes" },
  { order: 20, label: "ingressRoutesTcp" },
  { order: 30, label: "ingressRoutesUdp" },
  { order: 40, label: "middlewares" },
  { order: 50, label: "middlewaresTcp" },
  { order: 60, label: "traefikServices" },
  { order: 70, label: "tlsOptions" },
  { order: 80, label: "tlsStores" },
  { order: 90, label: "serversTransports" },
  { order: 100, label: "serversTransportsTcp" },
];
const OWN_REFS = [
  INGRESS_ROUTE,
  INGRESS_ROUTE_TCP,
  INGRESS_ROUTE_UDP,
  MIDDLEWARE,
  MIDDLEWARE_TCP,
  TRAEFIK_SERVICE,
  TLS_OPTION,
  TLS_STORE,
  SERVERS_TRANSPORT,
  SERVERS_TRANSPORT_TCP,
];

/** Every kind of the section: `traefik.io` first, then the same kinds of the old group (labelled as such). */
export const TRAEFIK_KINDS: readonly TraefikKind[] = [
  ...OWN_REFS.map((kind, i) => ({ kind, ...OWN_KINDS[i]! })),
  // ServersTransportTCP came with v3: the old group never had it.
  ...OWN_REFS.slice(0, 9).map((kind, i) => ({
    kind: { ...kind, group: LEGACY_GROUP },
    order: 200 + OWN_KINDS[i]!.order,
    label: `${OWN_KINDS[i]!.label}Legacy`,
  })),
];

export const sameKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) => a.group === b.group && a.kind === b.kind;

/** The same kind in either group (`IngressRoute` of `traefik.io` or of `traefik.containo.us`). */
export const isTraefik = (kind: Pick<KindRef, "group" | "kind">, of: Pick<KindRef, "kind">) =>
  (TRAEFIK_GROUPS as readonly string[]).includes(kind.group) && kind.kind === of.kind;

export function traefikKind(kind: Pick<KindRef, "group" | "kind">): TraefikKind | undefined {
  return TRAEFIK_KINDS.find((d) => sameKind(d.kind, kind));
}

export const isRouteKind = (kind: Pick<KindRef, "group" | "kind">) =>
  isTraefik(kind, INGRESS_ROUTE) || isTraefik(kind, INGRESS_ROUTE_TCP) || isTraefik(kind, INGRESS_ROUTE_UDP);

const nsOf = (obj: KubeObject) => obj.metadata?.namespace ?? "";
const strings = (value: unknown) => arr(value).filter((v): v is string => typeof v === "string" && v !== "");

// ---------- References ----------

/** What a reference names (`Service` and `Secret` are core kinds). */
export type RefKind =
  | "IngressRoute"
  | "Middleware"
  | "MiddlewareTCP"
  | "Service"
  | "TraefikService"
  | "TLSOption"
  | "TLSStore"
  | "Secret"
  | "ServersTransport"
  | "ServersTransportTCP";

/** Where in its object a reference is (for the words). */
export type RefPlace = "route" | "middleware" | "tls" | "parent" | "service" | "mirror" | "fallback" | "chain" | "errors" | "secret" | "transport";

export const REF_PLACES: readonly RefPlace[] = ["route", "middleware", "tls", "parent", "service", "mirror", "fallback", "chain", "errors", "secret", "transport"];

export interface Ref {
  kind: RefKind;
  name: string;
  /** The namespace Traefik looks in: the reference's own, else its object's. */
  namespace: string;
  /** The reference names another namespace than its object's (allowed only with the provider's `allowCrossNamespace`). */
  crossNamespace: boolean;
  /** `name@provider`: an object of another Traefik provider (file, internal, …) that Sextant cannot see. */
  provider?: string;
  /** A service `kind` Traefik does not know (only `Service` and `TraefikService` are). */
  badKind?: string;
  place: RefPlace;
  /** The route (0-based) a reference of a route is in. */
  route?: number;
  port?: number | string;
  weight?: number;
}

/** A reference to `name` in `refNamespace` (empty: the object's own) from an object in `parentNamespace`. */
export function refOf(kind: RefKind, name: string, refNamespace: string | undefined, parentNamespace: string, place: RefPlace, route?: number): Ref {
  const at = name.lastIndexOf("@");
  if (at > 0) return { kind, name: name.slice(0, at), provider: name.slice(at + 1), namespace: parentNamespace, crossNamespace: false, place, route };
  const namespace = refNamespace || parentNamespace;
  return { kind, name, namespace, crossNamespace: namespace !== parentNamespace, place, route };
}

const portOf = (value: unknown): number | string | undefined => {
  const n = num(value);
  if (n !== undefined) return n;
  const s = str(value);
  return s ? s : undefined;
};

/**
 * A `LoadBalancerSpec` (a route's service, a TraefikService's child): the service it names, then its own middlewares
 * (resolved in the service's namespace, as Traefik does) and servers transport.
 */
export function serviceRefs(spec: unknown, parentNamespace: string, place: RefPlace, route?: number, tcp = false): Ref[] {
  const name = str(get(spec, "name"));
  if (!name) return [];
  const kindField = tcp ? "" : (str(get(spec, "kind")) ?? "");
  const kind: RefKind = kindField === "TraefikService" ? "TraefikService" : "Service";
  const ref: Ref = { ...refOf(kind, name, str(get(spec, "namespace")), parentNamespace, place, route), port: portOf(get(spec, "port")), weight: num(get(spec, "weight")) };
  if (kindField !== "" && kindField !== "Service" && kindField !== "TraefikService") ref.badKind = kindField;
  const out = [ref];
  for (const m of arr(get(spec, "middlewares"))) {
    const mname = str(get(m, "name"));
    if (mname) out.push(refOf("Middleware", mname, str(get(m, "namespace")), ref.namespace, "middleware", route));
  }
  const transport = str(get(spec, "serversTransport"));
  if (transport) out.push(refOf(tcp ? "ServersTransportTCP" : "ServersTransport", transport, undefined, ref.namespace, "transport", route));
  return out;
}

// ---------- Routes ----------

export interface RouteTls {
  secretName?: string;
  options?: Ref;
  store?: Ref;
  certResolver?: string;
  /** `domains[].main` and `sans`. */
  domains: string[];
  /** IngressRouteTCP: TLS is passed through to the backend. */
  passthrough: boolean;
}

export interface Route {
  index: number;
  /** The rule (empty for UDP, which has none). */
  match: string;
  /** `kind` of an HTTP route: only `Rule` (or none) is supported. */
  kind?: string;
  priority?: number;
  syntax?: string;
  middlewares: Ref[];
  /** The services the route sends to: the first ref of each `serviceRefs`. */
  services: Ref[];
  /** Every reference of the route: services with their own middlewares and transports, then the route's middlewares. */
  refs: Ref[];
}

export interface RouteSpec {
  entryPoints: string[];
  ingressClassName?: string;
  routes: Route[];
  tls?: RouteTls;
  /** Parent IngressRoutes (multi-layer routing, Traefik 3.5+). */
  parents: Ref[];
}

function tlsOf(obj: KubeObject, ns: string): RouteTls | undefined {
  const tls = get(obj, "spec", "tls");
  if (!tls || typeof tls !== "object") return undefined;
  const ref = (field: string, kind: RefKind) => {
    const name = str(get(tls, field, "name"));
    return name ? refOf(kind, name, str(get(tls, field, "namespace")), ns, "tls") : undefined;
  };
  return {
    secretName: str(get(tls, "secretName")) || undefined,
    options: ref("options", "TLSOption"),
    store: ref("store", "TLSStore"),
    certResolver: str(get(tls, "certResolver")) || undefined,
    domains: arr(get(tls, "domains")).flatMap((d) => [str(get(d, "main")) ?? "", ...strings(get(d, "sans"))]).filter(Boolean),
    passthrough: get(tls, "passthrough") === true,
  };
}

/** What an IngressRoute, IngressRouteTCP or IngressRouteUDP says. */
export function routeSpec(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): RouteSpec {
  const ns = nsOf(obj);
  const tcp = isTraefik(kind, INGRESS_ROUTE_TCP);
  const udp = isTraefik(kind, INGRESS_ROUTE_UDP);
  const routes = arr(get(obj, "spec", "routes")).map((r, index): Route => {
    const middlewares = udp
      ? []
      : arr(get(r, "middlewares")).flatMap((m) => {
          const name = str(get(m, "name"));
          return name ? [refOf(tcp ? "MiddlewareTCP" : "Middleware", name, str(get(m, "namespace")), ns, "route", index)] : [];
        });
    const services = arr(get(r, "services")).map((s) => serviceRefs(s, ns, "route", index, tcp || udp));
    return {
      index,
      match: str(get(r, "match")) ?? "",
      kind: tcp || udp ? undefined : str(get(r, "kind")) || undefined,
      priority: num(get(r, "priority")),
      syntax: str(get(r, "syntax")) || undefined,
      middlewares,
      services: services.flatMap((s) => s.slice(0, 1)),
      refs: [...services.flat(), ...middlewares],
    };
  });
  const parents = arr(get(obj, "spec", "parentRefs")).flatMap((p) => {
    const name = str(get(p, "name"));
    return name ? [refOf("IngressRoute", name, str(get(p, "namespace")), ns, "parent")] : [];
  });
  return {
    entryPoints: strings(get(obj, "spec", "entryPoints")),
    ingressClassName: str(get(obj, "spec", "ingressClassName")) || undefined,
    routes,
    tls: udp ? undefined : tlsOf(obj, ns),
    parents,
  };
}

/** The host names a rule matches exactly: `Host(…)` and `HostSNI(…)` arguments (not `HostRegexp`, not `*`). */
export function hostsOf(match: string): string[] {
  const out: string[] = [];
  for (const call of match.matchAll(/\bHost(?:SNI)?\s*\(([^)]*)\)/g)) {
    for (const arg of call[1]!.matchAll(/[`"]([^`"]*)[`"]/g)) if (arg[1] && arg[1] !== "*") out.push(arg[1].toLowerCase());
  }
  return [...new Set(out)];
}

// ---------- The other kinds ----------

/** A TraefikService's strategy: the one of its fields that is set. */
export type TraefikServiceType = "weighted" | "mirroring" | "highestRandomWeight" | "failover";
export const STRATEGIES: readonly TraefikServiceType[] = ["weighted", "mirroring", "highestRandomWeight", "failover"];

export function traefikServiceType(obj: KubeObject): TraefikServiceType | undefined {
  const spec = get(obj, "spec");
  return STRATEGIES.find((t) => get(spec, t) !== undefined);
}

/** The services a TraefikService sends to (each with its own middlewares and transport). */
export function traefikServiceRefs(obj: KubeObject): Ref[] {
  const ns = nsOf(obj);
  const spec = get(obj, "spec");
  const out: Ref[] = [];
  for (const s of arr(get(spec, "weighted", "services"))) out.push(...serviceRefs(s, ns, "service"));
  for (const s of arr(get(spec, "highestRandomWeight", "services"))) out.push(...serviceRefs(s, ns, "service"));
  const mirroring = get(spec, "mirroring");
  if (mirroring) {
    out.push(...serviceRefs(mirroring, ns, "service"));
    for (const m of arr(get(mirroring, "mirrors"))) {
      const refs = serviceRefs(m, ns, "mirror");
      if (refs[0]) refs[0].weight = num(get(m, "percent"));
      out.push(...refs);
    }
  }
  const failover = get(spec, "failover");
  if (failover) {
    out.push(...serviceRefs(get(failover, "service"), ns, "service"));
    out.push(...serviceRefs(get(failover, "fallback"), ns, "fallback"));
  }
  return out;
}

/** The middleware's type: the first field of its spec (`stripPrefix`, `basicAuth`, `chain`, `plugin`, …). */
export function middlewareType(obj: KubeObject): string | undefined {
  const spec = get(obj, "spec");
  return spec && typeof spec === "object" ? Object.keys(spec)[0] : undefined;
}

const secretRefs = (names: readonly (string | undefined)[], ns: string): Ref[] =>
  [...new Set(names.filter((n): n is string => Boolean(n)))].map((name) => refOf("Secret", name, undefined, ns, "secret"));

/** A Middleware's references: a chain's middlewares, an error page's service, the Secrets of auth and rate limits. */
export function middlewareRefs(obj: KubeObject): Ref[] {
  const ns = nsOf(obj);
  const spec = get(obj, "spec");
  const out: Ref[] = [];
  for (const m of arr(get(spec, "chain", "middlewares"))) {
    const name = str(get(m, "name"));
    if (name) out.push(refOf("Middleware", name, str(get(m, "namespace")), ns, "chain"));
  }
  const errors = get(spec, "errors", "service");
  if (errors) out.push(...serviceRefs(errors, ns, "errors"));
  out.push(
    ...secretRefs(
      [
        str(get(spec, "basicAuth", "secret")),
        str(get(spec, "digestAuth", "secret")),
        str(get(spec, "forwardAuth", "tls", "caSecret")),
        str(get(spec, "forwardAuth", "tls", "certSecret")),
        str(get(spec, "rateLimit", "redis", "secret")),
        str(get(spec, "rateLimit", "redis", "tls", "caSecret")),
        str(get(spec, "rateLimit", "redis", "tls", "certSecret")),
        str(get(spec, "inFlightReq", "redis", "secret")),
      ],
      ns,
    ),
  );
  return out;
}

/** The Secrets of a TLSOption (client CAs), TLSStore (certificates) or ServersTransport (CAs and client certificates). */
export function secretsOf(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Ref[] {
  const ns = nsOf(obj);
  const spec = get(obj, "spec");
  if (isTraefik(kind, TLS_OPTION)) return secretRefs(strings(get(spec, "clientAuth", "secretNames")), ns);
  if (isTraefik(kind, TLS_STORE)) {
    return secretRefs([str(get(spec, "defaultCertificate", "secretName")), ...arr(get(spec, "certificates")).map((c) => str(get(c, "secretName")))], ns);
  }
  if (isTraefik(kind, SERVERS_TRANSPORT) || isTraefik(kind, SERVERS_TRANSPORT_TCP)) {
    const tls = isTraefik(kind, SERVERS_TRANSPORT_TCP) ? get(spec, "tls") : spec;
    return secretRefs(
      [...strings(get(tls, "rootCAsSecrets")), ...strings(get(tls, "certificatesSecrets")), ...arr(get(tls, "rootCAs")).map((r) => str(get(r, "secret")))],
      ns,
    );
  }
  return [];
}

/** Every reference an object of the section makes, in its order. */
export function referencesOf(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Ref[] {
  if (isRouteKind(kind)) {
    const spec = routeSpec(kind, obj);
    const tls = spec.tls;
    const ns = nsOf(obj);
    return [
      ...spec.parents,
      ...spec.routes.flatMap((r) => r.refs),
      ...(tls?.secretName ? [refOf("Secret", tls.secretName, undefined, ns, "tls")] : []),
      ...(tls?.options ? [tls.options] : []),
      ...(tls?.store ? [tls.store] : []),
    ];
  }
  if (isTraefik(kind, TRAEFIK_SERVICE)) return traefikServiceRefs(obj);
  if (isTraefik(kind, MIDDLEWARE)) return middlewareRefs(obj);
  return secretsOf(kind, obj);
}

// ---------- What the references find ----------

export type RefState = "found" | "missing" | "crossNamespace" | "otherProvider" | "unknown" | "badKind" | "legacyOnly";
export const REF_STATES: readonly RefState[] = ["found", "missing", "crossNamespace", "otherProvider", "unknown", "badKind", "legacyOnly"];

export interface Lookup {
  /**
   * Whether `kind` `name` exists in `namespace`; `undefined` when that list is not known. A Traefik kind is looked up
   * in `traefik.io` where the cluster serves it there, else in `traefik.containo.us`.
   */
  exists(kind: RefKind, namespace: string, name: string): boolean | undefined;
  /**
   * Whether a `traefik.containo.us` object of that name exists while `traefik.io` serves the kind too (`false` where
   * only one group serves it; `undefined` when the old group's list is not known).
   */
  legacy?(kind: RefKind, namespace: string, name: string): boolean | undefined;
}

export interface RefCheck {
  ref: Ref;
  state: RefState;
  /** Found in `traefik.io`, and an object of the same name exists in `traefik.containo.us` too. */
  legacyToo?: boolean;
}

/** Traefik's own services: always there. */
const INTERNAL = "internal";

/**
 * What a reference finds. `fromLegacy`: the referring object is of `traefik.containo.us` — only a Traefik that reads
 * both groups (2.10) serves it, and that one finds the target in either.
 */
export function checkRef(ref: Ref, lookup: Lookup, fromLegacy = false): RefState {
  if (ref.badKind) return "badKind";
  if (ref.provider) return ref.provider === INTERNAL ? "found" : "otherProvider";
  let found = lookup.exists(ref.kind, ref.namespace, ref.name);
  if (found !== true && lookup.legacy) {
    const legacy = lookup.legacy(ref.kind, ref.namespace, ref.name);
    if (legacy === true) {
      if (!fromLegacy) return "legacyOnly";
      found = true;
    } else if (legacy === undefined) {
      // The old group's list is not known: Traefik 2.10 might find the target there.
      return "unknown";
    }
  }
  if (found === undefined) return "unknown";
  if (!found) return "missing";
  return ref.crossNamespace ? "crossNamespace" : "found";
}

/** A route's TLS Secret: Traefik builds the router without it (another certificate is served). */
export const isRouteTlsSecret = (ref: Ref) => ref.kind === "Secret" && ref.place === "tls";

/**
 * A reference whose target is missing (or of an unknown kind) breaks its object — except a TLSStore reference and a
 * route's TLS Secret, neither of which stops Traefik from building the router.
 */
export const breaks = (check: RefCheck) =>
  (check.state === "missing" || check.state === "badKind") && check.ref.kind !== "TLSStore" && !isRouteTlsSecret(check.ref);

/** A route Traefik skips by its own shape. */
export interface RouteIssue {
  type: "emptyMatch" | "unsupportedKind";
  /** 0-based. */
  route: number;
  value?: string;
}

export function routeIssues(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): RouteIssue[] {
  if (!isRouteKind(kind) || isTraefik(kind, INGRESS_ROUTE_UDP)) return [];
  const http = isTraefik(kind, INGRESS_ROUTE);
  return routeSpec(kind, obj).routes.flatMap((r): RouteIssue[] => {
    if (http && r.kind && r.kind !== "Rule") return [{ type: "unsupportedKind", route: r.index, value: r.kind }];
    if (!r.match.trim()) return [{ type: "emptyMatch", route: r.index }];
    return [];
  });
}

/** `ok`: every reference found; `partial`: some could not be judged; `failed`: one is broken; `loading`: lists pending. */
export type Health = "ok" | "partial" | "failed" | "loading";
export const HEALTHS: readonly Health[] = ["ok", "partial", "failed", "loading"];

export interface Judgement {
  health: Health;
  checks: RefCheck[];
  issues: RouteIssue[];
}

/**
 * Judges an object's references; `skip` leaves some out (the built-in shared store did not judge Secrets: only the
 * details of one object listed them).
 */
export function judge(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject, lookup: Lookup, skip?: (ref: Ref) => boolean): Judgement {
  const fromLegacy = kind.group === LEGACY_GROUP;
  const checks = referencesOf(kind, obj)
    .filter((ref) => !skip?.(ref))
    .map((ref): RefCheck => {
      const state = checkRef(ref, lookup, fromLegacy);
      const legacyToo = !fromLegacy && (state === "found" || state === "crossNamespace") && !ref.provider && lookup.legacy?.(ref.kind, ref.namespace, ref.name) === true;
      return legacyToo ? { ref, state, legacyToo } : { ref, state };
    });
  const issues = routeIssues(kind, obj);
  const health: Health = issues.length > 0 || checks.some(breaks) ? "failed" : checks.some((c) => c.state !== "found") ? "partial" : "ok";
  return { health, checks, issues };
}

export const HEALTH_TONE: Record<Health, UiTone> = { ok: "success", partial: "muted", failed: "danger", loading: "muted" };

export const STATE_TONE: Record<RefState, UiTone> = {
  found: "success",
  missing: "danger",
  badKind: "danger",
  crossNamespace: "warning",
  otherProvider: "muted",
  unknown: "muted",
  legacyOnly: "warning",
};

/** `Kind name` or `Kind namespace/name` of a reference, for a message. */
export function refText(ref: Ref, from: string): string {
  const name = ref.provider ? `${ref.name}@${ref.provider}` : ref.namespace !== from ? `${ref.namespace}/${ref.name}` : ref.name;
  return `${ref.kind} ${name}`;
}

/**
 * The problems the built-in category `traefik` found in a judged object (its provider's `toProblems`, without the
 * times): a broken reference (`MissingReference`, the broken ones named) and the routes Traefik skips (`SkippedRoute`,
 * numbered from 1). The Secrets were never judged for it (`skipSecrets`).
 */
export function builtInProblems(namespace: string, judgement: Judgement): { reason: string; refs?: string[]; routes?: string[] }[] {
  const out: { reason: string; refs?: string[]; routes?: string[] }[] = [];
  const broken = [...new Set(judgement.checks.filter(breaks).map((c) => refText(c.ref, namespace)))];
  if (broken.length > 0) out.push({ reason: "MissingReference", refs: broken });
  const skipped = [...new Set(judgement.issues.map((i) => String(i.route + 1)))];
  if (skipped.length > 0) out.push({ reason: "SkippedRoute", routes: skipped });
  return out;
}

/** The built-in store's rule: Secrets are judged only in the open details. */
export const skipSecrets = (ref: Ref) => ref.kind === "Secret";

// ---------- The lists a lookup reads ----------

/** A list as the details watch it: the names it holds and whether it was read in full. */
export interface NameList {
  /** The first answer came (or the watch failed). */
  ready: boolean;
  /** The watch failed. */
  error: boolean;
  /** The namespaces it may not read. */
  forbidden: readonly string[];
  /** It kept only part of the objects. */
  capped: boolean;
  /** The namespaces it watches; `null`: every one. */
  namespaces: readonly string[] | null;
  /** `namespace/name` of every object. */
  names: ReadonlySet<string>;
}

export const nameKey = (namespace: string, name: string) => `${namespace}/${name}`;

const readableIn = (list: NameList, namespace: string) =>
  list.ready && !list.error && !list.forbidden.includes(namespace) && !list.capped && (list.namespaces === null || list.namespaces.includes(namespace));

/** Whether a list has the name: `true`, `false` where it is read in full there, else `undefined`. */
export function listHas(list: NameList | undefined, namespace: string, name: string): boolean | undefined {
  if (!list) return undefined;
  if (list.names.has(nameKey(namespace, name))) return true;
  return readableIn(list, namespace) ? false : undefined;
}

/** Which groups of the cluster serve each Traefik kind, by kind name. */
export type Served = ReadonlyMap<string, { own: boolean; legacy: boolean }>;

/**
 * The lookup over the lists, as the built-in store's: a Traefik kind is looked up in `traefik.io` where that group
 * serves it (Traefik v3 reads nothing else), else in `traefik.containo.us`, and a kind neither serves has no objects;
 * `legacy` tells whether the old group has the name too. Services and Secrets come from their own lists; without one
 * (or where it does not cover the namespace) they are not known.
 */
export function lookupOf(served: Served, lists: (group: string, kind: string) => NameList | undefined): Lookup {
  const core = (kind: RefKind) => kind === "Service" || kind === "Secret";
  return {
    exists(kind, namespace, name) {
      if (core(kind)) return listHas(lists("", kind), namespace, name);
      const s = served.get(kind);
      if (s?.own) return listHas(lists(TRAEFIK_GROUP, kind), namespace, name);
      if (s?.legacy) return listHas(lists(LEGACY_GROUP, kind), namespace, name);
      return false;
    },
    legacy(kind, namespace, name) {
      const s = served.get(kind);
      if (core(kind) || !s?.own || !s.legacy) return false;
      return listHas(lists(LEGACY_GROUP, kind), namespace, name);
    },
  };
}

/** A list the details watch for one object: a kind (with its group) in some namespaces, by name where it is one. */
export interface ListWant {
  group: string;
  kind: string;
  namespaces: string[];
  /** Waited for before the object is judged ("Checking…"); the Secrets are not, as the built-in details did not. */
  waited: boolean;
}

/**
 * The lists the references of `obj` read: each Traefik kind in the group the lookup reads it from (both groups where
 * both serve it), Services and Secrets — in the namespaces the references name; nothing for another provider's object,
 * a service kind Traefik does not know, or a kind neither group serves.
 */
export function listsFor(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject, served: Served): ListWant[] {
  const wanted = new Map<string, ListWant>();
  const want = (group: string, k: string, namespace: string, waited: boolean) => {
    const key = `${group}/${k}`;
    const entry = wanted.get(key) ?? { group, kind: k, namespaces: [], waited };
    if (!entry.namespaces.includes(namespace)) entry.namespaces.push(namespace);
    wanted.set(key, entry);
  };
  for (const ref of referencesOf(kind, obj)) {
    if (ref.badKind || ref.provider) continue;
    if (ref.kind === "Service" || ref.kind === "Secret") {
      want("", ref.kind, ref.namespace, ref.kind === "Service");
      continue;
    }
    const s = served.get(ref.kind);
    if (s?.own) want(TRAEFIK_GROUP, ref.kind, ref.namespace, true);
    if (s?.legacy) want(LEGACY_GROUP, ref.kind, ref.namespace, true);
  }
  for (const w of wanted.values()) w.namespaces.sort();
  return [...wanted.values()];
}

/** The other group of a Traefik group. */
export const otherGroup = (group: string) => (group === TRAEFIK_GROUP ? LEGACY_GROUP : TRAEFIK_GROUP);
