// What the Contour section reads from Contour's objects (#233): the kinds it knows (HTTPProxy,
// TLSCertificateDelegation, ExtensionService), an HTTPProxy's status as Contour writes it (`currentStatus` valid /
// invalid / orphaned / NotReconciled and the `Valid` DetailedCondition with its `errors` and `warnings`), its
// virtual host, TLS (a Secret of another namespace through a TLSCertificateDelegation), routes with their match
// conditions, services with weights and mirrors, includes and the policies attached to it. Pure functions, no React;
// texts are i18n keys under `contour:` with their values.
//
// Semantics follow Contour's own processor (internal/dag/httpproxy_processor.go): Services are looked up in the
// proxy's own namespace; a proxy without `virtualhost` is served only when a root includes it (otherwise Contour marks
// it orphaned); include prefixes concatenate from the root down; with no weights the services of a route share
// equally, with some weights a service without one gets nothing; a mirror's weight is the percent mirrored (none: 100).
// Contour's `--root-namespaces` flag is not visible to Sextant: a root outside them is told only by the status
// (RootNamespaceError).
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, record, str } = status;

export const CONTOUR_GROUP = "projectcontour.io";

const k = (version: string, kind: string): KindRef => ({ group: CONTOUR_GROUP, version, kind });

export const HTTP_PROXY = k("v1", "HTTPProxy");
export const TLS_DELEGATION = k("v1", "TLSCertificateDelegation");
export const EXTENSION_SERVICE = k("v1alpha1", "ExtensionService");

export interface ContourKind {
  kind: KindRef;
  order: number;
  /** Key under `contour:sidebar`. */
  label: string;
}

export const CONTOUR_KINDS: readonly ContourKind[] = [
  { kind: HTTP_PROXY, order: 10, label: "httpProxies" },
  { kind: TLS_DELEGATION, order: 20, label: "tlsDelegations" },
  { kind: EXTENSION_SERVICE, order: 30, label: "extensionServices" },
];

export const sameKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) =>
  a.group === b.group && a.kind === b.kind;

export function contourKind(kind: Pick<KindRef, "group" | "kind">): ContourKind | undefined {
  return CONTOUR_KINDS.find((d) => sameKind(d.kind, kind));
}

/** `apiVersion` for a link to a Contour kind (the details resolve the served version). */
export const apiVersionOf = (kind: KindRef) => `${kind.group}/${kind.version}`;

// ---------- Status ----------

/** One entry of a DetailedCondition's `errors` or `warnings`. */
export interface SubCondition {
  type: string;
  reason?: string;
  message?: string;
}

export interface DetailedCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  errors: SubCondition[];
  warnings: SubCondition[];
}

function subConditions(list: unknown): SubCondition[] {
  return arr(list).flatMap((c) => {
    const type = str(get(c, "type"));
    return type ? [{ type, reason: str(get(c, "reason")), message: str(get(c, "message")) }] : [];
  });
}

/** The `Valid` condition Contour writes on an HTTPProxy or an ExtensionService. */
export function validCondition(obj: KubeObject): DetailedCondition | undefined {
  const c = arr(get(obj, "status", "conditions")).find((x) => get(x, "type") === "Valid");
  const value = str(get(c, "status"));
  if (!c || !value) return undefined;
  return {
    type: "Valid",
    status: value,
    reason: str(get(c, "reason")),
    message: str(get(c, "message")),
    lastTransitionTime: str(get(c, "lastTransitionTime")),
    errors: subConditions(get(c, "errors")),
    warnings: subConditions(get(c, "warnings")),
  };
}

/**
 * An HTTPProxy's state as Contour says it: `valid`, `invalid`, `orphaned` (no root includes it), or `pending` — no
 * status yet, or the CRD's default `NotReconciled` ("Waiting for controller"): no Contour has processed it.
 */
export type ProxyState = "valid" | "invalid" | "orphaned" | "pending";

export function proxyState(obj: KubeObject): ProxyState {
  const current = str(get(obj, "status", "currentStatus"));
  if (current === "valid" || current === "invalid" || current === "orphaned") return current;
  // An older or unusual status: the Valid condition decides.
  const valid = validCondition(obj);
  if (valid?.status === "True") return "valid";
  if (valid?.status === "False") return valid.errors.some((e) => e.type === "Orphaned") ? "orphaned" : "invalid";
  return "pending";
}

