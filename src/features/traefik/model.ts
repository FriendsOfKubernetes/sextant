// What the Traefik section reads from Traefik's CRDs (#232): the kinds it knows (group `traefik.io`, and the older
// `traefik.containo.us` where a cluster still serves it), the routes with their match rules, entry points, middlewares,
// TLS and services, and every reference an object makes to another object — in the shapes of Traefik's own types
// (`pkg/provider/kubernetes/crd/traefikio/v1alpha1`). Traefik writes no status on any of these kinds, so nothing here
// reads one: what can be judged is whether the objects the references name exist (`resolve.ts`). Pure.
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
  /** Key under `traefik:sidebar`. */
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

export const sameKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) =>
  a.group === b.group && a.kind === b.kind;

/** The same kind in either group (`IngressRoute` of `traefik.io` or of `traefik.containo.us`). */
export const isTraefik = (kind: Pick<KindRef, "group" | "kind">, of: Pick<KindRef, "kind">) =>
  (TRAEFIK_GROUPS as readonly string[]).includes(kind.group) && kind.kind === of.kind;

export function traefikKind(kind: Pick<KindRef, "group" | "kind">): TraefikKind | undefined {
  return TRAEFIK_KINDS.find((d) => sameKind(d.kind, kind));
}

export const isRouteKind = (kind: Pick<KindRef, "group" | "kind">) =>
  isTraefik(kind, INGRESS_ROUTE) || isTraefik(kind, INGRESS_ROUTE_TCP) || isTraefik(kind, INGRESS_ROUTE_UDP);

/** `apiVersion` for a link to a Traefik kind (the details resolve the served version). */
export const apiVersionOf = (kind: Pick<KindRef, "group" | "version">) => (kind.group ? `${kind.group}/${kind.version}` : kind.version);

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

// ---------- The other kinds ----------

/** A TraefikService's strategy: the one of its fields that is set. */
export type TraefikServiceType = "weighted" | "mirroring" | "highestRandomWeight" | "failover";

export function traefikServiceType(obj: KubeObject): TraefikServiceType | undefined {
  const spec = get(obj, "spec");
  return (["weighted", "mirroring", "highestRandomWeight", "failover"] as const).find((t) => get(spec, t) !== undefined);
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
