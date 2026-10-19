// "Where does this request go?" for Istio (#155): a request (URL, method, headers) sent from a workload in the mesh
// or into an Istio ingress Gateway → the VirtualServices bound to that host there → the first HTTP route whose match
// takes it → the weighted destinations → the DestinationRule and subset of each → the pods (counted by the caller with
// `destinationSelector`). Pure functions over parsed objects; nothing is sent anywhere.
//
// The rules followed (Istio's own; choices where Istio leaves them open are named):
//   - a VirtualService applies where it is bound (`gateways`, missing → `mesh`), when it is exported to the caller's
//     namespace (for a Gateway, the Gateway's namespace) and one of its hosts covers the request's host; the most
//     specific host wins; delegates (no hosts) apply only through a route's `delegate`;
//   - several VirtualServices with the same host: a Gateway merges their routes, oldest VirtualService first; a
//     sidecar uses only the oldest (Istio drops the later duplicates and `istioctl analyze` reports the conflict);
//   - routes are tried in order; a route matches when any of its `match` blocks does (no `match` → every request),
//     a block when all its conditions do; the first match wins;
//   - `sourceLabels` from a Gateway are compared with the Gateway's selector (its pods' labels are not read);
//   - regular expressions are RE2 in Istio and read here as JavaScript ones (the same for the common subset): a note
//     says so, and one JavaScript cannot read stops the check at that route ("not evaluated");
//   - Sidecar resources that narrow what a workload sees and TCP/TLS routes are not evaluated (a note says so).
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import {
  exportedTo,
  findDestinationRule,
  hostMatches,
  hostSpecificity,
  MESH_GATEWAY,
  meshWildcardInvalid,
  olderFirst,
  requestHostAliases,
  ruleTlsMode,
  ROOT_NAMESPACE,
  serviceOfHost,
  testStringMatch,
  type Destination,
  type DestinationRuleInfo,
  type GatewayServer,
  type HttpMatch,
  type HttpRoute,
  type IstioGatewayInfo,
  type Ref,
  type ServiceEntryInfo,
  type StringMatch,
  type VirtualService,
} from "./istio";

const { get, record } = status;

export type RequestSource =
  | { type: "mesh"; namespace: string; labels: Record<string, string> }
  | { type: "gateway"; gateway: string };

export interface MeshRequestInput {
  url: string;
  method: string;
  /** Lower-case names. */
  headers: Record<string, string>;
  from: RequestSource;
}

export interface RoutingSnapshot {
  virtualServices: readonly VirtualService[];
  destinationRules: readonly DestinationRuleInfo[];
  /** `undefined`: the cluster does not serve Istio Gateways or they are not known. */
  gateways: readonly IstioGatewayInfo[] | undefined;
  serviceEntries: readonly ServiceEntryInfo[];
  /** Whether a Service exists: `undefined` when its namespace is not known (not listed, no permission). */
  serviceExists: (namespace: string, name: string) => boolean | undefined;
  /** Namespaces with a Sidecar resource. */
  sidecarNamespaces: ReadonlySet<string>;
}

export interface ParsedRequest {
  scheme: string;
  host: string;
  port: number;
  /** `host[:port]` as written. */
  authority: string;
  path: string;
  query: Map<string, string>;
}

/** The request's parts, or `undefined` for a URL that cannot be read. A URL without a scheme is `http://`. */
export function parseMeshUrl(url: string): ParsedRequest | undefined {
  const text = url.trim();
  if (!text) return undefined;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return undefined;
  }
  if (!u.hostname || (u.protocol !== "http:" && u.protocol !== "https:")) return undefined;
  const scheme = u.protocol.slice(0, -1);
  const query = new Map<string, string>();
  u.searchParams.forEach((v, k) => {
    if (!query.has(k)) query.set(k, v);
  });
  return {
    scheme,
    host: u.hostname.toLowerCase(),
    port: u.port ? Number(u.port) : scheme === "https" ? 443 : 80,
    authority: u.host,
    path: decodeURIComponent(u.pathname) || "/",
    query,
  };
}