export const description = (obj: KubeObject) => str(get(obj, "status", "description"));

export type Health = "ready" | "progressing" | "failed" | "unknown";

export const HEALTH_TONE: Record<Health, Tone> = { ready: "success", progressing: "warning", failed: "danger", unknown: "muted" };

const PROXY_HEALTH: Record<ProxyState, Health> = { valid: "ready", invalid: "failed", orphaned: "failed", pending: "progressing" };

/** An HTTPProxy by its state; an ExtensionService by its Valid condition (none yet: unknown). */
export function healthOf(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Health {
  if (sameKind(kind, HTTP_PROXY)) return PROXY_HEALTH[proxyState(obj)];
  const valid = validCondition(obj)?.status;
  return valid === "True" ? "ready" : valid === "False" ? "failed" : valid === "Unknown" ? "progressing" : "unknown";
}

/** The first error Contour reports (what the status column's reason and a problem name). */
export function firstError(obj: KubeObject): SubCondition | undefined {
  return validCondition(obj)?.errors[0];
}

/** A problem of the problems screen and the "Only problems" filter: invalid or orphaned. */
export function isProblem(obj: KubeObject): boolean {
  const state = proxyState(obj);
  return state === "invalid" || state === "orphaned";
}

/**
 * Errors after which Contour still serves the rest of the proxy: a Service it cannot resolve is left out of its route
 * (no service left: 503), an include it cannot follow answers 502. Any other error drops the virtual host or every
 * route of the proxy.
 */
const PARTIAL_ERRORS = new Set(["ServiceUnresolvedReference", "IncludeNotFound", "RootIncludesRoot", "DuplicateMatchConditions", "PathMatchConditionsNotValid"]);

export function servedInPart(obj: KubeObject): boolean {
  const errors = validCondition(obj)?.errors ?? [];
  return errors.length > 0 && errors.every((e) => (e.type === "ServiceError" || e.type === "IncludeError") && PARTIAL_ERRORS.has(e.reason ?? ""));
}

// ---------- Spec ----------

export const isRoot = (obj: KubeObject) => get(obj, "spec", "virtualhost") !== undefined && get(obj, "spec", "virtualhost") !== null;
export const fqdnOf = (obj: KubeObject) => str(get(obj, "spec", "virtualhost", "fqdn"));
export const ingressClassOf = (obj: KubeObject) =>
  str(get(obj, "spec", "ingressClassName")) ?? str(record(obj.metadata?.annotations)["projectcontour.io/ingress.class"]);

/** A Secret named `name` or `namespace/name` (delegated through a TLSCertificateDelegation). */
export interface SecretRef {
  namespace: string;
  name: string;
  /** In another namespace than the proxy's: Contour needs a TLSCertificateDelegation there. */
  delegated: boolean;
}

export function secretRef(value: string | undefined, own: string): SecretRef | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash < 0) return { namespace: own, name: value, delegated: false };
  const namespace = value.slice(0, slash);
  return { namespace, name: value.slice(slash + 1), delegated: namespace !== own };
}

export interface ProxyTls {
  secret?: SecretRef;
  passthrough: boolean;
  minimumProtocolVersion?: string;
  maximumProtocolVersion?: string;
  fallbackCertificate: boolean;
  /** Client certificates are checked (`clientValidation`). */
  clientValidation: boolean;
}

export function tlsOf(obj: KubeObject): ProxyTls | undefined {
  const tls = get(obj, "spec", "virtualhost", "tls");
  if (!tls || typeof tls !== "object") return undefined;
  return {
    secret: secretRef(str(get(tls, "secretName")), obj.metadata?.namespace ?? ""),
    passthrough: get(tls, "passthrough") === true,
    minimumProtocolVersion: str(get(tls, "minimumProtocolVersion")),
    maximumProtocolVersion: str(get(tls, "maximumProtocolVersion")),
    fallbackCertificate: get(tls, "enableFallbackCertificate") === true,
    clientValidation: Boolean(get(tls, "clientValidation")),
  };
}

/**
 * Match conditions as Contour's field syntax (`prefix=/api`, `header x-env exact=prod`), joined with AND by Contour;
 * field names stay English in every language.
 */
