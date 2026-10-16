// Reverse links of the Gateway API, as pure functions over objects the views list: which listeners of a Gateway a
// route sits on (and under which hostnames), how a Service is reached from outside (Gateway API routes and
// Ingresses: addresses, route, Gateway and listener, status), which listeners use a TLS Secret and which policies
// target an object. Built on `model.ts`; the topology of a Gateway uses `routeListeners` too.
//
//   hostnameIntersection(listenerHost, routeHosts)  // the hostnames a route serves on a listener; null: none
//   routeListeners(route, kind, gateway)            // the listeners the route sits on, with its parent entry there
//   serviceExposures(service, …)                    // one row per route × parent × listener reaching the Service
//   ingressExposures(service, ingresses)            // one row per Ingress host/path reaching the Service
//   listenersUsingSecret(secret, gateways)          // the listeners whose TLS certificates name the Secret
//   policiesTargeting(obj, policies)                // policies whose targetRefs name the object
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import { intersectHostnames } from "./matching";
import {
  backendIssue,
  gatewayAddresses,
  GATEWAY_GROUP,
  isCrossNamespace,
  listenerStatuses,
  parentStatuses,
  policyTargets,
  referencePermitted,
  routeAttachedTo,
  routeHostnames,
  routeRules,
  unpermittedCertificates,
  type BackendRef,
  type Health,
  type ListenerStatus,
  type ObjRef,
  type ParentStatus,
  type RouteRule,
} from "./model";

const { arr, get, str } = status;

type KindLike = Pick<KindRef, "group" | "kind">;

// ---------- Listeners a route sits on ----------

/** The route kinds a listener of each protocol takes when neither it nor its controller lists any. */
const PROTOCOL_KINDS: Record<string, string[]> = {
  HTTP: ["HTTPRoute", "GRPCRoute"],
  HTTPS: ["HTTPRoute", "GRPCRoute"],
  TLS: ["TLSRoute", "TCPRoute"],
  TCP: ["TCPRoute"],
  UDP: ["UDPRoute"],
};

/** Whether `listener` takes routes of `routeKind`: what the controller supports there, else what it allows. */
export function listenerAccepts(listener: Pick<ListenerStatus, "supportedKinds" | "allowedKinds" | "protocol">, routeKind: string) {
  if (listener.supportedKinds.length > 0) return listener.supportedKinds.includes(routeKind);
  if (listener.allowedKinds.length > 0) return listener.allowedKinds.includes(routeKind);
  // An implementation-specific protocol: the controller decides.
  return PROTOCOL_KINDS[listener.protocol]?.includes(routeKind) ?? true;
}

/**
 * The hostnames a route serves on a listener (Gateway API hostname intersection, `intersectHostnames`): the more
 * specific of each matching pair. `[]` when neither names one (any hostname); `null` when they do not intersect.
 */
export function hostnameIntersection(listenerHost: string | undefined, routeHosts: readonly string[]): string[] | null {
  if (routeHosts.length === 0) return listenerHost ? [listenerHost] : [];
  const result = routeHosts.flatMap((h) => intersectHostnames(h, listenerHost) ?? []);
  return result.length > 0 ? [...new Set(result)] : null;
}

/** A listener a route sits on: the route's parent entry for it and the hostnames it serves there. */
export interface RouteOnListener {
  listener: ListenerStatus;
  parent: ParentStatus;
  /** `[]`: any hostname. */
  hostnames: string[];
}

/**
 * The listeners of `gateway` the route sits on: its parentRef can attach there (sectionName, port), the listener takes
 * the route's kind and their hostnames intersect. A parent the controller accepted keeps every listener it can name
 * even when this check disagrees (the controller knows its protocols better).
 */
export function routeListeners(route: KubeObject, kind: KindLike, gateway: KubeObject): RouteOnListener[] {
  const routeHosts = routeHostnames(route);
  const named = listenerStatuses(gateway).flatMap((listener) => {
    const parent = routeAttachedTo(route, gateway, listener);
    return parent ? [{ listener, parent }] : [];
  });
  const fitting = named.flatMap(({ listener, parent }) => {
    const hostnames = listenerAccepts(listener, kind.kind) ? hostnameIntersection(listener.hostname, routeHosts) : null;
    return hostnames ? [{ listener, parent, hostnames }] : [];
  });
  // Parents with no fitting listener that the controller accepted anyway.
  const accepted = named.filter(
    ({ parent }) => parent.accepted?.status === "True" && !fitting.some((f) => f.parent === parent),
  );
  return [...fitting, ...accepted.map(({ listener, parent }) => ({ listener, parent, hostnames: [...routeHosts] }))];
}

