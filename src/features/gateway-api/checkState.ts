// State and pure helpers of the "Request check" page (`RequestCheck.tsx`): the form of each cluster, remembered while
// the app runs (a module store, not saved), prefills from Gateway/Route details and the hostname map, header lines
// parsed into the engine's input, and the URL to try for a listener.
//
//   openRequestCheck(clusterId, prefill)   // fills the form, shows the page (and closes the details panel)
//   gatewayPrefill(gateway)                // the URL of the Gateway's most useful HTTP(S) listener
//   routePrefill(route, rows, gateways)    // the URL of a listener the route is accepted on (from `hostnameMap`)
//   rowPrefill(row, gateways)              // the URL of a hostname-map row
//   parseHeaderLines(text)                 // `name: value` lines → headers, or the lines that are not
import { create } from "zustand";
import type { ClusterId, KubeObject } from "../../api";
import { useAppStore } from "../../app/store";
import { status } from "../../resources";
import type {
  HostnameRow,
  LossReason,
  NamespacedName,
  Note,
  Outcome,
  PrecedenceCriterion,
  RouteId,
  RouteKindName,
} from "./matching";
import { gatewayAddresses, listenerStatuses, type ListenerStatus } from "./model";

const { arr, get, str } = status;

/** `view` of the page in the app store (`registerPage`). */
export const REQUEST_CHECK_PAGE = "gatewayApiRequestCheck";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export type CheckTab = "request" | "hostnames";

/** What the user typed. */
export interface RequestForm {
  method: string;
  grpc: boolean;
  url: string;
  /** `name: value`, one per line. */
  headers: string;
}

/** A route to find a URL for once the page has the Gateways and routes (see `routePrefill`). */
export interface PendingRoute {
  route: RouteId;
  /** The route as the details panel had it (its hostnames give the URL until the page knows more). */
  obj?: KubeObject;
}

export interface ClusterCheck {
  form: RequestForm;
  /** The form as it was last checked; no result before the first check. */
  checked: RequestForm | null;
  tab: CheckTab;
  pending: PendingRoute | null;
}

export const EMPTY_FORM: RequestForm = Object.freeze({ method: "GET", grpc: false, url: "", headers: "" }) as RequestForm;

const EMPTY_CHECK: ClusterCheck = Object.freeze({ form: EMPTY_FORM, checked: null, tab: "request", pending: null }) as ClusterCheck;

interface RequestCheckState {
  clusters: Record<ClusterId, ClusterCheck>;
  patch(clusterId: ClusterId, patch: Partial<ClusterCheck>): void;
}

export const useRequestCheckStore = create<RequestCheckState>()((set) => ({
  clusters: {},
  patch: (clusterId, patch) =>
    set((s) => ({ clusters: { ...s.clusters, [clusterId]: { ...(s.clusters[clusterId] ?? EMPTY_CHECK), ...patch } } })),
}));

/** The page's state of a cluster. */
export function useClusterCheck(clusterId: ClusterId): ClusterCheck {
  return useRequestCheckStore((s) => s.clusters[clusterId] ?? EMPTY_CHECK);
}

/** Forgets every cluster's form (tests). */
export function resetRequestChecks(): void {
  useRequestCheckStore.setState({ clusters: {} });
}

export type Prefill = { form: Partial<RequestForm> } | PendingRoute;

/**
 * Fills the form and checks it, then shows the page. For a route the URL depends on the listeners it is accepted
 * on: the form gets its first hostname at once and the page refines it once it has the Gateways (`pending`).
 */
export function openRequestCheck(clusterId: ClusterId, prefill: Prefill): void {
  const { patch } = useRequestCheckStore.getState();
  if ("form" in prefill) {
    const form = { ...EMPTY_FORM, ...prefill.form };
    patch(clusterId, { form, checked: form, tab: "request", pending: null });
  } else {
    const form = { ...EMPTY_FORM, ...routePrefill(prefill.route, [], [], prefill.obj) };
    patch(clusterId, { form, checked: form, tab: "request", pending: prefill });
  }
  const app = useAppStore.getState();
  app.closeDetails();
  app.setView(clusterId, REQUEST_CHECK_PAGE);
}

// ---------- Headers ----------

export interface ParsedHeaders {
  headers: Record<string, string>;
  /** 1-based numbers of the lines that are not `name: value`. */
  badLines: number[];
}

