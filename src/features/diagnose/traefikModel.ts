// What the traffic diagnosis of a Traefik IngressRoute (`traefik.ts`, #232, ADR-0108) reads from Traefik's CRDs: the
// groups (`traefik.io`, and the older `traefik.containo.us` where a cluster still serves it), a route's match rules,
// entry points, middlewares, TLS and services, a TraefikService's children, and what a reference finds — in the shapes
// of Traefik's own types (`pkg/provider/kubernetes/crd/traefikio/v1alpha1`). Pure functions, no React. The Traefik
// views themselves are Sextant's own extension `extensions/traefik` since 0.30 (ADR-0162 amendment); the diagnosis
// stays Sextant's own, for the window and agents' `diagnose_service`.
//
// Traefik writes no status on any of these kinds, so what can be judged is whether the objects the references name
// exist. What cannot be judged stays open, never "fine" and never "broken":
//   - a reference into another namespace: Traefik follows it only when the provider runs with `allowCrossNamespace`
//     (off by default), a flag of Traefik's static configuration that no object shows;
//   - `name@provider`: an object of another provider (file, …) Sextant cannot see — except Traefik's own `@internal`
//     services (`api@internal`, `noop@internal`, …), which always exist;
//   - a list Sextant could not read.
// Where a cluster serves both groups, Traefik v3 reads only `traefik.io`: a reference from a `traefik.io` object is
// looked up there, and a target that exists only in `traefik.containo.us` is "legacy only" (Traefik 2.10 reads both,
// v3 does not; which one runs no object shows) — open, never fine and never broken.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";

const { arr, get, num, str } = status;

export const TRAEFIK_GROUP = "traefik.io";
/** Traefik v2's group; Traefik 2.10 reads both, v3 only `traefik.io`. */
export const LEGACY_GROUP = "traefik.containo.us";
export const TRAEFIK_GROUPS = [TRAEFIK_GROUP, LEGACY_GROUP] as const;

const k = (group: string, kind: string): KindRef => ({ group, version: "v1alpha1", kind });

export const INGRESS_ROUTE = k(TRAEFIK_GROUP, "IngressRoute");
export const INGRESS_ROUTE_TCP = k(TRAEFIK_GROUP, "IngressRouteTCP");
export const INGRESS_ROUTE_UDP = k(TRAEFIK_GROUP, "IngressRouteUDP");

/** The same kind in either group (`IngressRoute` of `traefik.io` or of `traefik.containo.us`). */
export const isTraefik = (kind: Pick<KindRef, "group" | "kind">, of: Pick<KindRef, "kind">) =>
  (TRAEFIK_GROUPS as readonly string[]).includes(kind.group) && kind.kind === of.kind;

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

// ---------- TraefikServices ----------

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

// ---------- What a reference finds ----------

export type RefState = "found" | "missing" | "crossNamespace" | "otherProvider" | "unknown" | "badKind" | "legacyOnly";

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
