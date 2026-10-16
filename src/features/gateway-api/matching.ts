// "Where does this request go?" — which Gateway listener, route, rule and backends would serve a request under the
// Gateway API v1 matching rules, and why every other candidate lost; and the cluster's hostname map with conflicting
// routes. Pure functions over watched objects, no React; the result is structured data only (enum codes, i18n
// phrases from the model), the UI translates it.
//
//   explainRequest(request, cluster)  // the listener, route, rule, filters and backends; the losing candidates
//   hostnameMap(gateways, routes)     // hostname → Gateway/listener → route → backends, conflicts marked
//   replacePathPrefix(path, p, r)     // `replacePrefixMatch` of a redirect or rewrite
//
// The rules followed (gateway.networking.k8s.io/v1):
//  - Listener: same port and protocol (http → HTTP, https → HTTPS); hostname from the most to the least specific —
//    exact, then wildcards with more labels after `*`, then no hostname. `*.example.com` matches any number of labels
//    on its left, never `example.com`.
//  - Route: attached to that listener (a parentRef naming the Gateway and the listener or none) and Accepted there,
//    from a namespace and of a kind the listener's `allowedRoutes` admit (Accepted on a parentRef without a
//    sectionName only says the route attached to some listener); its hostnames intersected with the listener's, the
//    request's host among them. A `Selector` needs the namespaces' labels: without them the route counts as admitted,
//    with a note.
//  - HTTPRoute precedence, across all rules of the applicable routes: hostname (characters of a matching non-wildcard
//    hostname, then of a matching hostname — the route's own hostnames, as the spec recommends), Exact path, the
//    longest PathPrefix (a trailing `/` ignored), method, most headers, most query params, the oldest route,
//    `{namespace}/{name}`, the first rule. RegularExpression paths are implementation-specific: ranked between Exact
//    and PathPrefix here (as Envoy Gateway does), with a note.
//  - GRPCRoute precedence: hostname as above, characters of the service, of the method, header matches, then the same
//    tie-breaks. HTTPRoutes and GRPCRoutes are not merged: for a gRPC request (`content-type: application/grpc…`) the
//    hostname decides first, then a GRPCRoute is preferred (with a note). A plain HTTP request is not matched against
//    GRPCRoutes. A gRPC request no rule takes gets `UNIMPLEMENTED`, a GRPCRoute rule without usable backends
//    `UNAVAILABLE`.
//  - The URL's host is the `host` header for header matches unless one was given. Query parameters are compared raw,
//    as they appear in the URL (`+` and `%XX` are not decoded).
//  - Regular expressions (paths, headers, query params, gRPC methods) are evaluated in the JavaScript dialect as full
//    matches; implementations use RE2/PCRE, so the result carries a note.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import {
  backendIssue,
  backendRefs,
  filterPhrases,
  gatewayAddresses,
  gatewayOwnHealth,
  grpcMatchPhrases,
  httpMatchPhrases,
  listenerStatuses,
  parentStatuses,
  routeAttachedTo,
  routeHostnames,
  routeRules,
  serviceReadiness,
  GATEWAY_GROUP,
  GRPC_ROUTE,
  HTTP_ROUTE,
  type BackendRef,
  type Condition,
  type ListenerStatus,
  type ParentStatus,
  type Phrase,
} from "./model";

const { arr, createdAt, get, num, str } = status;

// ---------- Input and output ----------

/** What the user typed: method, URL and headers. */
export interface RequestInput {
  /** Default GET (POST for gRPC). */
  method?: string;
  /** `https://shop.example.com/api?x=1`; without a scheme `http://` is assumed. */
  url: string;
  /** Header names in any case. A `Host` header overrides the URL's host for hostname matching. */
  headers?: Readonly<Record<string, string>>;
  /** `grpc` matches GRPCRoutes on the path `/pkg.Service/Method`; default from `content-type: application/grpc…`. */
  protocol?: "http" | "grpc";
}

/** The watched objects the request is matched against; Services, slices and grants refine the backends. */
export interface ClusterSnapshot {
  gateways: readonly KubeObject[];
  httpRoutes?: readonly KubeObject[];
  grpcRoutes?: readonly KubeObject[];
  /** Every Service of the cluster (enables BackendNotFound). */
  services?: readonly KubeObject[];
  /** EndpointSlices (enables backend readiness). */
  endpointSlices?: readonly KubeObject[];
  /** Every ReferenceGrant of the cluster (refines RefNotPermitted). */
  referenceGrants?: readonly KubeObject[];
  /** Namespaces with their labels (enables `allowedRoutes.namespaces.from: Selector`). */
  namespaces?: readonly KubeObject[];
}

export interface ParsedRequest {
  scheme: "http" | "https";
  protocol: "http" | "grpc";
  method: string;
  /** The host hostnames are matched against: the Host header without its port, else the URL's host; lowercased. */
  host: string;
  /** The URL's host (an address of a Gateway, when the Host header names the site). */
  urlHost: string;
  port: number;
  path: string;
  /** `?a=1&b=2`, or "". */
  search: string;
  /** Lowercased names, in order; `host` (the URL's host) appended when no Host header was given. */
  headers: [name: string, value: string][];
  /** Raw, as in the URL: neither `+` nor `%XX` decoded. */
  query: [name: string, value: string][];
  /** Service and method of a gRPC request whose path is `/pkg.Service/Method`. */
  grpc?: { service: string; method: string };
}

export type RouteKindName = "HTTPRoute" | "GRPCRoute";

export interface NamespacedName {
  namespace: string | null;
  name: string;
}

export interface RouteId extends NamespacedName {
  kind: RouteKindName;
}