/** The route's parents naming `gateway` that sit on none of its listeners (rejected, or not processed yet). */
export function unplacedParents(route: KubeObject, kind: KindLike, gateway: KubeObject): ParentStatus[] {
  const placed = routeListeners(route, kind, gateway).map((r) => r.parent);
  const ns = gateway.metadata?.namespace ?? null;
  return parentStatuses(route).filter(
    (p) =>
      p.ref.group === GATEWAY_GROUP &&
      p.ref.kind === "Gateway" &&
      p.ref.name === gateway.metadata?.name &&
      p.ref.namespace === ns &&
      !placed.some((q) => sameParentStatus(q, p)),
  );
}

const sameParentStatus = (a: ParentStatus, b: ParentStatus) =>
  a.ref.name === b.ref.name &&
  a.ref.namespace === b.ref.namespace &&
  a.ref.sectionName === b.ref.sectionName &&
  a.ref.port === b.ref.port;

// ---------- Addresses ----------

const SCHEMES: Record<string, string> = { HTTP: "http", HTTPS: "https", TLS: "tls", TCP: "tcp", UDP: "udp" };
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

/**
 * The external addresses of a listener for some hostnames and paths: `https://api.example.com/api`. Without a
 * hostname the Gateway's first address stands in (`*` when it has none); the port is shown unless it is the scheme's
 * default; TCP, UDP and TLS addresses have no path.
 */
export function listenerAddresses(
  listener: Pick<ListenerStatus, "protocol" | "port">,
  hostnames: readonly string[],
  paths: readonly string[],
  gatewayAddress: string | undefined,
): string[] {
  const scheme = SCHEMES[listener.protocol] ?? listener.protocol.toLowerCase();
  const port = listener.port !== undefined && listener.port !== DEFAULT_PORTS[scheme] ? `:${listener.port}` : "";
  const hosts = hostnames.length > 0 ? hostnames : [gatewayAddress ?? "*"];
  const withPaths = scheme === "http" || scheme === "https" ? (paths.length > 0 ? paths : ["/"]) : [""];
  return hosts.flatMap((h) => withPaths.map((p) => `${scheme}://${h}${port}${p}`));
}

/** The path of each HTTP match of a rule (`PathPrefix /api` → `/api`; no path → `/`), from its phrases. */
export function rulePaths(rule: RouteRule, http: boolean): string[] {
  if (!http) return [];
  if (rule.matches.length === 0) return ["/"];
  return rule.matches.map((m) => String(m.find((p) => p.key === "gateway:text.path")?.params?.value ?? "/"));
}

// ---------- A Service reached through routes ----------

/** How traffic for the Service fares on one route × parent × listener. */
export type ExposureState = "serving" | "mirror" | "redirect" | "notAttached" | "notPermitted" | "pending";

export interface Exposure {
  key: string;
  /** External addresses; empty when the route sits on no listener there. */
  addresses: string[];
  routeKind: string;
  route: ObjRef;
  /** The parent (a Gateway, usually) and the listener the route sits on, if any. */
  parent: ParentStatus;
  listener?: string;
  state: ExposureState;
  health: Health;
  /** A condition reason that says why it is not serving. */
  reason?: string;
}

/** What `serviceExposures` knows about the cluster: the routes of each served kind, the Gateways, the grants. */
export interface ExposureContext {
  routes: readonly { kind: KindLike; items: readonly KubeObject[] }[];
  /** The Gateway a parent names, if listed. */
  gatewayOf: (ref: ObjRef) => KubeObject | undefined;
  /** The ReferenceGrants of a namespace; `undefined` while unknown. */
  grantsIn?: (namespace: string) => readonly KubeObject[] | undefined;
}

const isTheService = (b: BackendRef, service: { namespace: string; name: string }) =>
  b.group === "" && b.kind === "Service" && b.name === service.name && b.namespace === service.namespace;