export function conditionTexts(list: unknown): string[] {
  return arr(list).flatMap((c) => {
    const out: string[] = [];
    for (const field of ["prefix", "exact", "regex"]) {
      const v = str(get(c, field));
      if (v !== undefined) out.push(`${field}=${v}`);
    }
    for (const field of ["header", "queryParameter"]) {
      const m = get(c, field);
      if (!m || typeof m !== "object") continue;
      const ops = Object.entries(record(m))
        .filter(([op]) => op !== "name" && op !== "ignoreCase" && op !== "treatMissingAsEmpty")
        .map(([op, v]) => (v === true ? op : `${op}=${String(v)}`));
      out.push(`${field} ${str(get(m, "name")) ?? ""} ${ops.join(" ")}`.trim());
    }
    return out;
  });
}

/** The path prefix of a list of conditions (`/` when none). */
export function prefixOf(list: unknown): string | undefined {
  return arr(list)
    .map((c) => str(get(c, "prefix")))
    .find((p): p is string => p !== undefined);
}

/** Prefixes along an include path, concatenated as Contour does (`/api` + `/v1` = `/api/v1`). */
export function joinPrefixes(prefixes: readonly (string | undefined)[]): string {
  const joined = prefixes
    .filter((p): p is string => Boolean(p) && p !== "/")
    .map((p) => p.replace(/\/+$/, ""))
    .join("");
  return joined === "" ? "/" : joined;
}

export interface ProxyService {
  name: string;
  port?: number;
  weight?: number;
  mirror: boolean;
  protocol?: string;
}

function servicesOf(list: unknown): ProxyService[] {
  return arr(list).flatMap((s) => {
    const name = str(get(s, "name"));
    if (!name) return [];
    return [{ name, port: num(get(s, "port")), weight: num(get(s, "weight")), mirror: get(s, "mirror") === true, protocol: str(get(s, "protocol")) }];
  });
}

/**
 * Each service's share of a route's requests in percent, as Contour sets the Envoy clusters: no weights at all → an
 * equal split; some weights → by weight, a service without one (or 0) gets nothing. A mirror gets no share: its own
 * value is the percent of requests copied to it (its weight, none or 0 meaning 100).
 */
export function shares(services: readonly ProxyService[]): number[] {
  const serving = services.filter((s) => !s.mirror);
  const total = serving.reduce((sum, s) => sum + Math.max(0, s.weight ?? 0), 0);
  return services.map((s) => {
    if (s.mirror) return s.weight && s.weight > 0 ? Math.min(100, s.weight) : 100;
    if (total === 0) return serving.length > 0 ? 100 / serving.length : 0;
    return (Math.max(0, s.weight ?? 0) / total) * 100;
  });
}

/** Route fields that attach a policy, in the order the details list them. */
const ROUTE_POLICIES = [
  "authPolicy",
  "rateLimitPolicy",
  "timeoutPolicy",
  "retryPolicy",
  "healthCheckPolicy",
  "loadBalancerPolicy",
  "pathRewritePolicy",
  "requestHeadersPolicy",
  "responseHeadersPolicy",
  "cookieRewritePolicies",
  "internalRedirectPolicy",
  "jwtVerificationPolicy",
  "ipAllowPolicy",
  "ipDenyPolicy",
];

/** Virtual host fields that attach a policy to every route of the host. */
const HOST_POLICIES = ["authorization", "rateLimitPolicy", "corsPolicy", "jwtProviders", "ipAllowPolicy", "ipDenyPolicy"];

const present = (value: unknown) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

export interface ProxyRoute {
  index: number;
  conditions: string[];
  prefix?: string;
  services: ProxyService[];
  /** Field names of the policies set on the route. */
  policies: string[];
  redirect: boolean;
  /** `directResponsePolicy.statusCode`. */
  directResponse?: number;
  permitInsecure: boolean;
  websockets: boolean;
}

export function routesOf(obj: KubeObject): ProxyRoute[] {
  return arr(get(obj, "spec", "routes")).map((r, index) => ({
    index,
    conditions: conditionTexts(get(r, "conditions")),
    prefix: prefixOf(get(r, "conditions")),
    services: servicesOf(get(r, "services")),
    policies: ROUTE_POLICIES.filter((p) => present(get(r, p))),
    redirect: present(get(r, "requestRedirectPolicy")),
    directResponse: num(get(r, "directResponsePolicy", "statusCode")),
    permitInsecure: get(r, "permitInsecure") === true,
    websockets: get(r, "enableWebsockets") === true,
  }));
}