/** Why a candidate did not get the request. */
export type LossReason =
  // A Gateway
  | "gatewayNotReady" // the Gateway itself is not Accepted/Programmed (`condition`)
  | "otherAddress" // the URL names an address of another Gateway
  | "noListenerMatched" // none of its listeners takes the request
  | "noRouteMatched" // a listener takes it, but no route rule matches
  | "otherGateway" // it could serve the request too; another Gateway was preferred (DNS decides in reality)
  // A listener
  | "otherPort"
  | "otherProtocol"
  | "otherHostname" // the listener's hostname does not match the host
  | "listenerNotReady" // not Accepted, Conflicted, unresolved refs or not Programmed (`condition`)
  | "lessSpecificListener" // matches, but a listener with a more specific hostname takes the request
  // A route on the chosen listener
  | "otherRouteKind" // a GRPCRoute for a plain HTTP request
  | "notAttached" // it names the Gateway, but another listener
  | "notAccepted" // the Gateway did not accept it there, or anywhere (`condition`; none while pending)
  | "namespaceNotAllowed" // `allowedRoutes.namespaces` of the listener does not admit the route's namespace
  | "kindNotAllowed" // the listener does not allow the route's kind
  | "noHostnameIntersection" // none of its hostnames intersects the listener's
  | "otherHost" // the request's host is not among its hostnames
  // A match of a rule
  | "pathMismatch"
  | "methodMismatch"
  | "headerMismatch" // `field` is the header
  | "queryMismatch" // `field` is the query parameter
  | "grpcServiceMismatch"
  | "grpcMethodMismatch"
  | "invalidRegex" // `field` is the pattern
  | "lowerPrecedence"; // it matches, but loses on `lostOn`

/** The criterion a matching candidate lost on, in the order they are applied. */
export type PrecedenceCriterion =
  | "hostname"
  | "hostnameLength"
  | "routeKind"
  | "path"
  | "method"
  | "headers"
  | "queryParams"
  | "service"
  | "grpcMethod"
  | "age"
  | "name"
  | "ruleOrder";

export interface Candidate {
  level: "gateway" | "listener" | "route" | "match";
  gateway: NamespacedName;
  listener?: string;
  route?: RouteId;
  /** Rule index (0-based) and match index within it; no `match` for a rule without matches. */
  rule?: number;
  match?: number;
  reason: LossReason;
  /** The condition reason a controller reported (notAccepted, listenerNotReady, gatewayNotReady). */
  condition?: string;
  lostOn?: PrecedenceCriterion;
  /** The header, query parameter or pattern that did not match. */
  field?: string;
}

export type Outcome =
  | "forwarded" // backends get the request
  | "redirected" // a RequestRedirect answers
  | "noListener" // no Gateway listener takes it (the connection is not served)
  | "noRoute" // a listener takes it, no route matches: 404 (gRPC: UNIMPLEMENTED)
  | "noBackend" // the rule has no usable backends: 500 (a GRPCRoute: UNAVAILABLE)
  | "invalidUrl";

/** The gRPC status a Gateway answers a gRPC request with itself (`gateway:check.grpcStatus.<status>`). */
export type GrpcStatus = "UNIMPLEMENTED" | "UNAVAILABLE";
export const GRPC_STATUSES: readonly GrpcStatus[] = ["UNIMPLEMENTED", "UNAVAILABLE"];

export type Note =
  | "regexPathPrecedence" // a RegularExpression path took part: its precedence is implementation-specific
  | "regexDialect" // a regular expression was evaluated in the JavaScript dialect
  | "severalGateways" // more than one Gateway can take the request; which one gets it depends on DNS
  | "listenerPending" // the chosen listener has no status yet
  | "partialBackends" // some backends are unusable: their share of the requests gets 500 (UNAVAILABLE)
  | "namespaceSelectorUnknown" // the chosen route's namespace is admitted by a selector whose labels are unknown
  | "routeKindPrecedence"; // equally specific hostnames: a GRPCRoute was preferred to an HTTPRoute

export interface AppliedFilter {
  type: string;
  phrases: Phrase[];
}

export interface BackendOutcome extends BackendRef {
  /** RefNotPermitted | InvalidKind | BackendNotFound (see `backendIssue`). */
  issue?: string;
  /** Ready and all endpoints of a Service, when EndpointSlices were given. */
  ready?: number;
  total?: number;
}

export interface ChosenRoute extends RouteId {
  /** The route's hostname that matched (the listener's when the route has none; null when neither has one). */
  hostname: string | null;
}

export interface ChosenRule {
  index: number;
  name?: string;
  /** The match that won; undefined when the rule has no matches (it matches everything). */
  match?: number;
  /** The winning match as phrases (the default match when the rule has none). */
  phrases: Phrase[];
}

export interface RequestExplanation {
  outcome: Outcome;
  /** What the Gateway answers itself: 404 (no route), 500 (no backend), the redirect's code; none for gRPC. */
  status?: number;
  /** What the Gateway answers a gRPC request itself: no route, or no usable backend of a GRPCRoute. */
  grpcStatus?: GrpcStatus;
  request?: ParsedRequest;
  gateway?: NamespacedName;
  listener?: ListenerStatus;
  route?: ChosenRoute;
  rule?: ChosenRule;
  filters: AppliedFilter[];
  redirect?: { location: string; statusCode: number };
  rewrite?: { hostname?: string; path?: string };
  mirrors: BackendRef[];
  backends: BackendOutcome[];
  /** Everything that did not get the request, and why. */
  candidates: Candidate[];
  notes: Note[];
}

// ---------- Parsing ----------

const GRPC_PATH = /^\/([^/]+)\/([^/]+)$/;

function hostWithoutPort(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  const colon = h.lastIndexOf(":");
  return colon >= 0 && h.indexOf(":") === colon ? h.slice(0, colon) : h;
}

const normalizeHost = (h: string) => h.toLowerCase().replace(/\.$/, "");

/** The request as the engine sees it; undefined for a URL it cannot read (or a scheme other than http/https). */
export function parseRequest(input: RequestInput): ParsedRequest | undefined {
  const raw = input.url.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
  const scheme = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : undefined;
  if (!scheme || !url.hostname) return undefined;
  const headers = Object.entries(input.headers ?? {})
    .filter(([name]) => name.trim() !== "")
    .map(([name, value]): [string, string] => [name.trim().toLowerCase(), value]);
  const header = (name: string) => headers.find(([n]) => n === name)?.[1];
  const protocol = input.protocol ?? (header("content-type")?.toLowerCase().startsWith("application/grpc") ? "grpc" : "http");
  const hostHeader = header("host");
  const grpcPath = protocol === "grpc" ? GRPC_PATH.exec(url.pathname) : null;
  return {
    scheme,
    protocol,
    method: (input.method?.trim() || (protocol === "grpc" ? "POST" : "GET")).toUpperCase(),
    host: normalizeHost(hostHeader ? hostWithoutPort(hostHeader) : url.hostname),
    urlHost: normalizeHost(url.hostname),
    port: url.port ? Number(url.port) : scheme === "https" ? 443 : 80,
    path: url.pathname || "/",
    search: url.search,
    // The client sends the URL's host (with a port other than the scheme's) as `Host`; header matches see it.
    headers: hostHeader === undefined ? [...headers, ["host", url.host]] : headers,
    query: rawQuery(url.search),
    grpc: grpcPath?.[1] && grpcPath[2] ? { service: grpcPath[1], method: grpcPath[2] } : undefined,
  };
}

