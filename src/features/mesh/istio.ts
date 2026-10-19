// The pure model of Istio's traffic objects (#155): hosts as Istio reads them, VirtualServices, DestinationRules,
// Gateways and ServiceEntries parsed into plain records the routing engine, the problem checks and the details share.
//
// Host rules (Istio's own):
//   - a short name (no dot) in a VirtualService, DestinationRule or destination is the Service of that name in the
//     object's namespace: `reviews` in `shop` → `reviews.shop.svc.cluster.local`; a name with a dot is taken as is;
//   - `*.example.com` matches any name ending in `.example.com` (more than one label too); `*` matches every host;
//   - an exact host is more specific than any wildcard, a longer wildcard more than a shorter one;
//   - `exportTo`: missing → everywhere, `.` → its own namespace, `~` → nowhere, `*` → everywhere, else the names.
// The cluster domain is taken to be `cluster.local` and the mesh root namespace `istio-system` (Istio's defaults; a
// mesh config that changes them is not read).
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import { DESTINATION_RULE, ISTIO_GATEWAY, SERVICE_ENTRY, VIRTUAL_SERVICE } from "./kinds";

const { arr, get, num, record, str } = status;

export const CLUSTER_DOMAIN = "cluster.local";
export const ROOT_NAMESPACE = "istio-system";
/** The gateway name of in-mesh (sidecar) traffic. */
export const MESH_GATEWAY = "mesh";

/** An object a result names. */
export interface Ref {
  kind: KindRef;
  namespace: string;
  name: string;
}

export function refOf(kind: KindRef, obj: KubeObject): Ref {
  return { kind, namespace: obj.metadata?.namespace ?? "", name: obj.metadata?.name ?? "" };
}

export const refKey = (r: Ref) => `${r.kind.group}/${r.kind.kind}/${r.namespace}/${r.name}`;

/** Creation time for Istio's "oldest first" rules (unknown last), then the name. */
export function olderFirst<T extends { obj: KubeObject }>(a: T, b: T): number {
  const ta = Date.parse(String(a.obj.metadata?.creationTimestamp ?? "")) || Number.MAX_SAFE_INTEGER;
  const tb = Date.parse(String(b.obj.metadata?.creationTimestamp ?? "")) || Number.MAX_SAFE_INTEGER;
  if (ta !== tb) return ta - tb;
  const na = `${a.obj.metadata?.namespace ?? ""}/${a.obj.metadata?.name ?? ""}`;
  const nb = `${b.obj.metadata?.namespace ?? ""}/${b.obj.metadata?.name ?? ""}`;
  return na.localeCompare(nb);
}

// ---------- Hosts ----------

/** A host of an object in `namespace` as Istio reads it: a short name becomes the Service's full name. */
export function resolveHost(host: string, namespace: string): string {
  const h = host.trim().toLowerCase();
  if (h === "" || h === "*" || h.includes(".")) return h;
  return `${h}.${namespace}.svc.${CLUSTER_DOMAIN}`;
}

/** Whether host pattern `pattern` (exact, `*` or `*.suffix`) covers the concrete `host`. */
export function hostMatches(pattern: string, host: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  if (pattern.startsWith("*")) return host.endsWith(pattern.slice(1));
  return pattern === host;
}

/** Whether two host patterns can match a common host (for conflicts). */
export function hostsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const wild = (h: string) => h.startsWith("*");
  if (!wild(a) && !wild(b)) return false;
  if (!wild(a)) return hostMatches(b, a);
  if (!wild(b)) return hostMatches(a, b);
  // Two wildcards overlap when one suffix ends with the other.
  const sa = a.slice(1);
  const sb = b.slice(1);
  return sa.endsWith(sb) || sb.endsWith(sa);
}

/** Exact hosts beat wildcards, longer wildcards beat shorter ones. */
export function hostSpecificity(pattern: string): number {
  if (!pattern.startsWith("*")) return 1_000_000 + pattern.length;
  return pattern.length - 1;
}