export type MatchField =
  | "uri"
  | "scheme"
  | "method"
  | "authority"
  | "headers"
  | "withoutHeaders"
  | "queryParams"
  | "port"
  | "sourceLabels"
  | "sourceNamespace"
  | "gateways";

export type Tri = "yes" | "no" | "unknown";

export type CandidateReason = "notBound" | "notExported" | "hostMismatch" | "lessSpecificHost" | "duplicateIgnored" | "invalidMeshWildcard";

export interface VsCandidate {
  ref: Ref;
  reason: CandidateReason;
}

export interface RouteSkip {
  vs: Ref;
  index: number;
  name?: string;
  failedOn?: MatchField;
}

export type DestinationProblem = "unknownHost" | "noDestinationRule" | "missingSubset";

export interface DestinationOutcome {
  destination: Destination;
  /** Percent of the requests. */
  weight: number;
  service?: { namespace: string; name: string };
  /** Whether the Service exists (`undefined`: not known). */
  serviceFound?: boolean;
  serviceEntry?: Ref;
  rule?: Ref;
  subsetLabels?: Record<string, string>;
  tlsMode?: string;
  problem?: DestinationProblem;
}

export type Outcome =
  | "routed"
  | "defaultRoute"
  | "redirected"
  | "directResponse"
  | "noRoute"
  | "passthrough"
  | "noGatewayServer"
  | "unknownGateway"
  | "delegateMissing"
  | "l4Only"
  | "notEvaluated";

export type NoteKey = "regexDialect" | "sidecarScope" | "l4NotChecked" | "gatewayPort" | "gatewaySourceLabels";

export interface MeshRouteResult {
  request: ParsedRequest;
  outcome: Outcome;
  /** The HTTP status the proxy answers itself (no route, direct response, redirect). */
  status?: number;
  gateway?: { ref: Ref; server?: GatewayServer };
  /** The VirtualServices whose routes were tried, in order. */
  used: Ref[];
  /** The VirtualService host that won. */
  matchedHost?: string;
  candidates: VsCandidate[];
  route?: { vs: Ref; route: HttpRoute; matchIndex?: number; via?: Ref };
  skipped: RouteSkip[];
  destinations: DestinationOutcome[];
  notes: NoteKey[];
}

interface Context {
  req: ParsedRequest;
  method: string;
  headers: Record<string, string>;
  key: string;
  sourceNamespace: string;
  sourceLabels: Record<string, string>;
  notes: Set<NoteKey>;
}

function testMatch(m: StringMatch, value: string | undefined, ctx: Context, ignoreCase = false): Tri {
  if (value === undefined) return "no";
  if (m.type === "regex") ctx.notes.add("regexDialect");
  const r = testStringMatch(m, value, ignoreCase);
  return r === undefined ? "unknown" : r ? "yes" : "no";
}