/**
 * `?a=1&b=x+y` → `[["a", "1"], ["b", "x+y"]]`, undecoded: implementations (Envoy) compare query parameters as they
 * appear on the wire, so a match on `x y` does not take `x+y` or `x%20y`.
 */
function rawQuery(search: string): [string, string][] {
  return search
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => part !== "")
    .map((part) => {
      const eq = part.indexOf("=");
      return eq < 0 ? [part, ""] : [part.slice(0, eq), part.slice(eq + 1)];
    });
}

// ---------- Hostnames ----------

const isWildcard = (h: string) => h.startsWith("*.");

/** Whether `host` (a name, no wildcard) matches `pattern` (exact or `*.suffix`; none matches everything). */
export function hostnameMatches(pattern: string | undefined | null, host: string): boolean {
  if (!pattern) return true;
  const p = pattern.toLowerCase();
  if (!isWildcard(p)) return p === host;
  const suffix = p.slice(1);
  return host.length > suffix.length && host.endsWith(suffix);
}

/** The hostnames a route hostname and a listener hostname have in common, as the most specific of the two. */
export function intersectHostnames(route: string, listener: string | undefined): string | undefined {
  const h = route.toLowerCase();
  if (!listener) return h;
  const l = listener.toLowerCase();
  if (h === l) return h;
  const hw = isWildcard(h);
  const lw = isWildcard(l);
  if (!hw && !lw) return undefined;
  if (lw && !hw) return hostnameMatches(l, h) ? h : undefined;
  if (hw && !lw) return hostnameMatches(h, l) ? l : undefined;
  if (h.endsWith(l.slice(1))) return h;
  if (l.endsWith(h.slice(1))) return l;
  return undefined;
}

/** Listener hostname precedence: exact > wildcard (more labels after `*` first) > none. */
function listenerSpecificity(hostname: string | undefined): number {
  if (!hostname) return 0;
  if (!isWildcard(hostname)) return 1000;
  return hostname.split(".").length;
}

// ---------- Paths ----------

const trimSlash = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

/** PathPrefix: whole path elements, a trailing `/` ignored (`/abc` matches `/abc`, `/abc/`, `/abc/def`, not `/abcd`). */
function prefixMatches(prefix: string, path: string): boolean {
  const p = trimSlash(prefix);
  if (p === "/") return true;
  return path === p || path.startsWith(`${p}/`);
}

/**
 * `replacePrefixMatch`: the matched prefix of `path` replaced by `replacement`, element-wise — the spec's table:
 * `/foo/bar` with `/foo` → `/xyz` gives `/xyz/bar`, with "" gives `/bar`; `/foo` with `/` gives `/`.
 */
export function replacePathPrefix(path: string, prefix: string, replacement: string): string {
  const p = trimSlash(prefix) === "/" ? "" : trimSlash(prefix);
  const rest = path.slice(p.length);
  const r = replacement.endsWith("/") ? replacement.slice(0, -1) : replacement;
  const result = `${r}${rest}`;
  return result === "" ? "/" : result;
}

// ---------- Matches ----------

type Regex = { ok: true; test: (s: string) => boolean } | { ok: false };

function fullRegex(pattern: string): Regex {
  try {
    const re = new RegExp(`^(?:${pattern})$`);
    return { ok: true, test: (s) => re.test(s) };
  } catch {
    return { ok: false };
  }
}

type Verdict =
  | { ok: true; key: KeyPart[]; regexPath: boolean; regex: boolean }
  | { ok: false; reason: LossReason; field?: string; regex: boolean };

interface KeyPart {
  criterion: PrecedenceCriterion;
  /** Higher wins for numbers; for strings the alphabetically first wins. */
  value: number | string;
}

/** Name/type/value entries with the first of equivalent names only (header names compare case-insensitively). */
function distinctEntries(list: unknown, caseInsensitive: boolean): { name: string; type: string; value: string }[] {
  const seen = new Set<string>();
  const out: { name: string; type: string; value: string }[] = [];
  for (const e of arr(list)) {
    const raw = str(get(e, "name")) ?? "";
    const name = caseInsensitive ? raw.toLowerCase() : raw;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, type: str(get(e, "type")) ?? "Exact", value: str(get(e, "value")) ?? "" });
  }
  return out;
}

/** The first failing entry of `wanted` against `actual` (first value of a name), if any. */
function entriesFail(
  wanted: { name: string; type: string; value: string }[],
  actual: [string, string][],
  reason: LossReason,
): { reason: LossReason; field: string } | undefined {
  for (const w of wanted) {
    const value = actual.find(([n]) => n === w.name)?.[1];
    if (value === undefined) return { reason, field: w.name };
    if (w.type === "RegularExpression") {
      const re = fullRegex(w.value);
      if (!re.ok) return { reason: "invalidRegex", field: w.value };
      if (!re.test(value)) return { reason, field: w.name };
    } else if (value !== w.value) return { reason, field: w.name };
  }
  return undefined;
}

const hasRegex = (entries: { type: string }[]) => entries.some((e) => e.type === "RegularExpression");

function httpVerdict(match: unknown, req: ParsedRequest): Verdict {
  const type = str(get(match, "path", "type")) ?? "PathPrefix";
  const value = str(get(match, "path", "value")) ?? "/";
  const headers = distinctEntries(get(match, "headers"), true);
  const query = distinctEntries(get(match, "queryParams"), false);
  const regexPath = type === "RegularExpression";
  const regex = regexPath || hasRegex(headers) || hasRegex(query);
  if (type === "Exact") {
    if (req.path !== value) return { ok: false, reason: "pathMismatch", regex };
  } else if (type === "PathPrefix") {
    if (!prefixMatches(value, req.path)) return { ok: false, reason: "pathMismatch", regex };
  } else {
    const re = fullRegex(value);
    if (!re.ok) return { ok: false, reason: "invalidRegex", field: value, regex };
    if (!re.test(req.path)) return { ok: false, reason: "pathMismatch", regex };
  }
  const method = str(get(match, "method"));
  if (method && method !== req.method) return { ok: false, reason: "methodMismatch", regex };
  const failed = entriesFail(headers, req.headers, "headerMismatch") ?? entriesFail(query, req.query, "queryMismatch");
  if (failed) return { ok: false, ...failed, regex };
  // Exact, then RegularExpression (implementation-specific; Envoy Gateway's order), then the longest PathPrefix —
  // `/foo/` and `/foo` are the same prefix, so they tie and the older route wins.
  const pathScore = type === "Exact" ? 3_000_000 : type === "PathPrefix" ? 1_000_000 + trimSlash(value).length : 2_000_000;
  return {
    ok: true,
    regexPath,
    regex,
    key: [
      { criterion: "path", value: pathScore },
      { criterion: "method", value: method ? 1 : 0 },
      { criterion: "headers", value: headers.length },
      { criterion: "queryParams", value: query.length },
    ],
  };
}