/** The Service a cluster-local host names (`name.ns.svc.cluster.local`), else `null`. */
export function serviceOfHost(host: string): { name: string; namespace: string } | null {
  const suffix = `.svc.${CLUSTER_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const parts = host.slice(0, -suffix.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0] === "*") return null;
  return { name: parts[0], namespace: parts[1] };
}

/**
 * The names a request's Host header can stand for, the way a sidecar's routes list a Service under `name`,
 * `name.ns`, `name.ns.svc` and the full name: a short name is the Service in the caller's namespace.
 */
export function requestHostAliases(host: string, sourceNamespace: string): string[] {
  const h = host.trim().toLowerCase();
  const out = [h];
  const labels = h.split(".");
  if (labels.length === 1) out.push(`${h}.${sourceNamespace}.svc.${CLUSTER_DOMAIN}`);
  else if (labels.length === 2) out.push(`${h}.svc.${CLUSTER_DOMAIN}`);
  else if (labels.length === 3 && labels[2] === "svc") out.push(`${h}.${CLUSTER_DOMAIN}`);
  return out;
}

/** Whether an object of `ownNamespace` with `exportTo` is visible in `namespace`. */
export function exportedTo(exportTo: readonly string[], ownNamespace: string, namespace: string): boolean {
  if (exportTo.length === 0) return true;
  return exportTo.some((e) => e === "*" || e === namespace || (e === "." && ownNamespace === namespace));
}

const strings = (value: unknown): string[] => arr(value).filter((v): v is string => typeof v === "string");

// ---------- String matches ----------

export interface StringMatch {
  type: "exact" | "prefix" | "regex";
  value: string;
}

export function stringMatch(value: unknown): StringMatch | undefined {
  for (const type of ["exact", "prefix", "regex"] as const) {
    const v = get(value, type);
    if (typeof v === "string") return { type, value: v };
  }
  return undefined;
}

/** `true`/`false`, or `undefined` for a regular expression JavaScript cannot read. */
export function testStringMatch(m: StringMatch, value: string, ignoreCase = false): boolean | undefined {
  const a = ignoreCase ? value.toLowerCase() : value;
  const b = ignoreCase ? m.value.toLowerCase() : m.value;
  if (m.type === "exact") return a === b;
  if (m.type === "prefix") return a.startsWith(b);
  try {
    // Istio's regular expressions are RE2 and match the whole value.
    return new RegExp(`^(?:${m.value})$`, ignoreCase ? "i" : undefined).test(value);
  } catch {
    return undefined;
  }
}

export const stringMatchText = (m: StringMatch) =>
  m.type === "exact" ? m.value : m.type === "prefix" ? `${m.value}*` : `~${m.value}`;

// ---------- VirtualService ----------

export interface HttpMatch {
  name?: string;
  uri?: StringMatch;
  ignoreUriCase: boolean;
  scheme?: StringMatch;
  method?: StringMatch;
  authority?: StringMatch;
  headers: [string, StringMatch | "present"][];
  withoutHeaders: [string, StringMatch | "present"][];
  queryParams: [string, StringMatch | "present"][];
  port?: number;
  sourceLabels?: Record<string, string>;
  sourceNamespace?: string;
  gateways?: string[];
}

export interface Destination {
  /** As written. */
  host: string;
  /** Resolved in the VirtualService's namespace. */
  fqdn: string;
  subset?: string;
  port?: number;
  /** Percent; missing on a single destination means all of it. */
  weight?: number;
}

export interface HttpRoute {
  index: number;
  name?: string;
  matches: HttpMatch[];
  destinations: Destination[];
  delegate?: { name: string; namespace: string };
  redirect?: Record<string, unknown>;
  directResponse?: { status?: number };
  rewrite?: Record<string, unknown>;
  timeout?: string;
  retries?: { attempts?: number; perTryTimeout?: string; retryOn?: string };
  fault?: { delayPercent?: number; delay?: string; abortPercent?: number; abortStatus?: number };
  mirror?: Destination;
  mirrorPercent?: number;
}

export interface L4Route {
  index: number;
  kind: "tcp" | "tls";
  /** Matched ports and SNI hosts, as written. */
  ports: number[];
  sniHosts: string[];
  destinations: Destination[];
}

export interface VirtualService {
  obj: KubeObject;
  ref: Ref;
  namespace: string;
  hosts: string[];
  /** Hosts resolved in its namespace. */
  fqdnHosts: string[];
  /** `mesh` and `namespace/name` of each gateway bound (missing → `mesh`). */
  gateways: string[];
  exportTo: string[];
  http: HttpRoute[];
  l4: L4Route[];
  /** A delegate: no hosts, used only through another VirtualService's `delegate`. */
  delegate: boolean;
}

/** `name` or `namespace/name` of a gateway, relative to `namespace`; `mesh` stays. */
export function gatewayKey(gateway: string, namespace: string): string {
  if (gateway === MESH_GATEWAY) return gateway;
  return gateway.includes("/") ? gateway : `${namespace}/${gateway}`;
}

function headerMap(value: unknown): [string, StringMatch | "present"][] {
  return Object.entries(record(value)).map(([name, m]) => [name.toLowerCase(), stringMatch(m) ?? "present"]);
}

function parseMatch(m: unknown, namespace: string): HttpMatch {
  const labels = record(get(m, "sourceLabels"));
  const gateways = strings(get(m, "gateways"));
  return {
    name: str(get(m, "name")),
    uri: stringMatch(get(m, "uri")),
    ignoreUriCase: get(m, "ignoreUriCase") === true,
    scheme: stringMatch(get(m, "scheme")),
    method: stringMatch(get(m, "method")),
    authority: stringMatch(get(m, "authority")),
    headers: headerMap(get(m, "headers")),
    withoutHeaders: headerMap(get(m, "withoutHeaders")),
    queryParams: Object.entries(record(get(m, "queryParams"))).map(([name, v]) => [name, stringMatch(v) ?? "present"]),
    port: num(get(m, "port")),
    sourceLabels: Object.keys(labels).length > 0 ? Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, String(v)])) : undefined,
    sourceNamespace: str(get(m, "sourceNamespace")),
    gateways: gateways.length > 0 ? gateways.map((g) => gatewayKey(g, namespace)) : undefined,
  };
}

export function parseDestination(d: unknown, namespace: string): Destination | undefined {
  const host = str(get(d, "destination", "host")) ?? str(get(d, "host"));
  if (!host) return undefined;
  const target = get(d, "destination") ?? d;
  return {
    host,
    fqdn: resolveHost(host, namespace),
    subset: str(get(target, "subset")) || undefined,
    port: num(get(target, "port", "number")),
    weight: num(get(d, "weight")),
  };
}

function parseHttpRoute(r: unknown, index: number, namespace: string): HttpRoute {
  const destinations = arr(get(r, "route"))
    .map((d) => parseDestination(d, namespace))
    .filter((d): d is Destination => !!d);
  const delegateName = str(get(r, "delegate", "name"));
  const retries = get(r, "retries");
  const fault = get(r, "fault");
  const mirror = get(r, "mirror");
  return {
    index,
    name: str(get(r, "name")),
    matches: arr(get(r, "match")).map((m) => parseMatch(m, namespace)),
    destinations,
    delegate: delegateName ? { name: delegateName, namespace: str(get(r, "delegate", "namespace")) || namespace } : undefined,
    redirect: get(r, "redirect") !== undefined ? record(get(r, "redirect")) : undefined,
    directResponse: get(r, "directResponse") !== undefined ? { status: num(get(r, "directResponse", "status")) } : undefined,
    rewrite: get(r, "rewrite") !== undefined ? record(get(r, "rewrite")) : undefined,
    timeout: str(get(r, "timeout")),
    retries:
      retries !== undefined
        ? { attempts: num(get(retries, "attempts")), perTryTimeout: str(get(retries, "perTryTimeout")), retryOn: str(get(retries, "retryOn")) }
        : undefined,
    fault:
      fault !== undefined
        ? {
            delay: str(get(fault, "delay", "fixedDelay")),
            delayPercent: num(get(fault, "delay", "percentage", "value")),
            abortStatus: num(get(fault, "abort", "httpStatus")),
            abortPercent: num(get(fault, "abort", "percentage", "value")),
          }
        : undefined,
    mirror: mirror !== undefined ? parseDestination({ destination: mirror }, namespace) : undefined,
    mirrorPercent: num(get(r, "mirrorPercentage", "value")),
  };
}

function parseL4(r: unknown, index: number, kind: "tcp" | "tls", namespace: string): L4Route {
  const matches = arr(get(r, "match"));
  return {
    index,
    kind,
    ports: matches.map((m) => num(get(m, "port"))).filter((p): p is number => p !== undefined),
    sniHosts: matches.flatMap((m) => strings(get(m, "sniHosts"))),
    destinations: arr(get(r, "route"))
      .map((d) => parseDestination(d, namespace))
      .filter((d): d is Destination => !!d),
  };
}

export function parseVirtualService(obj: KubeObject): VirtualService {
  const namespace = obj.metadata?.namespace ?? "";
  const hosts = strings(get(obj, "spec", "hosts"));
  const gateways = strings(get(obj, "spec", "gateways"));
  return {
    obj,
    ref: refOf(VIRTUAL_SERVICE, obj),
    namespace,
    hosts,
    fqdnHosts: hosts.map((h) => resolveHost(h, namespace)),
    gateways: gateways.length > 0 ? gateways.map((g) => gatewayKey(g, namespace)) : [MESH_GATEWAY],
    exportTo: strings(get(obj, "spec", "exportTo")),
    http: arr(get(obj, "spec", "http")).map((r, i) => parseHttpRoute(r, i, namespace)),
    l4: [
      ...arr(get(obj, "spec", "tcp")).map((r, i) => parseL4(r, i, "tcp", namespace)),
      ...arr(get(obj, "spec", "tls")).map((r, i) => parseL4(r, i, "tls", namespace)),
    ],
    delegate: hosts.length === 0,
  };
}

/**
 * Istio's validation refuses the host `*` on a VirtualService bound to the sidecars (`mesh`): such an object is
 * rejected as a whole, so it routes nothing (on any gateway).
 */
export function meshWildcardInvalid(vs: Pick<VirtualService, "gateways" | "hosts">): boolean {
  return vs.gateways.includes(MESH_GATEWAY) && vs.hosts.some((h) => h.trim() === "*");
}

/** Every destination a VirtualService sends to (HTTP, TCP and TLS routes, mirrors). */
export function allDestinations(vs: VirtualService): Destination[] {
  return [
    ...vs.http.flatMap((r) => [...r.destinations, ...(r.mirror ? [r.mirror] : [])]),
    ...vs.l4.flatMap((r) => r.destinations),
  ];
}

// ---------- DestinationRule ----------

export interface Subset {
  name: string;
  labels: Record<string, string>;
  tlsMode?: string;
}

export interface DestinationRuleInfo {
  obj: KubeObject;
  ref: Ref;
  namespace: string;
  host: string;
  fqdn: string;
  subsets: Subset[];
  /** `trafficPolicy.tls.mode`. */
  tlsMode?: string;
  portTls: { port: number; mode: string }[];
  loadBalancer?: string;
  exportTo: string[];
  /** A DestinationRule with a workload selector applies only to those clients' sidecars. */
  hasWorkloadSelector: boolean;
}

const stringRecord = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(record(value)).map(([k, v]) => [k, String(v)]));

export function parseDestinationRule(obj: KubeObject): DestinationRuleInfo {
  const namespace = obj.metadata?.namespace ?? "";
  const host = str(get(obj, "spec", "host")) ?? "";
  const policy = get(obj, "spec", "trafficPolicy");
  const lb = get(policy, "loadBalancer");
  return {
    obj,
    ref: refOf(DESTINATION_RULE, obj),
    namespace,
    host,
    fqdn: resolveHost(host, namespace),
    subsets: arr(get(obj, "spec", "subsets")).map((s) => ({
      name: str(get(s, "name")) ?? "",
      labels: stringRecord(get(s, "labels")),
      tlsMode: str(get(s, "trafficPolicy", "tls", "mode")),
    })),
    tlsMode: str(get(policy, "tls", "mode")),
    portTls: arr(get(policy, "portLevelSettings")).flatMap((p) => {
      const port = num(get(p, "port", "number"));
      const mode = str(get(p, "tls", "mode"));
      return port !== undefined && mode ? [{ port, mode }] : [];
    }),
    loadBalancer: str(get(lb, "simple")) ?? (get(lb, "consistentHash") !== undefined ? "CONSISTENT_HASH" : undefined),
    exportTo: strings(get(obj, "spec", "exportTo")),
    hasWorkloadSelector: get(obj, "spec", "workloadSelector") !== undefined,
  };
}

/**
 * The DestinationRule a client in `clientNamespace` uses for `host`: Istio looks in the client's namespace, then the
 * namespace of the Service, then the root namespace, taking at each the most specific host match visible there.
 * Rules with a workload selector are left out (they apply to some clients only).
 */
export function findDestinationRule(
  host: string,
  clientNamespace: string,
  rules: readonly DestinationRuleInfo[],
): DestinationRuleInfo | undefined {
  const serviceNamespace = serviceOfHost(host)?.namespace;
  const order = [clientNamespace, serviceNamespace, ROOT_NAMESPACE].filter((n): n is string => !!n);
  for (const ns of [...new Set(order)]) {
    const candidates = rules
      .filter((r) => r.namespace === ns && !r.hasWorkloadSelector && hostMatches(r.fqdn, host))
      .filter((r) => exportedTo(r.exportTo, r.namespace, clientNamespace))
      .sort((a, b) => hostSpecificity(b.fqdn) - hostSpecificity(a.fqdn) || olderFirst(a, b));
    if (candidates[0]) return candidates[0];
  }
  return undefined;
}

/** The TLS mode a DestinationRule sets for `port` (the port's own, then the rule's). */
export function ruleTlsMode(rule: DestinationRuleInfo, port: number | undefined, subset?: string): string | undefined {
  const sub = subset ? rule.subsets.find((s) => s.name === subset)?.tlsMode : undefined;
  if (sub) return sub;
  const own = port !== undefined ? rule.portTls.find((p) => p.port === port)?.mode : undefined;
  return own ?? rule.tlsMode;
}

// ---------- Gateway and ServiceEntry ----------

export interface GatewayServer {
  port?: number;
  protocol?: string;
  name?: string;
  /** Host parts, without a `namespace/` prefix. */
  hosts: string[];
  tlsMode?: string;
}

export interface IstioGatewayInfo {
  obj: KubeObject;
  ref: Ref;
  key: string;
  selector: Record<string, string>;
  servers: GatewayServer[];
}

export function parseIstioGateway(obj: KubeObject): IstioGatewayInfo {
  const ref = refOf(ISTIO_GATEWAY, obj);
  return {
    obj,
    ref,
    key: `${ref.namespace}/${ref.name}`,
    selector: stringRecord(get(obj, "spec", "selector")),
    servers: arr(get(obj, "spec", "servers")).map((s) => ({
      port: num(get(s, "port", "number")),
      protocol: str(get(s, "port", "protocol")),
      name: str(get(s, "port", "name")),
      hosts: strings(get(s, "hosts")).map((h) => (h.includes("/") ? h.slice(h.indexOf("/") + 1) : h).toLowerCase()),
      tlsMode: str(get(s, "tls", "mode")),
    })),
  };
}

export interface ServiceEntryInfo {
  obj: KubeObject;
  ref: Ref;
  hosts: string[];
  location?: string;
  resolution?: string;
  ports: { number?: number; protocol?: string; name?: string }[];
  exportTo: string[];
}

export function parseServiceEntry(obj: KubeObject): ServiceEntryInfo {
  const namespace = obj.metadata?.namespace ?? "";
  return {
    obj,
    ref: refOf(SERVICE_ENTRY, obj),
    hosts: strings(get(obj, "spec", "hosts")).map((h) => resolveHost(h, namespace)),
    location: str(get(obj, "spec", "location")),
    resolution: str(get(obj, "spec", "resolution")),
    ports: arr(get(obj, "spec", "ports")).map((p) => ({
      number: num(get(p, "number")),
      protocol: str(get(p, "protocol")),
      name: str(get(p, "name")),
    })),
    exportTo: strings(get(obj, "spec", "exportTo")),
  };
}