/** `name: value` lines (blank lines skipped; a later line with the same name wins). */
export function parseHeaderLines(text: string): ParsedHeaders {
  const headers: Record<string, string> = {};
  const badLines: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!name || /\s/.test(name)) {
      badLines.push(i + 1);
      return;
    }
    headers[name] = line.slice(colon + 1).trim();
  });
  return { headers, badLines };
}

// ---------- URLs to try ----------

const DEFAULT_PORT: Record<string, number> = { http: 80, https: 443 };

/** A name to try for a hostname: a wildcard `*.example.com` becomes `www.example.com`. */
const concreteHost = (hostname: string) => (hostname.startsWith("*.") ? `www.${hostname.slice(2)}` : hostname);

/** `https://shop.example.com/`, `http://internal.shop.example.com:8080/`; `host` when the listener names none. */
export function listenerUrl(
  listener: { hostname?: string | null; port?: number; protocol: string },
  host: string,
  path = "/",
): string {
  const scheme = listener.protocol === "HTTPS" ? "https" : "http";
  const name = listener.hostname ? concreteHost(listener.hostname) : host;
  const port = listener.port !== undefined && listener.port !== DEFAULT_PORT[scheme] ? `:${listener.port}` : "";
  return `${scheme}://${name}${port}${path}`;
}

const FALLBACK_HOST = "example.com";

const sameName = (a: NamespacedName, b: NamespacedName) => a.namespace === b.namespace && a.name === b.name;

/** The Gateway's first address (a request to it reaches that Gateway), else a placeholder name. */
function addressOf(gateways: readonly KubeObject[], ref: NamespacedName): string {
  const gw = gateways.find((g) => sameName({ namespace: g.metadata?.namespace ?? null, name: g.metadata?.name ?? "" }, ref));
  return (gw && gatewayAddresses(gw)[0]) ?? FALLBACK_HOST;
}

const isHttp = (protocol: string) => protocol === "HTTP" || protocol === "HTTPS";

/** Healthy first, then HTTPS, then an exact hostname, then a wildcard; else the listener order. */
function listenerRank(l: Pick<ListenerStatus, "protocol" | "hostname"> & { health?: string }): number {
  return (
    (l.health === "problem" ? 0 : 100) +
    (l.protocol === "HTTPS" ? 10 : 0) +
    (l.hostname ? (l.hostname.startsWith("*.") ? 1 : 2) : 0)
  );
}

function best<T>(items: readonly T[], rank: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((top, item) => (top === undefined || rank(item) > rank(top) ? item : top), undefined);
}

/** The form for a Gateway: its most useful HTTP or HTTPS listener (none: its address over HTTP). */
export function gatewayPrefill(gateway: KubeObject): Partial<RequestForm> {
  const address = gatewayAddresses(gateway)[0] ?? FALLBACK_HOST;
  const listener = best(listenerStatuses(gateway).filter((l) => isHttp(l.protocol)), listenerRank);
  return { method: "GET", grpc: false, url: listener ? listenerUrl(listener, address) : `http://${address}/` };
}

/** `/pkg.Service/Method` of a GRPCRoute's first match naming both, else `/`. */
function grpcPath(route: KubeObject | undefined): string {
  for (const rule of arr(get(route, "spec", "rules")))
    for (const match of arr(get(rule, "matches"))) {
      const service = str(get(match, "method", "service"));
      const method = str(get(match, "method", "method"));
      const regex = str(get(match, "method", "type")) === "RegularExpression";
      if (service && method && !regex) return `/${service}/${method}`;
    }
  return "/";
}

/**
 * A path an HTTPRoute serves: of its first match that asks only for a path (an Exact or PathPrefix one), else of its
 * first match at all; `/` without matches.
 */
function httpPath(route: KubeObject | undefined): string {
  const matches = arr(get(route, "spec", "rules")).flatMap((rule) => arr(get(rule, "matches")));
  const pathOnly = (m: unknown) =>
    arr(get(m, "headers")).length === 0 && arr(get(m, "queryParams")).length === 0 && !str(get(m, "method"));
  const match = matches.find(pathOnly) ?? matches[0];
  const type = str(get(match, "path", "type")) ?? "PathPrefix";
  const value = str(get(match, "path", "value"));
  return value && (type === "Exact" || type === "PathPrefix") ? value : "/";
}