/** Field names of the policies on the virtual host. */
export const hostPoliciesOf = (obj: KubeObject) => HOST_POLICIES.filter((p) => present(get(obj, "spec", "virtualhost", p)));

/** The ExtensionService of the virtual host's `authorization` (in the proxy's namespace unless it names one). */
export function authorizationRef(obj: KubeObject): { namespace: string; name: string } | undefined {
  const ref = get(obj, "spec", "virtualhost", "authorization", "extensionRef");
  const name = str(get(ref, "name"));
  return name ? { name, namespace: str(get(ref, "namespace")) || (obj.metadata?.namespace ?? "") } : undefined;
}

export interface ProxyInclude {
  name: string;
  namespace: string;
  conditions: string[];
  prefix?: string;
  /** `tcpproxy.include`: a TCP proxy delegated to another proxy. */
  tcp: boolean;
}

/** `spec.includes` and `spec.tcpproxy.include` (or the older `includes`), each namespace defaulting to the proxy's. */
export function includesOf(obj: KubeObject): ProxyInclude[] {
  const own = obj.metadata?.namespace ?? "";
  const http = arr(get(obj, "spec", "includes")).flatMap((i): ProxyInclude[] => {
    const name = str(get(i, "name"));
    if (!name) return [];
    const conditions = get(i, "conditions");
    return [{ name, namespace: str(get(i, "namespace")) || own, conditions: conditionTexts(conditions), prefix: prefixOf(conditions), tcp: false }];
  });
  const tcpInclude = get(obj, "spec", "tcpproxy", "include") ?? get(obj, "spec", "tcpproxy", "includes");
  const tcpName = str(get(tcpInclude, "name"));
  const tcp = tcpName ? [{ name: tcpName, namespace: str(get(tcpInclude, "namespace")) || own, conditions: [], tcp: true }] : [];
  return [...http, ...tcp];
}

/** `spec.tcpproxy.services`. */
export const tcpServicesOf = (obj: KubeObject) => servicesOf(get(obj, "spec", "tcpproxy", "services"));

/** The address Contour reports for a root: Envoy's load balancer (`status.loadBalancer.ingress`). */
export function proxyAddresses(obj: KubeObject): string[] {
  return arr(get(obj, "status", "loadBalancer", "ingress"))
    .map((i) => str(get(i, "ip")) ?? str(get(i, "hostname")))
    .filter((a): a is string => Boolean(a));
}

// ---------- TLSCertificateDelegation and ExtensionService ----------

export interface Delegation {
  secretName: string;
  /** `*`: every namespace. */
  targetNamespaces: string[];
}

export function delegationsOf(obj: KubeObject): Delegation[] {
  return arr(get(obj, "spec", "delegations")).flatMap((d) => {
    const secretName = str(get(d, "secretName"));
    return secretName ? [{ secretName, targetNamespaces: arr(get(d, "targetNamespaces")).filter((n): n is string => typeof n === "string") }] : [];
  });
}

/** The TLSCertificateDelegation of `delegations` (in the Secret's namespace) that lets `target` use the Secret. */
export function delegationFor(delegations: readonly KubeObject[], secret: SecretRef, target: string): KubeObject | undefined {
  return delegations.find(
    (d) =>
      d.metadata?.namespace === secret.namespace &&
      delegationsOf(d).some((x) => x.secretName === secret.name && (x.targetNamespaces.includes("*") || x.targetNamespaces.includes(target))),
  );
}

export interface ExtensionFields {
  services: ProxyService[];
  protocol?: string;
  timeout?: string;
  idleTimeout?: string;
  loadBalancing?: string;
  /** Upstream TLS is checked against a CA (`validation`). */
  validated: boolean;
}

export function extensionFields(obj: KubeObject): ExtensionFields {
  return {
    services: servicesOf(get(obj, "spec", "services")),
    protocol: str(get(obj, "spec", "protocol")),
    timeout: str(get(obj, "spec", "timeoutPolicy", "response")),
    idleTimeout: str(get(obj, "spec", "timeoutPolicy", "idle")),
    loadBalancing: str(get(obj, "spec", "loadBalancerPolicy", "strategy")),
    validated: Boolean(get(obj, "spec", "validation")),
  };
}

