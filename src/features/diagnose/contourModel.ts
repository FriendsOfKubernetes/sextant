// What the traffic diagnosis of a Contour HTTPProxy (`contour.ts`, #233, ADR-0107) reads from Contour's objects: an
// HTTPProxy's status as Contour writes it (`currentStatus` valid / invalid / orphaned / NotReconciled and the `Valid`
// DetailedCondition with its `errors` and `warnings`), its virtual host and TLS (a Secret of another namespace through
// a TLSCertificateDelegation), routes with their match conditions, services with weights and mirrors, and includes.
// Pure functions, no React. The Contour views themselves are Sextant's own extension `extensions/contour` since 0.30
// (ADR-0162 amendment); the diagnosis stays Sextant's own, for the window and agents' `diagnose_service`.
//
// Semantics follow Contour's own processor (internal/dag/httpproxy_processor.go): Services are looked up in the
// proxy's own namespace; a proxy without `virtualhost` is served only when a root includes it (otherwise Contour marks
// it orphaned); include prefixes concatenate from the root down; with no weights the services of a route share
// equally, with some weights a service without one gets nothing; a mirror's weight is the percent mirrored (none: 100).
// Contour's `--root-namespaces` flag is not visible to Sextant: a root outside them is told only by the status
// (RootNamespaceError).
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";

const { arr, get, num, record, str } = status;

export const CONTOUR_GROUP = "projectcontour.io";

export const HTTP_PROXY: KindRef = { group: CONTOUR_GROUP, version: "v1", kind: "HTTPProxy" };
export const TLS_DELEGATION: KindRef = { group: CONTOUR_GROUP, version: "v1", kind: "TLSCertificateDelegation" };

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

/** The `Valid` condition Contour writes on an HTTPProxy. */
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
}

export function tlsOf(obj: KubeObject): ProxyTls | undefined {
  const tls = get(obj, "spec", "virtualhost", "tls");
  if (!tls || typeof tls !== "object") return undefined;
  return {
    secret: secretRef(str(get(tls, "secretName")), obj.metadata?.namespace ?? ""),
    passthrough: get(tls, "passthrough") === true,
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

/**
 * Prefixes along an include path, merged as Contour merges them (`mergePathMatchConditions` in
 * internal/dag/conditions.go, called by internal/dag/httpproxy_processor.go for every route and include): concatenated
 * as written (Contour's validation makes each start with `/`), every run of slashes collapsed to one (`//+` → `/`), an
 * empty result `/`; a trailing slash is kept (`/api` + `/v1/` = `/api/v1/`, `/` + `/blog` = `/blog`).
 */
export function joinPrefixes(prefixes: readonly (string | undefined)[]): string {
  const joined = prefixes
    .filter((p): p is string => Boolean(p))
    .join("")
    .replace(/\/\/+/g, "/");
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

export interface ProxyRoute {
  index: number;
  conditions: string[];
  prefix?: string;
  services: ProxyService[];
  redirect: boolean;
  /** `directResponsePolicy.statusCode`. */
  directResponse?: number;
}

const present = (value: unknown) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

export function routesOf(obj: KubeObject): ProxyRoute[] {
  return arr(get(obj, "spec", "routes")).map((r, index) => ({
    index,
    conditions: conditionTexts(get(r, "conditions")),
    prefix: prefixOf(get(r, "conditions")),
    services: servicesOf(get(r, "services")),
    redirect: present(get(r, "requestRedirectPolicy")),
    directResponse: num(get(r, "directResponsePolicy", "statusCode")),
  }));
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

// ---------- TLSCertificateDelegation ----------

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