const pathOf = (kind: RouteKindName, route: KubeObject | undefined) => (kind === "GRPCRoute" ? grpcPath(route) : httpPath(route));

/**
 * The form for a hostname-map row: its hostname (or the Gateway's address), the listener's scheme and port, and a
 * path the route serves.
 */
export function rowPrefill(row: HostnameRow, gateways: readonly KubeObject[], route?: KubeObject): Partial<RequestForm> {
  const grpc = row.route.kind === "GRPCRoute";
  return {
    method: grpc ? "POST" : "GET",
    grpc,
    url: listenerUrl(row, addressOf(gateways, row.gateway), pathOf(row.route.kind, route)),
  };
}

const sameRoute = (a: RouteId, b: RouteId) => a.kind === b.kind && sameName(a, b);

/**
 * The form for a route: the best row of the hostname map for it (accepted, HTTPS, a concrete hostname); without one
 * (the route attaches nowhere) its first hostname over HTTP.
 */
export function routePrefill(
  route: RouteId,
  rows: readonly HostnameRow[],
  gateways: readonly KubeObject[],
  routeObj?: KubeObject,
): Partial<RequestForm> {
  const row = best(
    rows.filter((r) => sameRoute(r.route, route)),
    (r) => (r.accepted ? 1000 : 0) + listenerRank({ protocol: r.protocol, hostname: r.hostname ?? undefined }),
  );
  if (row) return rowPrefill(row, gateways, routeObj);
  const grpc = route.kind === "GRPCRoute";
  const hostname = arr(get(routeObj, "spec", "hostnames")).find((h): h is string => typeof h === "string");
  return {
    method: grpc ? "POST" : "GET",
    grpc,
    url: `http://${hostname ? concreteHost(hostname) : FALLBACK_HOST}${pathOf(route.kind, routeObj)}`,
  };
}

/** The route kinds the request check matches. */
export const CHECKED_ROUTE_KINDS: readonly RouteKindName[] = ["HTTPRoute", "GRPCRoute"];

// ---------- Every code of the engine's results (each has a `gateway:check.*` string; a test checks) ----------

const LOSS_REASONS_SET: Record<LossReason, true> = {
  gatewayNotReady: true,
  otherAddress: true,
  noListenerMatched: true,
  noRouteMatched: true,
  otherGateway: true,
  otherPort: true,
  otherProtocol: true,
  otherHostname: true,
  listenerNotReady: true,
  lessSpecificListener: true,
  otherRouteKind: true,
  notAttached: true,
  notAccepted: true,
  kindNotAllowed: true,
  noHostnameIntersection: true,
  otherHost: true,
  pathMismatch: true,
  methodMismatch: true,
  headerMismatch: true,
  queryMismatch: true,
  grpcServiceMismatch: true,
  grpcMethodMismatch: true,
  invalidRegex: true,
  lowerPrecedence: true,
};

const CRITERIA_SET: Record<PrecedenceCriterion, true> = {
  routeKind: true,
  hostname: true,
  hostnameLength: true,
  path: true,
  method: true,
  headers: true,
  queryParams: true,
  service: true,
  grpcMethod: true,
  age: true,
  name: true,
  ruleOrder: true,
};

const NOTES_SET: Record<Note, true> = {
  regexPathPrecedence: true,
  regexDialect: true,
  severalGateways: true,
  listenerPending: true,
  partialBackends: true,
};

const OUTCOMES_SET: Record<Outcome, true> = {
  forwarded: true,
  redirected: true,
  noListener: true,
  noRoute: true,
  noBackend: true,
  invalidUrl: true,
};

/** `gateway:check.loss.<reason>`. */
export const LOSS_REASONS = Object.keys(LOSS_REASONS_SET) as LossReason[];
/** `gateway:check.criteria.<criterion>`. */
export const PRECEDENCE_CRITERIA = Object.keys(CRITERIA_SET) as PrecedenceCriterion[];
/** `gateway:check.notes.<note>`. */
export const NOTES = Object.keys(NOTES_SET) as Note[];
/** `gateway:check.outcome.<outcome>`. */
export const OUTCOMES = Object.keys(OUTCOMES_SET) as Outcome[];