// ---------- The delegation tree ----------

export const proxyKey = (namespace: string, name: string) => `${namespace}/${name}`;

/** What the tree needs of an HTTPProxy: a compact row (kept by a tap on the problems store's HTTPProxy watch). */
export interface ProxyRow {
  namespace: string;
  name: string;
  root: boolean;
  fqdn?: string;
  state: ProxyState;
  includes: { key: string; prefix?: string; conditions: string[]; tcp: boolean }[];
}

export function proxyRow(obj: KubeObject): ProxyRow {
  return {
    namespace: obj.metadata?.namespace ?? "",
    name: obj.metadata?.name ?? "",
    root: isRoot(obj),
    fqdn: fqdnOf(obj),
    state: proxyState(obj),
    includes: includesOf(obj).map((i) => ({ key: proxyKey(i.namespace, i.name), prefix: i.prefix, conditions: i.conditions, tcp: i.tcp })),
  };
}

/** Nodes a tree shows at most. */
export const MAX_TREE_NODES = 200;
/** Roots shown above an included proxy at most. */
export const MAX_ROOTS = 5;

export interface TreeNode {
  key: string;
  /** `undefined`: no such HTTPProxy (Contour answers 502 for the include). */
  row?: ProxyRow;
  /** The include's own conditions (none for a root). */
  conditions: string[];
  /** The path prefix from the root down to this proxy. */
  prefix: string;
  tcp: boolean;
  /** Already on the path above: Contour refuses the include (IncludeCreatesCycle). */
  cycle: boolean;
  children: TreeNode[];
}

export type ProxyIndex = ReadonlyMap<string, ProxyRow>;

export function indexRows(rows: Iterable<ProxyRow>): Map<string, ProxyRow> {
  return new Map([...rows].map((r) => [proxyKey(r.namespace, r.name), r]));
}

/** The proxies that include `key`, directly. */
export function parentsOf(index: ProxyIndex, key: string): ProxyRow[] {
  return [...index.values()].filter((r) => r.includes.some((i) => i.key === key));
}

/** Every proxy with an include path to `key` (its ancestors), bounded by the index. */
export function ancestorsOf(index: ProxyIndex, key: string): Set<string> {
  const found = new Set<string>();
  const queue = [key];
  while (queue.length > 0) {
    const next = queue.shift()!;
    for (const parent of parentsOf(index, next)) {
      const pk = proxyKey(parent.namespace, parent.name);
      if (found.has(pk) || pk === key) continue;
      found.add(pk);
      queue.push(pk);
    }
  }
  return found;
}

/** The roots whose trees reach `key`, at most `MAX_ROOTS`, sorted. */
export function rootsReaching(index: ProxyIndex, key: string): string[] {
  return [...ancestorsOf(index, key)]
    .filter((k) => index.get(k)?.root)
    .sort()
    .slice(0, MAX_ROOTS);
}

export interface Tree {
  node: TreeNode;
  /** Nodes were left out (`MAX_TREE_NODES`). */
  truncated: boolean;
}

/**
 * The include tree under `rootKey`. With `focus` (an included proxy), only the branches that lead to it are kept
 * above it, and everything under it.
 */
export function delegationTree(index: ProxyIndex, rootKey: string, focus?: string): Tree {
  const ancestors = focus ? ancestorsOf(index, focus) : undefined;
  let budget = MAX_TREE_NODES;
  let truncated = false;
  const build = (key: string, conditions: string[], prefixes: (string | undefined)[], tcp: boolean, path: string[], below: boolean): TreeNode => {
    budget--;
    const row = index.get(key);
    const cycle = path.includes(key);
    const node: TreeNode = { key, row, conditions, prefix: joinPrefixes(prefixes), tcp, cycle, children: [] };
    if (!row || cycle) return node;
    const under = below || key === focus || !ancestors;
    for (const inc of row.includes) {
      if (!under && inc.key !== focus && !ancestors!.has(inc.key)) continue;
      if (budget <= 0) {
        truncated = true;
        break;
      }
      node.children.push(build(inc.key, inc.conditions, [...prefixes, inc.prefix], inc.tcp, [...path, key], under));
    }
    return node;
  };
  return { node: build(rootKey, [], [], false, [], false), truncated };
}