function grpcVerdict(match: unknown, req: ParsedRequest): Verdict {
  const headers = distinctEntries(get(match, "headers"), true);
  const m = get(match, "method");
  const regexMethod = m !== undefined && str(get(m, "type")) === "RegularExpression";
  const regex = regexMethod || hasRegex(headers);
  const service = str(get(m, "service")) || undefined;
  const method = str(get(m, "method")) || undefined;
  if (service || method) {
    if (!req.grpc) return { ok: false, reason: "pathMismatch", regex };
    const check = (wanted: string | undefined, actual: string, reason: LossReason): Verdict | undefined => {
      if (!wanted) return undefined;
      if (regexMethod) {
        const re = fullRegex(wanted);
        if (!re.ok) return { ok: false, reason: "invalidRegex", field: wanted, regex };
        return re.test(actual) ? undefined : { ok: false, reason, regex };
      }
      return wanted === actual ? undefined : { ok: false, reason, regex };
    };
    const failed =
      check(service, req.grpc.service, "grpcServiceMismatch") ?? check(method, req.grpc.method, "grpcMethodMismatch");
    if (failed) return failed;
  }
  const headerFail = entriesFail(headers, req.headers, "headerMismatch");
  if (headerFail) return { ok: false, ...headerFail, regex };
  return {
    ok: true,
    regexPath: false,
    regex,
    key: [
      // A pattern's length says nothing about how specific it is: implementation-specific, counted as none.
      { criterion: "service", value: regexMethod ? 0 : (service?.length ?? 0) },
      { criterion: "grpcMethod", value: regexMethod ? 0 : (method?.length ?? 0) },
      { criterion: "headers", value: headers.length },
    ],
  };
}

/** The first criterion where `a` and `b` differ: negative when `a` wins. */
function compareKeys(a: readonly KeyPart[], b: readonly KeyPart[]): { order: number; criterion?: PrecedenceCriterion } {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.value === y.value) continue;
    const order =
      typeof x.value === "number" && typeof y.value === "number"
        ? y.value - x.value
        : String(x.value) < String(y.value)
          ? -1
          : 1;
    return { order, criterion: x.criterion };
  }
  return { order: 0 };
}

// ---------- Routes ----------

interface RouteEntry {
  kind: RouteKindName;
  obj: KubeObject;
  id: RouteId;
}