/** Every route (of any served kind, in any namespace) whose rules send to or mirror the Service. */
export function routesReaching(
  routes: ExposureContext["routes"],
  service: { namespace: string; name: string },
): { kind: KindLike; route: KubeObject; rules: RouteRule[] }[] {
  return routes.flatMap(({ kind, items }) =>
    items.flatMap((route) => {
      const rules = routeRules(route, kind).filter((r) =>
        [...r.backends, ...r.mirrors].some((b) => isTheService(b, service)),
      );
      return rules.length > 0 ? [{ kind, route, rules }] : [];
    }),
  );
}

/**
 * How the Service is reached from outside through Gateway API routes: one row per route, parent and listener, with
 * the external addresses (hostnames × the paths of the rules that reach it) and the state there:
 *  - `notPermitted` — the route is in another namespace and no ReferenceGrant in the Service's lets it refer there;
 *  - `notAttached` — the parent rejected the route (with the reason); `pending` — no controller has reported it;
 *  - `redirect` — every rule reaching it redirects instead; `mirror` — it only gets copies of requests;
 *  - `serving` otherwise.
 */
export function serviceExposures(service: KubeObject, context: ExposureContext): Exposure[] {
  const svc = { namespace: service.metadata?.namespace ?? "", name: service.metadata?.name ?? "" };
  return routesReaching(context.routes, svc).flatMap(({ kind, route, rules }) => {
    const ns = route.metadata?.namespace ?? null;
    const name = route.metadata?.name ?? "";
    const routeRef: ObjRef = { group: GATEWAY_GROUP, kind: kind.kind, name, namespace: ns };
    const http = kind.kind === "HTTPRoute";
    const paths = [...new Set(rules.flatMap((r) => rulePaths(r, http)))];
    const asBackend = rules.some((r) => r.backends.some((b) => isTheService(b, svc)));
    const redirectsOnly = rules.every((r) => r.filterTypes.includes("RequestRedirect"));
    const backend = [...rules.flatMap((r) => [...r.backends, ...r.mirrors])].find((b) => isTheService(b, svc))!;

    const stateOf = (parent: ParentStatus): Pick<Exposure, "state" | "health" | "reason"> => {
      const issue = backendIssue(backend, { routeNamespace: ns, routeKind: kind.kind, parents: [parent], grantsIn: context.grantsIn });
      const grants = context.grantsIn?.(svc.namespace);
      const denied =
        issue === "RefNotPermitted" ||
        (ns !== null &&
          isCrossNamespace(backend, ns) &&
          grants !== undefined &&
          !referencePermitted(grants, { group: GATEWAY_GROUP, kind: kind.kind, namespace: ns }, backend));
      if (denied) return { state: "notPermitted", health: "problem", reason: "RefNotPermitted" };
      if (parent.accepted?.status === "False" && parent.health === "problem")
        return { state: "notAttached", health: "problem", reason: parent.accepted.reason };
      if (parent.health === "pending") return { state: "pending", health: "pending", reason: parent.problem?.reason };
      if (redirectsOnly) return { state: "redirect", health: "ok" };
      return asBackend ? { state: "serving", health: "ok" } : { state: "mirror", health: "ok" };
    };

    return parentStatuses(route).flatMap((parent, i): Exposure[] => {
      const base = { routeKind: kind.kind, route: routeRef, parent, ...stateOf(parent) };
      const key = `${kind.kind}/${ns ?? ""}/${name}/${i}`;
      const gateway = parent.ref.kind === "Gateway" && parent.ref.group === GATEWAY_GROUP ? context.gatewayOf(parent.ref) : undefined;
      const placed = gateway ? routeListeners(route, kind, gateway).filter((r) => sameParentStatus(r.parent, parent)) : [];
      if (placed.length === 0) return [{ ...base, key, addresses: [] }];
      const address = gatewayAddresses(gateway!)[0];
      return placed.map(({ listener, hostnames }) => ({
        ...base,
        key: `${key}/${listener.name}`,
        listener: listener.name,
        addresses: listenerAddresses(listener, hostnames, paths, address),
      }));
    });
  });
}

// ---------- A Service reached through Ingresses ----------

export interface IngressExposure {
  key: string;
  ingress: ObjRef;
  /** `https://shop.example.com/cart`; the host is the load balancer's address (or `*`) when the rule names none. */
  address: string;
  ingressClass?: string;
  /** `ok` when the Ingress got a load-balancer address, `pending` while it has none. */
  health: Health;
}