function testPairs(pairs: [string, StringMatch | "present"][], lookup: (name: string) => string | undefined, ctx: Context): Tri {
  let unknown = false;
  for (const [name, m] of pairs) {
    const value = lookup(name);
    const r = m === "present" ? (value !== undefined ? "yes" : "no") : testMatch(m, value, ctx);
    if (r === "no") return "no";
    if (r === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "yes";
}

/** One `match` block: yes, no (with the first condition that failed) or unknown. */
export function testHttpMatch(m: HttpMatch, ctx: Context): { result: Tri; failedOn?: MatchField } {
  const checks: [MatchField, () => Tri][] = [
    ["gateways", () => (m.gateways ? (m.gateways.includes(ctx.key) ? "yes" : "no") : "yes")],
    ["port", () => (m.port !== undefined ? (m.port === ctx.req.port ? "yes" : "no") : "yes")],
    ["uri", () => (m.uri ? testMatch(m.uri, ctx.req.path, ctx, m.ignoreUriCase) : "yes")],
    ["scheme", () => (m.scheme ? testMatch(m.scheme, ctx.req.scheme, ctx) : "yes")],
    ["method", () => (m.method ? testMatch(m.method, ctx.method, ctx) : "yes")],
    ["authority", () => (m.authority ? testMatch(m.authority, ctx.req.authority, ctx) : "yes")],
    ["headers", () => testPairs(m.headers, (n) => ctx.headers[n], ctx)],
    [
      "withoutHeaders",
      () => {
        if (m.withoutHeaders.length === 0) return "yes";
        // Matches when none of the listed headers matches.
        for (const pair of m.withoutHeaders) {
          const r = testPairs([pair], (n) => ctx.headers[n], ctx);
          if (r === "yes") return "no";
          if (r === "unknown") return "unknown";
        }
        return "yes";
      },
    ],
    ["queryParams", () => testPairs(m.queryParams, (n) => ctx.req.query.get(n), ctx)],
    [
      "sourceLabels",
      () => {
        if (!m.sourceLabels) return "yes";
        if (ctx.key !== MESH_GATEWAY) ctx.notes.add("gatewaySourceLabels");
        return Object.entries(m.sourceLabels).every(([k, v]) => ctx.sourceLabels[k] === v) ? "yes" : "no";
      },
    ],
    ["sourceNamespace", () => (m.sourceNamespace ? (m.sourceNamespace === ctx.sourceNamespace ? "yes" : "no") : "yes")],
  ];
  let unknown = false;
  for (const [field, check] of checks) {
    const r = check();
    if (r === "no") return { result: "no", failedOn: field };
    if (r === "unknown") unknown = true;
  }
  return { result: unknown ? "unknown" : "yes" };
}

/** A route: yes (with the block that matched), no (with what failed in the first block) or unknown. */
function testRoute(route: HttpRoute, ctx: Context): { result: Tri; matchIndex?: number; failedOn?: MatchField } {
  if (route.matches.length === 0) return { result: "yes" };
  let unknown = false;
  let firstFail: MatchField | undefined;
  for (const [i, m] of route.matches.entries()) {
    const r = testHttpMatch(m, ctx);
    if (r.result === "yes") return { result: "yes", matchIndex: i };
    if (r.result === "unknown") unknown = true;
    firstFail ??= r.failedOn;
  }
  return unknown ? { result: "unknown" } : { result: "no", failedOn: firstFail };
}

/** The share of each destination: one without a weight takes everything, several without weights get 0. */
export function weightsOf(destinations: readonly Destination[]): number[] {
  if (destinations.length === 1) return [destinations[0]!.weight ?? 100];
  return destinations.map((d) => d.weight ?? 0);
}

function serviceEntryFor(host: string, entries: readonly ServiceEntryInfo[]): ServiceEntryInfo | undefined {
  return entries.find((e) => e.hosts.some((h) => hostMatches(h, host)));
}

/** A destination's Service, ServiceEntry, DestinationRule and subset, and what is missing. */
export function resolveDestination(
  destination: Destination,
  weight: number,
  clientNamespace: string,
  snap: Pick<RoutingSnapshot, "destinationRules" | "serviceEntries" | "serviceExists">,
): DestinationOutcome {
  const out: DestinationOutcome = { destination, weight };
  const service = serviceOfHost(destination.fqdn);
  const entry = serviceEntryFor(destination.fqdn, snap.serviceEntries);
  if (entry) out.serviceEntry = entry.ref;
  if (service) {
    out.service = service;
    out.serviceFound = snap.serviceExists(service.namespace, service.name);
  }
  if (!entry && (service ? out.serviceFound === false : true)) out.problem = "unknownHost";
  const rule = findDestinationRule(destination.fqdn, clientNamespace, snap.destinationRules);
  if (rule) {
    out.rule = rule.ref;
    out.tlsMode = ruleTlsMode(rule, destination.port, destination.subset);
  }
  if (destination.subset) {
    const subset = rule?.subsets.find((s) => s.name === destination.subset);
    if (!rule) out.problem ??= "noDestinationRule";
    else if (!subset) out.problem ??= "missingSubset";
    else out.subsetLabels = subset.labels;
  }
  return out;
}

function chooseServer(gateway: IstioGatewayInfo, req: ParsedRequest): { server?: GatewayServer; portMismatch: boolean } {
  const byHost = gateway.servers.filter((s) => s.hosts.some((h) => hostMatches(h, req.host)));
  const byPort = byHost.find((s) => s.port === req.port);
  if (byPort) return { server: byPort, portMismatch: false };
  return { server: byHost[0], portMismatch: byHost.length > 0 };
}

export function explainMeshRequest(input: MeshRequestInput, snap: RoutingSnapshot): MeshRouteResult | undefined {
  const req = parseMeshUrl(input.url);
  if (!req) return undefined;
  const notes = new Set<NoteKey>();
  const result: MeshRouteResult = { request: req, outcome: "noRoute", used: [], candidates: [], skipped: [], destinations: [], notes: [] };
  const finish = () => {
    result.notes = [...notes];
    return result;
  };

  let key = MESH_GATEWAY;
  let viewer: string;
  let sourceLabels: Record<string, string>;
  let aliases: string[];
  if (input.from.type === "gateway") {
    const wanted = input.from.gateway;
    const gateway = snap.gateways?.find((g) => g.key === wanted);
    if (!gateway) {
      result.outcome = "unknownGateway";
      return finish();
    }
    const { server, portMismatch } = chooseServer(gateway, req);
    result.gateway = { ref: gateway.ref, server };
    if (!server) {
      result.outcome = "noGatewayServer";
      result.status = 404;
      return finish();
    }
    if (portMismatch) notes.add("gatewayPort");
    key = gateway.key;
    viewer = gateway.ref.namespace;
    sourceLabels = gateway.selector;
    aliases = [req.host];
  } else {
    viewer = input.from.namespace;
    sourceLabels = input.from.labels;
    aliases = requestHostAliases(req.host, viewer);
    if (snap.sidecarNamespaces.has(viewer) || snap.sidecarNamespaces.has(ROOT_NAMESPACE)) notes.add("sidecarScope");
  }
  const ctx: Context = { req, method: input.method.toUpperCase(), headers: input.headers, key, sourceNamespace: viewer, sourceLabels, notes };

  // The VirtualServices that apply, by the most specific host.
  const applying: { vs: VirtualService; host: string; specificity: number }[] = [];
  for (const vs of snap.virtualServices) {
    if (vs.delegate) continue;
    if (meshWildcardInvalid(vs)) {
      result.candidates.push({ ref: vs.ref, reason: "invalidMeshWildcard" });
      continue;
    }
    if (!vs.gateways.includes(key)) {
      result.candidates.push({ ref: vs.ref, reason: "notBound" });
      continue;
    }
    if (!exportedTo(vs.exportTo, vs.namespace, viewer)) {
      result.candidates.push({ ref: vs.ref, reason: "notExported" });
      continue;
    }
    let best: { host: string; specificity: number } | undefined;
    for (const pattern of vs.fqdnHosts) {
      if (!aliases.some((a) => hostMatches(pattern, a))) continue;
      const specificity = hostSpecificity(pattern);
      if (!best || specificity > best.specificity) best = { host: pattern, specificity };
    }
    if (!best) result.candidates.push({ ref: vs.ref, reason: "hostMismatch" });
    else applying.push({ vs, ...best });
  }
  const top = Math.max(-1, ...applying.map((a) => a.specificity));
  const winners = applying.filter((a) => a.specificity === top).sort((a, b) => olderFirst(a.vs, b.vs));
  for (const a of applying) if (a.specificity !== top) result.candidates.push({ ref: a.vs.ref, reason: "lessSpecificHost" });
  // A sidecar keeps only the oldest; a Gateway merges them.
  const used = key === MESH_GATEWAY ? winners.slice(0, 1) : winners;
  for (const a of winners.slice(used.length)) result.candidates.push({ ref: a.vs.ref, reason: "duplicateIgnored" });
  result.used = used.map((a) => a.vs.ref);
  result.matchedHost = used[0]?.host;

  if (used.length === 0) {
    if (input.from.type === "gateway") {
      result.outcome = "noRoute";
      result.status = 404;
      return finish();
    }
    // No VirtualService: the sidecar sends to the Service (or ServiceEntry) of the host as it is.
    for (const alias of aliases) {
      const service = serviceOfHost(alias);
      const known = service ? snap.serviceExists(service.namespace, service.name) : undefined;
      const entry = serviceEntryFor(alias, snap.serviceEntries);
      if (known || entry) {
        const destination: Destination = { host: alias, fqdn: alias };
        result.destinations = [resolveDestination(destination, 100, viewer, snap)];
        result.outcome = "defaultRoute";
        return finish();
      }
    }
    result.outcome = "passthrough";
    return finish();
  }

  const routes = used.flatMap((a) => a.vs.http.map((route) => ({ vs: a.vs, route })));
  if (routes.length === 0) {
    if (used.some((a) => a.vs.l4.length > 0)) {
      notes.add("l4NotChecked");
      result.outcome = "l4Only";
    } else {
      result.status = 404;
    }
    return finish();
  }
  if (used.some((a) => a.vs.l4.length > 0)) notes.add("l4NotChecked");

  const chosen = firstRoute(routes, ctx, result);
  if (!chosen) return finish();
  const { vs, matchIndex } = chosen;
  let route = chosen.route;
  if (route.delegate) {
    const target = snap.virtualServices.find(
      (v) => v.delegate && v.ref.name === route.delegate!.name && v.ref.namespace === route.delegate!.namespace,
    );
    if (!target) {
      result.route = { vs: vs.ref, route, matchIndex };
      result.outcome = "delegateMissing";
      result.status = 404;
      return finish();
    }
    const inner = firstRoute(target.http.map((r) => ({ vs: target, route: r })), ctx, result);
    if (!inner) return finish();
    result.route = { vs: target.ref, route: inner.route, matchIndex: inner.matchIndex, via: vs.ref };
    route = inner.route;
  } else {
    result.route = { vs: vs.ref, route, matchIndex };
  }

  if (route.directResponse) {
    result.outcome = "directResponse";
    result.status = route.directResponse.status;
    return finish();
  }
  if (route.redirect) {
    result.outcome = "redirected";
    const code = get(route.redirect, "redirectCode");
    result.status = typeof code === "number" ? code : 301;
    return finish();
  }
  const weights = weightsOf(route.destinations);
  result.destinations = route.destinations.map((d, i) => resolveDestination(d, weights[i] ?? 0, viewer, snap));
  result.outcome = "routed";
  return finish();
}

/** The first route that takes the request; records the ones skipped. `undefined` sets the outcome. */
function firstRoute(
  routes: { vs: VirtualService; route: HttpRoute }[],
  ctx: Context,
  result: MeshRouteResult,
): { vs: VirtualService; route: HttpRoute; matchIndex?: number } | undefined {
  for (const { vs, route } of routes) {
    const r = testRoute(route, ctx);
    if (r.result === "yes") return { vs, route, matchIndex: r.matchIndex };
    if (r.result === "unknown") {
      result.route = { vs: vs.ref, route };
      result.outcome = "notEvaluated";
      return undefined;
    }
    result.skipped.push({ vs: vs.ref, index: route.index, name: route.name, failedOn: r.failedOn });
  }
  result.outcome = "noRoute";
  result.status = 404;
  return undefined;
}

/** The labels a destination's pods carry: the Service's selector and the subset's labels. */
export function destinationSelector(service: KubeObject | undefined, outcome: DestinationOutcome): Record<string, string> | undefined {
  if (!service) return undefined;
  const selector = Object.fromEntries(Object.entries(record(get(service, "spec", "selector"))).map(([k, v]) => [k, String(v)]));
  if (Object.keys(selector).length === 0) return undefined;
  return { ...selector, ...(outcome.subsetLabels ?? {}) };
}

/** Pods of `pods` carrying every label of `selector`. */
export function podsWithLabels(pods: Iterable<KubeObject>, namespace: string, selector: Record<string, string>): KubeObject[] {
  const out: KubeObject[] = [];
  for (const pod of pods) {
    if (pod.metadata?.namespace !== namespace) continue;
    const labels = record(pod.metadata?.labels);
    if (Object.entries(selector).every(([k, v]) => labels[k] === v)) out.push(pod);
  }
  return out;
}