function routeEntries(httpRoutes: readonly KubeObject[] = [], grpcRoutes: readonly KubeObject[] = []): RouteEntry[] {
  const entry = (kind: RouteKindName) => (obj: KubeObject) => ({
    kind,
    obj,
    id: { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" },
  });
  return [...httpRoutes.map(entry("HTTPRoute")), ...grpcRoutes.map(entry("GRPCRoute"))];
}

const kindRef = (kind: RouteKindName) => (kind === "GRPCRoute" ? GRPC_ROUTE : HTTP_ROUTE);

const nn = (obj: KubeObject): NamespacedName => ({ namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" });

const fullName = (n: NamespacedName) => `${n.namespace ?? ""}/${n.name}`;

/** The listener's `allowedRoutes` as written in the Gateway's spec. */
function allowedRoutesOf(gateway: KubeObject, listener: ListenerStatus): unknown {
  const spec = arr(get(gateway, "spec", "listeners")).find((l) => str(get(l, "name")) === listener.name);
  return get(spec, "allowedRoutes");
}

/**
 * Route kinds the listener lets attach: `allowedRoutes.kinds` (group and kind), else what the controller reported,
 * else any.
 */
function kindAllowed(gateway: KubeObject, listener: ListenerStatus, kind: RouteKindName): boolean {
  const kinds = arr(get(allowedRoutesOf(gateway, listener), "kinds"));
  if (kinds.length > 0)
    return kinds.some((k) => (str(get(k, "group")) ?? GATEWAY_GROUP) === GATEWAY_GROUP && str(get(k, "kind")) === kind);
  const supported = listener.supportedKinds;
  return supported.length === 0 || supported.includes(kind);
}

/** Whether a label selector (`matchLabels`, `matchExpressions`) selects `labels`. */
function selects(selector: unknown, labels: Readonly<Partial<Record<string, string>>>): boolean {
  const matchLabels = get(selector, "matchLabels");
  for (const [key, value] of Object.entries(matchLabels && typeof matchLabels === "object" ? matchLabels : {}))
    if (labels[key] !== String(value)) return false;
  return arr(get(selector, "matchExpressions")).every((e) => {
    const key = str(get(e, "key")) ?? "";
    const values = arr(get(e, "values")).map(String);
    const has = Object.hasOwn(labels, key);
    switch (str(get(e, "operator"))) {
      case "In":
        return has && values.includes(labels[key] ?? "");
      case "NotIn":
        return !has || !values.includes(labels[key] ?? "");
      case "Exists":
        return has;
      case "DoesNotExist":
        return !has;
      default:
        return false;
    }
  });
}

/**
 * Whether the listener admits routes from `namespace` (`allowedRoutes.namespaces.from`, default `Same`): "maybe" for
 * a `Selector` when the namespace's labels are not known.
 */
function namespaceAllowed(
  gateway: KubeObject,
  listener: ListenerStatus,
  namespace: string | null,
  namespaces: readonly KubeObject[] | undefined,
): "yes" | "no" | "maybe" {
  const from = get(allowedRoutesOf(gateway, listener), "namespaces");
  switch (str(get(from, "from")) ?? "Same") {
    case "All":
      return "yes";
    case "Same":
      return namespace === (gateway.metadata?.namespace ?? null) ? "yes" : "no";
    case "Selector": {
      const selector = get(from, "selector");
      if (selector === undefined || selector === null) return "no"; // a nil selector selects nothing
      const ns = namespaces?.find((n) => n.metadata?.name === namespace);
      if (!ns) return "maybe";
      const raw = get(ns, "metadata", "labels");
      const labels = Object.fromEntries(
        Object.entries(raw && typeof raw === "object" ? raw : {}).map(([k, v]) => [k, String(v)]),
      );
      return selects(selector, labels) ? "yes" : "no";
    }
    default:
      return "no"; // `None`
  }
}

/** The route's hostnames that intersect the listener's (the intersections); all of the listener when it has none. */
function effectiveHostnames(route: KubeObject, listener: ListenerStatus): { original: string; effective: string }[] {
  return routeHostnames(route).flatMap((original) => {
    const effective = intersectHostnames(original, listener.hostname);
    return effective ? [{ original: original.toLowerCase(), effective }] : [];
  });
}

/**
 * The refusal of a route the Gateway accepted on none of the parents naming it (the first Accepted=False there);
 * `undefined` when it is accepted somewhere on the Gateway or no controller said anything.
 */
function acceptedNowhere(route: KubeObject, gateway: KubeObject): Condition | undefined {
  const named = parentStatuses(route).filter(
    ({ ref }) =>
      ref.group === GATEWAY_GROUP &&
      ref.kind === "Gateway" &&
      ref.name === gateway.metadata?.name &&
      ref.namespace === (gateway.metadata?.namespace ?? null),
  );
  if (named.some((p) => p.accepted?.status === "True")) return undefined;
  return named.find((p) => p.accepted?.status === "False")?.accepted;
}

/** Most specific first: exact before wildcard, longer before shorter. */
const hostnameRank = (h: string) => (isWildcard(h) ? 0 : 10_000) + h.length;

interface Hit {
  route: RouteEntry;
  /** The listener admits the route's namespace by a selector whose labels are not known. */
  namespaceUnknown: boolean;
  hostname: string | null;
  rule: number;
  match?: number;
  matchValue: unknown;
  key: KeyPart[];
}

interface ListenerEval {
  hits: Hit[];
  candidates: Candidate[];
  regexPath: boolean;
  regex: boolean;
}

function evaluateListener(
  gateway: KubeObject,
  listener: ListenerStatus,
  routes: readonly RouteEntry[],
  req: ParsedRequest,
  namespaces: readonly KubeObject[] | undefined,
): ListenerEval {
  const gw = nn(gateway);
  const out: ListenerEval = { hits: [], candidates: [], regexPath: false, regex: false };
  const lose = (route: RouteEntry, reason: LossReason, extra: Partial<Candidate> = {}) =>
    out.candidates.push({ level: "route", gateway: gw, listener: listener.name, route: route.id, reason, ...extra });
  for (const route of routes) {
    const named = routeAttachedTo(route.obj, gateway);
    if (!named) continue; // the route does not name this Gateway at all
    if (route.kind === "GRPCRoute" && req.protocol !== "grpc") {
      lose(route, "otherRouteKind");
      continue;
    }
    const parent: ParentStatus | undefined = routeAttachedTo(route.obj, gateway, listener);
    if (!parent) {
      // Another listener named, but the Gateway refused the route there (and accepted it nowhere): that is the reason.
      const refused = acceptedNowhere(route.obj, gateway);
      lose(route, refused ? "notAccepted" : "notAttached", refused?.reason ? { condition: refused.reason } : {});
      continue;
    }
    if (parent.accepted?.status !== "True") {
      lose(route, "notAccepted", parent.accepted?.reason ? { condition: parent.accepted.reason } : {});
      continue;
    }
    // Accepted on a parentRef without a sectionName only says the route attached to some listener of the Gateway.
    const admitted = namespaceAllowed(gateway, listener, route.id.namespace, namespaces);
    if (admitted === "no") {
      lose(route, "namespaceNotAllowed");
      continue;
    }
    if (!kindAllowed(gateway, listener, route.kind)) {
      lose(route, "kindNotAllowed");
      continue;
    }
    let hostname: string | null = null;
    if (routeHostnames(route.obj).length > 0) {
      const usable = effectiveHostnames(route.obj, listener);
      if (usable.length === 0) {
        lose(route, "noHostnameIntersection");
        continue;
      }
      const matching = usable
        .filter((h) => hostnameMatches(h.effective, req.host))
        .map((h) => h.original)
        .sort((a, b) => hostnameRank(b) - hostnameRank(a));
      if (matching.length === 0) {
        lose(route, "otherHost");
        continue;
      }
      hostname = matching[0] ?? null;
    }
    // Both kinds' precedence starts with the hostname; only then a GRPCRoute before an HTTPRoute for gRPC.
    const hostKey: KeyPart[] = [
      { criterion: "hostname", value: hostname && !isWildcard(hostname) ? hostname.length : 0 },
      { criterion: "hostnameLength", value: hostname?.length ?? 0 },
      { criterion: "routeKind", value: req.protocol === "grpc" && route.kind === "GRPCRoute" ? 1 : 0 },
    ];
    const tieKey: KeyPart[] = [
      { criterion: "age", value: -(createdAt(route.obj) ?? Number.MAX_SAFE_INTEGER) },
      { criterion: "name", value: fullName(route.id) },
    ];
    arr(get(route.obj, "spec", "rules")).forEach((rule, ruleIndex) => {
      const matches = arr(get(rule, "matches"));
      const list: { value: unknown; index?: number }[] =
        matches.length > 0 ? matches.map((value, index) => ({ value, index })) : [{ value: undefined }];
      let best: Hit | undefined;
      for (const { value, index } of list) {
        const verdict = route.kind === "GRPCRoute" ? grpcVerdict(value, req) : httpVerdict(value, req);
        if (verdict.regex) out.regex = true;
        if (!verdict.ok) {
          out.candidates.push({
            level: "match",
            gateway: gw,
            listener: listener.name,
            route: route.id,
            rule: ruleIndex,
            ...(index !== undefined ? { match: index } : {}),
            reason: verdict.reason,
            ...(verdict.field !== undefined ? { field: verdict.field } : {}),
          });
          continue;
        }
        if (verdict.regexPath) out.regexPath = true;
        const hit: Hit = {
          route,
          namespaceUnknown: admitted === "maybe",
          hostname,
          rule: ruleIndex,
          match: index,
          matchValue: value,
          key: [...hostKey, ...verdict.key, ...tieKey, { criterion: "ruleOrder", value: -ruleIndex }],
        };
        // Within one rule the best of its matches stands for it.
        if (!best || compareKeys(hit.key, best.key).order < 0) best = hit;
      }
      if (best) out.hits.push(best);
    });
  }
  return out;
}

// ---------- Gateways ----------

interface GatewayEval {
  gateway: KubeObject;
  listener?: ListenerStatus;
  winner?: Hit;
  losers: Hit[];
  candidates: Candidate[];
  regexPath: boolean;
  regex: boolean;
}

const LISTENER_PROTOCOL: Record<ParsedRequest["scheme"], string> = { http: "HTTP", https: "HTTPS" };

function evaluateGateway(
  gateway: KubeObject,
  routes: readonly RouteEntry[],
  req: ParsedRequest,
  addressOwners: ReadonlyMap<string, KubeObject[]>,
  namespaces: readonly KubeObject[] | undefined,
): GatewayEval {
  const gw = nn(gateway);
  const result: GatewayEval = { gateway, losers: [], candidates: [], regexPath: false, regex: false };
  const owners = addressOwners.get(req.urlHost);
  if (owners && !owners.includes(gateway)) {
    result.candidates.push({ level: "gateway", gateway: gw, reason: "otherAddress" });
    return result;
  }
  const own = gatewayOwnHealth(gateway);
  if (own.health === "problem") {
    result.candidates.push({
      level: "gateway",
      gateway: gw,
      reason: "gatewayNotReady",
      ...(own.problem?.reason ? { condition: own.problem.reason } : {}),
    });
    return result;
  }
  const fitting: ListenerStatus[] = [];
  for (const listener of listenerStatuses(gateway)) {
    const lose = (reason: LossReason, condition?: string) =>
      result.candidates.push({
        level: "listener",
        gateway: gw,
        listener: listener.name,
        reason,
        ...(condition ? { condition } : {}),
      });
    if (listener.port !== req.port) lose("otherPort");
    else if (listener.protocol !== LISTENER_PROTOCOL[req.scheme]) lose("otherProtocol");
    else if (!hostnameMatches(listener.hostname, req.host)) lose("otherHostname");
    else if (listener.health === "problem") lose("listenerNotReady", listener.problem?.reason);
    else fitting.push(listener);
  }
  fitting.sort((a, b) => listenerSpecificity(b.hostname) - listenerSpecificity(a.hostname));
  const [listener, ...others] = fitting;
  for (const other of others)
    result.candidates.push({ level: "listener", gateway: gw, listener: other.name, reason: "lessSpecificListener" });
  if (!listener) return result;
  result.listener = listener;
  const evaluated = evaluateListener(gateway, listener, routes, req, namespaces);
  result.candidates.push(...evaluated.candidates);
  result.regexPath = evaluated.regexPath;
  result.regex = evaluated.regex;
  const sorted = [...evaluated.hits].sort((a, b) => compareKeys(a.key, b.key).order);
  result.winner = sorted[0];
  result.losers = sorted.slice(1);
  return result;
}

/** Gateways that got a winner first, then those with a listener; a more specific listener; then by name. */
function compareGateways(a: GatewayEval, b: GatewayEval): number {
  const level = (e: GatewayEval) => (e.winner ? 2 : e.listener ? 1 : 0);
  return (
    level(b) - level(a) ||
    listenerSpecificity(b.listener?.hostname) - listenerSpecificity(a.listener?.hostname) ||
    fullName(nn(a.gateway)).localeCompare(fullName(nn(b.gateway)))
  );
}

// ---------- The chosen rule ----------

function redirectOf(
  filter: unknown,
  req: ParsedRequest,
  listener: ListenerStatus,
  matchedPrefix: string | undefined,
): { location: string; statusCode: number } {
  const r = get(filter, "requestRedirect");
  const scheme = str(get(r, "scheme"));
  const finalScheme = scheme ?? req.scheme;
  const host = str(get(r, "hostname")) ?? req.host;
  const wellKnown = (s: string) => (s === "http" ? 80 : s === "https" ? 443 : undefined);
  const port = num(get(r, "port")) ?? (scheme ? (wellKnown(scheme) ?? listener.port) : listener.port);
  const showPort = port !== undefined && port !== wellKnown(finalScheme);
  const path = modifiedPath(get(r, "path"), req.path, matchedPrefix) ?? req.path;
  return {
    location: `${finalScheme}://${host}${showPort ? `:${port}` : ""}${path}${req.search}`,
    statusCode: num(get(r, "statusCode")) ?? 302,
  };
}

function modifiedPath(path: unknown, requestPath: string, matchedPrefix: string | undefined): string | undefined {
  const full = str(get(path, "replaceFullPath"));
  if (full !== undefined) return full;
  const prefix = str(get(path, "replacePrefixMatch"));
  if (prefix !== undefined && matchedPrefix !== undefined) return replacePathPrefix(requestPath, matchedPrefix, prefix);
  return undefined;
}

function lookups(cluster: ClusterSnapshot) {
  const byNamespace = (objects: readonly KubeObject[] | undefined) => {
    if (!objects) return undefined;
    const map = new Map<string, KubeObject[]>();
    for (const o of objects) {
      const ns = o.metadata?.namespace ?? "";
      map.set(ns, [...(map.get(ns) ?? []), o]);
    }
    return (namespace: string) => map.get(namespace) ?? [];
  };
  const services = byNamespace(cluster.services);
  const grants = byNamespace(cluster.referenceGrants);
  return {
    servicesIn: services
      ? (namespace: string) => new Set(services(namespace).map((s) => s.metadata?.name ?? ""))
      : undefined,
    grantsIn: grants,
  };
}

function describeHit(
  hit: Hit,
  listener: ListenerStatus,
  req: ParsedRequest,
  cluster: ClusterSnapshot,
  notes: Note[],
): Pick<
  RequestExplanation,
  "outcome" | "status" | "grpcStatus" | "route" | "rule" | "filters" | "redirect" | "rewrite" | "mirrors" | "backends"
> {
  const { route } = hit;
  const ns = route.id.namespace;
  const rawRule = arr(get(route.obj, "spec", "rules"))[hit.rule];
  const readable = routeRules(route.obj, kindRef(route.kind))[hit.rule];
  const grpc = route.kind === "GRPCRoute";
  const phrases =
    hit.matchValue === undefined
      ? grpc
        ? grpcMatchPhrases({})
        : httpMatchPhrases({})
      : grpc
        ? grpcMatchPhrases(hit.matchValue)
        : httpMatchPhrases(hit.matchValue);
  const rawFilters = arr(get(rawRule, "filters"));
  const pathType = str(get(hit.matchValue, "path", "type")) ?? "PathPrefix";
  const matchedPrefix = !grpc && pathType === "PathPrefix" ? (str(get(hit.matchValue, "path", "value")) ?? "/") : undefined;
  const redirectFilter = grpc ? undefined : rawFilters.find((f) => str(get(f, "type")) === "RequestRedirect");
  const rewriteFilter = grpc ? undefined : rawFilters.find((f) => str(get(f, "type")) === "URLRewrite");
  const rewrite = rewriteFilter
    ? {
        hostname: str(get(rewriteFilter, "urlRewrite", "hostname")),
        path: modifiedPath(get(rewriteFilter, "urlRewrite", "path"), req.path, matchedPrefix),
      }
    : undefined;
  const { servicesIn, grantsIn } = lookups(cluster);
  const parents = parentStatuses(route.obj);
  const backends: BackendOutcome[] = (readable?.backends ?? []).map((b) => {
    const issue = backendIssue(b, { routeNamespace: ns, routeKind: route.kind, parents, servicesIn, grantsIn });
    const service = b.group === "" && b.kind === "Service" && b.namespace;
    const readiness =
      cluster.endpointSlices && service && b.namespace
        ? serviceReadiness(cluster.endpointSlices, { namespace: b.namespace, name: b.name })
        : undefined;
    return { ...b, ...(issue ? { issue } : {}), ...(readiness ? { ready: readiness.ready, total: readiness.total } : {}) };
  });
  const base = {
    route: { ...route.id, hostname: hit.hostname ?? listener.hostname?.toLowerCase() ?? null },
    rule: {
      index: hit.rule,
      ...(readable?.name ? { name: readable.name } : {}),
      ...(hit.match !== undefined ? { match: hit.match } : {}),
      phrases,
    },
    filters: rawFilters.map((f) => ({ type: str(get(f, "type")) ?? "", phrases: filterPhrases(f, ns) })),
    ...(rewrite ? { rewrite } : {}),
    mirrors: readable?.mirrors ?? [],
    backends,
  };
  if (redirectFilter) {
    const redirect = redirectOf(redirectFilter, req, listener, matchedPrefix);
    return { ...base, outcome: "redirected", status: redirect.statusCode, redirect };
  }
  const usable = backends.filter((b) => !b.issue && b.weight > 0);
  // A GRPCRoute's request without a usable backend gets UNAVAILABLE; an HTTPRoute's a 500.
  if (usable.length === 0)
    return grpc ? { ...base, outcome: "noBackend", grpcStatus: "UNAVAILABLE" } : { ...base, outcome: "noBackend", status: 500 };
  if (backends.some((b) => b.issue && b.weight > 0)) notes.push("partialBackends");
  return { ...base, outcome: "forwarded" };
}

// ---------- explainRequest ----------

/**
 * Where `input` goes in `cluster`: the Gateway, listener, route, rule, filters and backends that would serve it, and
 * every candidate that lost with its reason. With several Gateways able to take the request (the URL's host is a
 * name, DNS decides), the one where a route matches is chosen and the note `severalGateways` added; a URL naming a
 * Gateway's address keeps the others out.
 */
export function explainRequest(input: RequestInput, cluster: ClusterSnapshot): RequestExplanation {
  const empty = { filters: [], mirrors: [], backends: [], candidates: [], notes: [] };
  const req = parseRequest(input);
  if (!req) return { outcome: "invalidUrl", ...empty };
  const routes = routeEntries(cluster.httpRoutes, cluster.grpcRoutes);
  const addressOwners = new Map<string, KubeObject[]>();
  for (const gateway of cluster.gateways)
    for (const address of gatewayAddresses(gateway)) {
      const key = normalizeHost(address);
      addressOwners.set(key, [...(addressOwners.get(key) ?? []), gateway]);
    }
  const evals = cluster.gateways
    .map((gateway) => evaluateGateway(gateway, routes, req, addressOwners, cluster.namespaces))
    .sort(compareGateways);
  const chosen = evals[0];
  const notes = new Set<Note>();
  const candidates: Candidate[] = [];
  for (const e of evals) {
    if (e.regexPath) notes.add("regexPathPrecedence");
    if (e.regex) notes.add("regexDialect");
    candidates.push(...e.candidates);
    const winner = e.winner;
    for (const hit of winner ? e.losers : []) {
      const lostOn = winner && compareKeys(winner.key, hit.key).criterion;
      if (e === chosen && lostOn === "routeKind") notes.add("routeKindPrecedence");
      candidates.push({
        level: "match",
        gateway: nn(e.gateway),
        ...(e.listener ? { listener: e.listener.name } : {}),
        route: hit.route.id,
        rule: hit.rule,
        ...(hit.match !== undefined ? { match: hit.match } : {}),
        reason: "lowerPrecedence",
        ...(lostOn ? { lostOn } : {}),
      });
    }
    if (e === chosen) continue;
    if (winner) candidates.push({ level: "gateway", gateway: nn(e.gateway), reason: "otherGateway" });
    else if (e.listener) candidates.push({ level: "gateway", gateway: nn(e.gateway), reason: "noRouteMatched" });
    else if (!e.candidates.some((c) => c.level === "gateway"))
      candidates.push({ level: "gateway", gateway: nn(e.gateway), reason: "noListenerMatched" });
  }
  if (evals.filter((e) => e.listener).length > 1) notes.add("severalGateways");
  if (!chosen?.listener) {
    return { ...empty, outcome: "noListener", request: req, candidates, notes: [...notes] };
  }
  if (chosen.listener.health === "pending") notes.add("listenerPending");
  const common = { request: req, gateway: nn(chosen.gateway), listener: chosen.listener, candidates };
  if (!chosen.winner) {
    // gRPC: no matching rule is `UNIMPLEMENTED`, not a 404.
    const answer = req.protocol === "grpc" ? { grpcStatus: "UNIMPLEMENTED" as const } : { status: 404 };
    return { ...empty, ...common, outcome: "noRoute", ...answer, notes: [...notes] };
  }
  if (chosen.winner.namespaceUnknown) notes.add("namespaceSelectorUnknown");
  const extraNotes: Note[] = [];
  const described = describeHit(chosen.winner, chosen.listener, req, cluster, extraNotes);
  for (const n of extraNotes) notes.add(n);
  return { ...common, ...described, notes: [...notes] };
}

// ---------- hostnameMap ----------

export interface HostnameConflict {
  /** This route's rule and match. */
  rule: number;
  match?: number;
  /** The other route claiming the same hostname with an identical match. */
  with: RouteId;
  withRule: number;
  withMatch?: number;
  /** Whether this route gets the traffic (older, then first by `{namespace}/{name}`). */
  wins: boolean;
}

export interface HostnameRow {
  /** null: any host (neither the listener nor the route names one). */
  hostname: string | null;
  gateway: NamespacedName;
  listener: string;
  port?: number;
  protocol: string;
  route: RouteId;
  accepted: boolean;
  /** The reason a controller gave when the route is not accepted there. */
  condition?: string;
  backends: BackendRef[];
  conflicts: HostnameConflict[];
}

function sortedEntries(list: unknown, caseInsensitive: boolean): string[][] {
  return distinctEntries(list, caseInsensitive)
    .map((e) => [e.name, e.type, e.value])
    .sort((a, b) => (a.join("\u0000") < b.join("\u0000") ? -1 : 1));
}

/** A canonical form of a match: two routes with equal keys claim exactly the same requests. */
function matchKey(kind: RouteKindName, match: unknown): string {
  if (kind === "GRPCRoute") {
    const m = get(match, "method");
    return JSON.stringify([
      m === undefined ? "" : (str(get(m, "type")) ?? "Exact"),
      str(get(m, "service")) ?? "",
      str(get(m, "method")) ?? "",
      sortedEntries(get(match, "headers"), true),
    ]);
  }
  const type = str(get(match, "path", "type")) ?? "PathPrefix";
  const value = str(get(match, "path", "value")) ?? "/";
  return JSON.stringify([
    type,
    type === "PathPrefix" ? trimSlash(value) : value,
    str(get(match, "method")) ?? "",
    sortedEntries(get(match, "headers"), true),
    sortedEntries(get(match, "queryParams"), false),
  ]);
}

function matchKeys(route: RouteEntry): { rule: number; match?: number; key: string }[] {
  return arr(get(route.obj, "spec", "rules")).flatMap((rule, ruleIndex) => {
    const matches = arr(get(rule, "matches"));
    if (matches.length === 0) return [{ rule: ruleIndex, key: matchKey(route.kind, {}) }];
    return matches.map((m, index) => ({ rule: ruleIndex, match: index, key: matchKey(route.kind, m) }));
  });
}

function routeWins(a: RouteEntry, b: RouteEntry): boolean {
  const age = (r: RouteEntry) => createdAt(r.obj) ?? Number.MAX_SAFE_INTEGER;
  return age(a) !== age(b) ? age(a) < age(b) : fullName(a.id) < fullName(b.id);
}

/**
 * Every hostname served through the Gateways' HTTP/HTTPS listeners: hostname → Gateway/listener → route →
 * backends. A route that names a listener but is not accepted there is listed with `accepted: false` and the
 * controller's reason. A listener whose `allowedRoutes` do not admit the route's namespace or kind does not list it
 * (unless the route names that listener and was refused there); a `Selector` without `namespaces` admits. Accepted
 * routes of the same kind on the same listener and hostname with an identical match conflict; the older one (then the
 * first by `{namespace}/{name}`) wins.
 */
export function hostnameMap(
  gateways: readonly KubeObject[],
  routes: {
    httpRoutes?: readonly KubeObject[];
    grpcRoutes?: readonly KubeObject[];
    namespaces?: readonly KubeObject[];
  },
): HostnameRow[] {
  const entries = routeEntries(routes.httpRoutes, routes.grpcRoutes);
  const rows: (HostnameRow & { entry: RouteEntry })[] = [];
  for (const gateway of gateways) {
    for (const listener of listenerStatuses(gateway)) {
      if (listener.protocol !== "HTTP" && listener.protocol !== "HTTPS") continue;
      for (const entry of entries) {
        const parent = routeAttachedTo(entry.obj, gateway, listener);
        if (!parent || !kindAllowed(gateway, listener, entry.kind)) continue;
        const accepted = parent.accepted?.status === "True";
        // Accepted on a parentRef without a sectionName: attached only to the listeners that admit the namespace.
        const admitted = namespaceAllowed(gateway, listener, entry.id.namespace, routes.namespaces);
        if (admitted === "no" && (accepted || parent.ref.sectionName === undefined)) continue;
        const own = routeHostnames(entry.obj).map((h) => h.toLowerCase());
        let hostnames: (string | null)[];
        if (own.length === 0) hostnames = [listener.hostname?.toLowerCase() ?? null];
        else {
          const effective = [...new Set(effectiveHostnames(entry.obj, listener).map((h) => h.effective))];
          if (effective.length === 0 && accepted) continue; // accepted on another listener of the Gateway
          hostnames = effective.length > 0 ? effective : own;
        }
        for (const hostname of hostnames)
          rows.push({
            hostname,
            gateway: nn(gateway),
            listener: listener.name,
            port: listener.port,
            protocol: listener.protocol,
            route: entry.id,
            accepted,
            ...(!accepted && parent.accepted?.reason ? { condition: parent.accepted.reason } : {}),
            backends: backendRefs(entry.obj),
            conflicts: [],
            entry,
          });
      }
    }
  }
  const groups = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    if (!row.accepted) continue;
    const key = JSON.stringify([fullName(row.gateway), row.listener, row.hostname, row.route.kind]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    for (const a of group)
      for (const b of group) {
        if (a === b || fullName(a.route) === fullName(b.route)) continue;
        const bKeys = matchKeys(b.entry);
        for (const ka of matchKeys(a.entry))
          for (const kb of bKeys)
            if (ka.key === kb.key)
              a.conflicts.push({
                rule: ka.rule,
                ...(ka.match !== undefined ? { match: ka.match } : {}),
                with: b.route,
                withRule: kb.rule,
                ...(kb.match !== undefined ? { withMatch: kb.match } : {}),
                wins: routeWins(a.entry, b.entry),
              });
      }
  }
  const byHostname = (a: string | null, b: string | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b);
  return rows
    .sort(
      (a, b) =>
        byHostname(a.hostname, b.hostname) ||
        fullName(a.gateway).localeCompare(fullName(b.gateway)) ||
        a.listener.localeCompare(b.listener) ||
        fullName(a.route).localeCompare(fullName(b.route)),
    )
    .map((row): HostnameRow => {
      const { entry, ...rest } = row;
      void entry;
      return rest;
    });
}