/** The Ingresses (in the Service's namespace) whose rules or default backend send to the Service. */
export function ingressExposures(service: KubeObject, ingresses: Iterable<KubeObject>): IngressExposure[] {
  const ns = service.metadata?.namespace ?? null;
  const name = service.metadata?.name;
  const reaches = (backend: unknown) => str(get(backend, "service", "name")) === name;
  const result: IngressExposure[] = [];
  for (const ing of ingresses) {
    if ((ing.metadata?.namespace ?? null) !== ns) continue;
    const spec = get(ing, "spec");
    const lb = arr(get(ing, "status", "loadBalancer", "ingress"))
      .map((i) => str(get(i, "ip")) ?? str(get(i, "hostname")))
      .filter((v): v is string => Boolean(v));
    const tlsHosts = arr(get(spec, "tls")).flatMap((t) => arr(get(t, "hosts")).filter((h): h is string => typeof h === "string"));
    const tlsAll = arr(get(spec, "tls")).some((t) => arr(get(t, "hosts")).length === 0);
    const ingressClass =
      str(get(spec, "ingressClassName")) ?? str(get(ing, "metadata", "annotations", "kubernetes.io/ingress.class"));
    const ref: ObjRef = { group: "networking.k8s.io", kind: "Ingress", name: ing.metadata?.name ?? "", namespace: ns };
    const health: Health = lb.length > 0 ? "ok" : "pending";
    const address = (host: string | undefined, path: string) => {
      const scheme = (host && tlsHosts.includes(host)) || tlsAll ? "https" : "http";
      return `${scheme}://${host ?? lb[0] ?? "*"}${path}`;
    };
    const rows: string[] = [];
    for (const rule of arr(get(spec, "rules"))) {
      const host = str(get(rule, "host"));
      for (const p of arr(get(rule, "http", "paths"))) {
        if (reaches(get(p, "backend"))) rows.push(address(host, str(get(p, "path")) ?? "/"));
      }
    }
    if (reaches(get(spec, "defaultBackend"))) rows.push(address(undefined, "/"));
    for (const addr of [...new Set(rows)]) {
      result.push({ key: `${ref.namespace ?? ""}/${ref.name}/${addr}`, ingress: ref, address: addr, ingressClass, health });
    }
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------- A TLS Secret used by listeners ----------

export interface SecretUse {
  key: string;
  gateway: ObjRef;
  listener: ListenerStatus;
  /** The Gateway is in another namespace and no ReferenceGrant in the Secret's lets it use the Secret. */
  notPermitted: boolean;
}

/** The listeners (of any Gateway) whose TLS certificates name the Secret. */
export function listenersUsingSecret(
  secret: KubeObject,
  gateways: Iterable<KubeObject>,
  grantsIn?: (namespace: string) => readonly KubeObject[] | undefined,
): SecretUse[] {
  const ns = secret.metadata?.namespace ?? null;
  const name = secret.metadata?.name;
  const result: SecretUse[] = [];
  for (const gw of gateways) {
    const gwRef: ObjRef = { group: GATEWAY_GROUP, kind: "Gateway", name: gw.metadata?.name ?? "", namespace: gw.metadata?.namespace ?? null };
    for (const listener of listenerStatuses(gw)) {
      const ref = listener.certificateRefs.find((r) => r.group === "" && r.kind === "Secret" && r.name === name && r.namespace === ns);
      if (!ref) continue;
      const notPermitted = unpermittedCertificates(gw, { certificateRefs: [ref] }, grantsIn).length > 0;
      result.push({ key: `${gwRef.namespace ?? ""}/${gwRef.name}/${listener.name}`, gateway: gwRef, listener, notPermitted });
    }
  }
  return result.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------- Policies attached to an object ----------

/** The policies whose targetRefs name `obj` (of `kind`), with the sectionName each names, if any. */
export function policiesTargeting(
  obj: KubeObject,
  kind: KindLike,
  policies: Iterable<KubeObject>,
): { policy: KubeObject; sectionNames: string[] }[] {
  const ns = obj.metadata?.namespace ?? null;
  const name = obj.metadata?.name;
  const result: { policy: KubeObject; sectionNames: string[] }[] = [];
  for (const policy of policies) {
    const hits = policyTargets(policy).filter(
      (t) => t.group === kind.group && t.kind === kind.kind && t.name === name && t.namespace === ns,
    );
    if (hits.length > 0) {
      result.push({ policy, sectionNames: hits.flatMap((h) => (h.sectionName ? [h.sectionName] : [])) });
    }
  }
  return result;
}
