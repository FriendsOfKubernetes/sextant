// What the Gateway API section reads from `gateway.networking.k8s.io` objects: the kinds it knows, their conditions
// (per listener on a Gateway, per parent on a Route), the relations between them (a route's parents, the routes
// attached to a Gateway, the backends of each rule) and the ReferenceGrant a cross-namespace reference needs. Pure
// functions, no React: the tables, the details and later views (reverse links, topology, the request check) share
// them.
//
//   listenerStatuses(gateway)           // spec.listeners merged with status.listeners: health, attached routes, …
//   parentStatuses(route)               // spec.parentRefs merged with status.parents: Accepted, ResolvedRefs, health
//   routeAttachedTo(route, gw, lst?)    // the route's parent entry for that Gateway (and listener), if it names it
//   routeRules(route) / backendRefs(r)  // rules as phrases (i18n keys); backends with weights as shares of traffic
//   explainReason(reason)               // the i18n key of a plain-language explanation of a condition reason
//   referenceGrantFor(from, to)         // the ReferenceGrant that permits `from` to refer to `to`
//   backendIssue(b, ctx)                // RefNotPermitted (no ReferenceGrant) | InvalidKind | BackendNotFound
//   healthOf(obj, kind) / isProblem     // "ok" | "pending" | "problem"; only "problem" is filtered and counted
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";

const { arr, get, num, record, str } = status;

export const GATEWAY_GROUP = "gateway.networking.k8s.io";

const k = (version: string, kind: string): KindRef => ({ group: GATEWAY_GROUP, version, kind });

// The versions registered are the ones current Gateway API serves; the backend falls back to the version discovery
// serves (experimental-channel kinds move between versions).
export const GATEWAY_CLASS = k("v1", "GatewayClass");
export const GATEWAY = k("v1", "Gateway");
export const HTTP_ROUTE = k("v1", "HTTPRoute");
export const GRPC_ROUTE = k("v1", "GRPCRoute");
export const TLS_ROUTE = k("v1alpha2", "TLSRoute");
export const TCP_ROUTE = k("v1alpha2", "TCPRoute");
export const UDP_ROUTE = k("v1alpha2", "UDPRoute");
export const REFERENCE_GRANT = k("v1beta1", "ReferenceGrant");
export const BACKEND_TLS_POLICY = k("v1", "BackendTLSPolicy");

/** One kind of the section: its sidebar position and label (key under `gateway:sidebar`). */
export interface GatewayKind {
  kind: KindRef;
  order: number;
  label: string;
  namespaced: boolean;
}

export const GATEWAY_KINDS: GatewayKind[] = [
  { kind: GATEWAY_CLASS, order: 10, label: "gatewayClasses", namespaced: false },
  { kind: GATEWAY, order: 20, label: "gateways", namespaced: true },
  { kind: HTTP_ROUTE, order: 30, label: "httpRoutes", namespaced: true },
  { kind: GRPC_ROUTE, order: 31, label: "grpcRoutes", namespaced: true },
  { kind: TLS_ROUTE, order: 32, label: "tlsRoutes", namespaced: true },
  { kind: TCP_ROUTE, order: 33, label: "tcpRoutes", namespaced: true },
  { kind: UDP_ROUTE, order: 34, label: "udpRoutes", namespaced: true },
  { kind: REFERENCE_GRANT, order: 40, label: "referenceGrants", namespaced: true },
  { kind: BACKEND_TLS_POLICY, order: 50, label: "backendTlsPolicies", namespaced: true },
];

/** The route kinds, in the order the section lists them. */
export const ROUTE_KINDS: KindRef[] = [HTTP_ROUTE, GRPC_ROUTE, TLS_ROUTE, TCP_ROUTE, UDP_ROUTE];

const same = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) =>
  a.group === b.group && a.kind === b.kind;

export function isKind(kind: Pick<KindRef, "group" | "kind">, ...kinds: KindRef[]): boolean {
  return kinds.some((other) => same(kind, other));
}

/** The section's entry of `kind` (any version), if it is one. */
export function gatewayKind(kind: Pick<KindRef, "group" | "kind">): GatewayKind | undefined {
  return GATEWAY_KINDS.find((g) => same(g.kind, kind));
}

export function isRouteKind(kind: Pick<KindRef, "group" | "kind">): boolean {
  return isKind(kind, ...ROUTE_KINDS);
}

// ---------- Conditions ----------

export interface Condition {
  type: string;
  /** "True" | "False" | "Unknown". */
  status: string;
  reason?: string;
  message?: string;
}

/** The conditions of a `conditions` array (entries without a type are left out). */
export function conditionsOf(value: unknown): Condition[] {
  return arr(value).flatMap((c) => {
    const type = str(get(c, "type"));
    if (!type) return [];
    return [{ type, status: str(get(c, "status")) ?? "Unknown", reason: str(get(c, "reason")), message: str(get(c, "message")) }];
  });
}

export function conditionOf(conditions: readonly Condition[], type: string): Condition | undefined {
  return conditions.find((c) => c.type === type);
}

/**
 * How a hop is doing: `ok` (accepted and programmed), `pending` (no controller has said anything yet, or it is still
 * working on it), `problem` (a controller rejected it or something it refers to).
 */
export type Health = "ok" | "pending" | "problem";

/** The worst of several healths. */
export function worst(healths: readonly Health[]): Health {
  if (healths.includes("problem")) return "problem";
  if (healths.includes("pending")) return "pending";
  return "ok";
}

/** A condition whose status `bad` ("False" for Accepted, "True" for Conflicted) makes the hop a problem. */
type Check = readonly [type: string, bad: "True" | "False"];

/**
 * Health from conditions: the first check, in order, whose condition has its bad status is the problem — unless its
 * reason is `Pending` (the controller is still working on it); a condition that must be True (`bad` = "False") but is
 * missing, Unknown or False for `Pending` leaves the hop pending.
 */
function judge(conditions: readonly Condition[], checks: readonly Check[]): { health: Health; problem?: Condition } {
  for (const [type, bad] of checks) {
    const c = conditionOf(conditions, type);
    if (c?.status === bad && c.reason !== "Pending") return { health: "problem", problem: c };
  }
  for (const [type, bad] of checks) {
    if (bad !== "False") continue;
    const c = conditionOf(conditions, type);
    if (c?.status !== "True") return { health: "pending", problem: c };
  }
  return { health: "ok" };
}

// ---------- References ----------

/** A reference to another object, with the API's defaults filled in. `namespace` is `null` for cluster-scoped. */
export interface ObjRef {
  group: string;
  kind: string;
  name: string;
  namespace: string | null;
}

/** `apiVersion` to open a referenced object with (the group's served version is found by the backend). */
export function apiVersionFor(ref: Pick<ObjRef, "group" | "kind">): string {
  if (ref.group === "") return "v1";
  if (ref.group === GATEWAY_GROUP) return `${GATEWAY_GROUP}/${gatewayKind(ref)?.kind.version ?? "v1"}`;
  return `${ref.group}/v1`;
}

const namespaceOf = (obj: KubeObject): string | null => obj.metadata?.namespace ?? null;

// ---------- GatewayClass ----------

export function controllerName(gatewayClass: KubeObject): string | undefined {
  return str(get(gatewayClass, "spec", "controllerName"));
}

export function gatewayClassHealth(gatewayClass: KubeObject): { health: Health; problem?: Condition } {
  return judge(conditionsOf(get(gatewayClass, "status", "conditions")), [["Accepted", "False"]]);
}

// ---------- Gateway ----------

export function gatewayClassName(gateway: KubeObject): string | undefined {
  return str(get(gateway, "spec", "gatewayClassName"));
}

/** The addresses the Gateway got (`status.addresses`), else the ones it asked for (`spec.addresses`). */
export function gatewayAddresses(gateway: KubeObject): string[] {
  const values = (field: unknown) =>
    arr(field)
      .map((a) => str(get(a, "value")))
      .filter((v): v is string => Boolean(v));
  const assigned = values(get(gateway, "status", "addresses"));
  return assigned.length > 0 ? assigned : values(get(gateway, "spec", "addresses"));
}

export interface Listener {
  name: string;
  port?: number;
  protocol: string;
  hostname?: string;
  /** `Terminate` | `Passthrough` when the listener has a `tls` block. */
  tlsMode?: string;
  /** TLS certificates (Secrets by default), with the Gateway's namespace filled in. */
  certificateRefs: ObjRef[];
  /** Where routes may attach from: `Same` (default), `All`, `Selector`. */
  allowedFrom: string;
  /** The namespace selector of `Selector`, as `key=value` terms. */
  allowedSelector: string[];
  /** Route kinds allowed (`allowedRoutes.kinds`); empty = the kinds the protocol supports. */
  allowedKinds: string[];
}

export interface ListenerStatus extends Listener {
  /** `status.listeners[].attachedRoutes`; undefined before the controller reported. */
  attachedRoutes?: number;
  /** Route kinds the controller supports on this listener. */
  supportedKinds: string[];
  conditions: Condition[];
  health: Health;
  /** The condition that says what is wrong (or what it waits for). */
  problem?: Condition;
}

function selectorTerms(selector: unknown): string[] {
  const labels = Object.entries(record(get(selector, "matchLabels"))).map(([key, v]) => `${key}=${String(v)}`);
  const expressions = arr(get(selector, "matchExpressions")).map((e) => {
    const values = arr(get(e, "values")).map(String).join(",");
    return `${str(get(e, "key")) ?? ""} ${str(get(e, "operator")) ?? ""}${values ? ` (${values})` : ""}`;
  });
  return [...labels, ...expressions];
}

/** `spec.listeners` with the API's defaults. */
export function listeners(gateway: KubeObject): Listener[] {
  const ns = namespaceOf(gateway);
  return arr(get(gateway, "spec", "listeners")).map((l) => {
    const tls = get(l, "tls");
    return {
      name: str(get(l, "name")) ?? "",
      port: num(get(l, "port")),
      protocol: str(get(l, "protocol")) ?? "",
      hostname: str(get(l, "hostname")),
      tlsMode: tls ? (str(get(tls, "mode")) ?? "Terminate") : undefined,
      certificateRefs: arr(get(tls, "certificateRefs")).map((c) => ({
        group: str(get(c, "group")) ?? "",
        kind: str(get(c, "kind")) ?? "Secret",
        name: str(get(c, "name")) ?? "",
        namespace: str(get(c, "namespace")) ?? ns,
      })),
      allowedFrom: str(get(l, "allowedRoutes", "namespaces", "from")) ?? "Same",
      allowedSelector: selectorTerms(get(l, "allowedRoutes", "namespaces", "selector")),
      allowedKinds: arr(get(l, "allowedRoutes", "kinds"))
        .map((kind) => str(get(kind, "kind")))
        .filter((v): v is string => Boolean(v)),
    };
  });
}

/**
 * Every listener of the spec with what the controller reported for it (`status.listeners`, by name). A listener is a
 * problem when it is not Accepted, Conflicted, its references do not resolve (a certificate) or it is not
 * Programmed; pending while the controller has not reported it.
 */
export function listenerStatuses(gateway: KubeObject): ListenerStatus[] {
  const reported = arr(get(gateway, "status", "listeners"));
  return listeners(gateway).map((listener) => {
    const entry = reported.find((s) => str(get(s, "name")) === listener.name);
    const conditions = conditionsOf(get(entry, "conditions"));
    const verdict = entry
      ? judge(conditions, [
          ["Accepted", "False"],
          ["Conflicted", "True"],
          ["ResolvedRefs", "False"],
          ["Programmed", "False"],
        ])
      : { health: "pending" as const };
    return {
      ...listener,
      attachedRoutes: num(get(entry, "attachedRoutes")),
      supportedKinds: arr(get(entry, "supportedKinds"))
        .map((kind) => str(get(kind, "kind")))
        .filter((v): v is string => Boolean(v)),
      conditions,
      ...verdict,
    };
  });
}

/** How many listeners are Programmed, of how many: the "Listeners 2/3" column. */
export function listenersProgrammed(gateway: KubeObject): { programmed: number; total: number } {
  const all = listenerStatuses(gateway);
  return {
    programmed: all.filter((l) => conditionOf(l.conditions, "Programmed")?.status === "True").length,
    total: all.length,
  };
}

/** Routes attached to all listeners together (a route on two listeners counts twice, as the controllers count). */
export function attachedRouteCount(gateway: KubeObject): number | undefined {
  const counts = arr(get(gateway, "status", "listeners"))
    .map((s) => num(get(s, "attachedRoutes")))
    .filter((n): n is number => n !== undefined);
  return counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : undefined;
}

/** The Gateway's own conditions (Accepted, Programmed), without its listeners. */
export function gatewayOwnHealth(gateway: KubeObject): { health: Health; problem?: Condition } {
  return judge(conditionsOf(get(gateway, "status", "conditions")), [
    ["Accepted", "False"],
    ["Programmed", "False"],
  ]);
}

/** The Gateway itself (Accepted, Programmed) and the worst of its listeners. */
export function gatewayHealth(gateway: KubeObject): { health: Health; problem?: Condition } {
  const own = gatewayOwnHealth(gateway);
  if (own.health === "problem") return own;
  const broken = listenerStatuses(gateway).find((l) => l.health === "problem");
  if (broken) return { health: "problem", problem: broken.problem };
  if (own.health === "pending") return own;
  const waiting = listenerStatuses(gateway).find((l) => l.health === "pending");
  return waiting ? { health: "pending", problem: waiting.problem } : own;
}

// ---------- Routes and their parents ----------

/** A route's `parentRefs` entry with defaults (a Gateway in the route's namespace). */
export interface ParentRef extends ObjRef {
  /** The listener name it attaches to; any listener when absent. */
  sectionName?: string;
  port?: number;
}

function parentRefOf(value: unknown, routeNamespace: string | null): ParentRef {
  return {
    group: str(get(value, "group")) ?? GATEWAY_GROUP,
    kind: str(get(value, "kind")) ?? "Gateway",
    name: str(get(value, "name")) ?? "",
    namespace: str(get(value, "namespace")) ?? routeNamespace,
    sectionName: str(get(value, "sectionName")),
    port: num(get(value, "port")),
  };
}

const sameParent = (a: ParentRef, b: ParentRef) =>
  a.group === b.group &&
  a.kind === b.kind &&
  a.name === b.name &&
  a.namespace === b.namespace &&
  a.sectionName === b.sectionName &&
  a.port === b.port;

export function parentRefs(route: KubeObject): ParentRef[] {
  const ns = namespaceOf(route);
  return arr(get(route, "spec", "parentRefs")).map((p) => parentRefOf(p, ns));
}

/** One parent of a route and what its controller said about the route there. */
export interface ParentStatus {
  ref: ParentRef;
  controllerName?: string;
  conditions: Condition[];
  accepted?: Condition;
  resolvedRefs?: Condition;
  health: Health;
  /** The condition that says what is wrong (or what it waits for). */
  problem?: Condition;
}

/**
 * Each `spec.parentRefs` entry with its `status.parents` entry. A parent is a problem when the route is not
 * Accepted there, its references do not resolve or some rules were dropped (`PartiallyInvalid`); pending while no
 * controller reported it. Status entries for parents no longer in the spec are kept (the controller has not caught
 * up yet).
 */
export function parentStatuses(route: KubeObject): ParentStatus[] {
  const ns = namespaceOf(route);
  const reported = arr(get(route, "status", "parents")).map((p) => ({
    ref: parentRefOf(get(p, "parentRef"), ns),
    controllerName: str(get(p, "controllerName")),
    conditions: conditionsOf(get(p, "conditions")),
  }));
  const describe = (ref: ParentRef, entry: (typeof reported)[number] | undefined): ParentStatus => {
    const conditions = entry?.conditions ?? [];
    const verdict = entry
      ? judge(conditions, [
          ["Accepted", "False"],
          ["ResolvedRefs", "False"],
          ["PartiallyInvalid", "True"],
        ])
      : { health: "pending" as const };
    return {
      ref,
      controllerName: entry?.controllerName,
      conditions,
      accepted: conditionOf(conditions, "Accepted"),
      resolvedRefs: conditionOf(conditions, "ResolvedRefs"),
      ...verdict,
    };
  };
  const fromSpec = parentRefs(route).map((ref) => describe(ref, reported.find((r) => sameParent(r.ref, ref))));
  const extra = reported
    .filter((r) => !fromSpec.some((p) => sameParent(p.ref, r.ref)))
    .map((r) => describe(r.ref, r));
  return [...fromSpec, ...extra];
}

export function routeHealth(route: KubeObject): { health: Health; problem?: Condition } {
  const parents = parentStatuses(route);
  return (
    parents.find((p) => p.health === "problem") ??
    parents.find((p) => p.health === "pending") ?? { health: "ok" as const }
  );
}

/**
 * The parent entry of `route` that refers to `gateway` — and, when `listener` is given, can attach to that listener
 * (no `sectionName`/`port`, or ones naming it). `undefined` when the route does not name the Gateway there. Whether
 * it is attached is `accepted?.status === "True"` of the result.
 */
export function routeAttachedTo(
  route: KubeObject,
  gateway: KubeObject,
  listener?: Pick<Listener, "name" | "port">,
): ParentStatus | undefined {
  const named = parentStatuses(route).filter(
    ({ ref }) =>
      ref.group === GATEWAY_GROUP &&
      ref.kind === "Gateway" &&
      ref.name === gateway.metadata?.name &&
      ref.namespace === namespaceOf(gateway) &&
      (!listener ||
        ((ref.sectionName === undefined || ref.sectionName === listener.name) &&
          (ref.port === undefined || ref.port === listener.port))),
  );
  if (!listener) return named[0];
  // Several entries can reach one listener (`{gw, sectionName: a}` and `{gw}`): the one naming the listener speaks
  // for it (`{gw}` Accepted only says the route attached to some listener), then an accepted one.
  const specificity = ({ ref }: ParentStatus) => (ref.sectionName !== undefined ? 2 : 0) + (ref.port !== undefined ? 1 : 0);
  const accepted = (p: ParentStatus) => (p.accepted?.status === "True" ? 1 : 0);
  return [...named].sort((a, b) => specificity(b) - specificity(a) || accepted(b) - accepted(a))[0];
}

export function routeHostnames(route: KubeObject): string[] {
  return arr(get(route, "spec", "hostnames")).filter((h): h is string => typeof h === "string");
}

// ---------- Rules ----------

/** A backend of a rule, with defaults (a Service in the route's namespace, weight 1). */
export interface BackendRef extends ObjRef {
  port?: number;
  weight: number;
  /** Share of the rule's traffic, 0–100 (rounded); weights all 0 give 0 each. */
  percent: number;
}

/** A rule of any route kind, readable. */
export interface RouteRule {
  /** Position in `spec.rules` (0-based). */
  index: number;
  name?: string;
  /** Each match as phrases (shown joined with " · "). A rule without matches matches everything. */
  matches: Phrase[][];
  /** The filters' phrases, in order: "set header x-env=prod", "redirect → https:// 301". */
  filters: Phrase[];
  /** Backends RequestMirror filters copy requests to (no share of the traffic). */
  mirrors: BackendRef[];
  /** `type` of each filter ("RequestRedirect", …), in order. */
  filterTypes: string[];
  backends: BackendRef[];
}

function backendsOf(rule: unknown, routeNamespace: string | null): BackendRef[] {
  const raw = arr(get(rule, "backendRefs")).map((b) => ({
    group: str(get(b, "group")) ?? "",
    kind: str(get(b, "kind")) ?? "Service",
    name: str(get(b, "name")) ?? "",
    namespace: str(get(b, "namespace")) ?? routeNamespace,
    port: num(get(b, "port")),
    weight: num(get(b, "weight")) ?? 1,
  }));
  const percents = sharesOf(raw.map((b) => b.weight));
  return raw.map((b, i) => ({ ...b, percent: percents[i] ?? 0 }));
}

/**
 * Weights as whole percentages that add up to 100 (largest remainder: the floors, then one more point to the largest
 * fractions); all 0 when the weights are.
 */
export function sharesOf(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / total) * 100);
  const shares = exact.map(Math.floor);
  let left = 100 - shares.reduce((sum, v) => sum + v, 0);
  const order = exact.map((v, i) => ({ i, rest: v - Math.floor(v) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] = (shares[i] ?? 0) + 1;
    left--;
  }
  return shares;
}

/**
 * A piece of readable text as an i18n key under `gateway:text` and its parameters (the UI translates it), so the
 * model builds no English: `{ key: "gateway:text.header", params: { name: "x-env", op: "=", value: "prod" } }`.
 */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
}

const phrase = (key: string, params?: Phrase["params"]): Phrase => ({ key: `gateway:text.${key}`, params });

const HEADER_OPS: Record<string, string> = { Exact: "=", RegularExpression: "~" };

function headerMatch(key: string, h: unknown): Phrase {
  return phrase(key, {
    name: str(get(h, "name")) ?? "",
    op: HEADER_OPS[str(get(h, "type")) ?? "Exact"] ?? "=",
    value: str(get(h, "value")) ?? "",
  });
}

/** An HTTPRoute match: path ("PathPrefix /api", default `PathPrefix /`), headers, query parameters, method. */
export function httpMatchPhrases(match: unknown): Phrase[] {
  const path = get(match, "path");
  const method = str(get(match, "method"));
  return [
    phrase("path", { type: str(get(path, "type")) ?? "PathPrefix", value: str(get(path, "value")) ?? "/" }),
    ...arr(get(match, "headers")).map((h) => headerMatch("header", h)),
    ...arr(get(match, "queryParams")).map((q) => headerMatch("query", q)),
    ...(method ? [phrase("httpMethod", { method })] : []),
  ];
}

/** A GRPCRoute match: the method ("any method" when it names none) and headers. */
export function grpcMatchPhrases(match: unknown): Phrase[] {
  const method = get(match, "method");
  const service = str(get(method, "service"));
  const name = str(get(method, "method"));
  const regex = str(get(method, "type")) === "RegularExpression";
  const target =
    service || name
      ? phrase(regex ? "grpcMethodRegex" : "grpcMethod", { service: service ?? "*", method: name ?? "*" })
      : phrase("anyMethod");
  return [target, ...arr(get(match, "headers")).map((h) => headerMatch("header", h))];
}

function headerChanges(modifier: unknown, prefix: "" | "response"): Phrase[] {
  const key = (op: string) => (prefix ? `response${op[0]?.toUpperCase() ?? ""}${op.slice(1)}` : op);
  const pairs = (field: string) =>
    arr(get(modifier, field)).map((h) => ({ name: str(get(h, "name")) ?? "", value: str(get(h, "value")) ?? "" }));
  return [
    ...pairs("set").map((p) => phrase(key("setHeader"), p)),
    ...pairs("add").map((p) => phrase(key("addHeader"), p)),
    ...arr(get(modifier, "remove"))
      .filter((h): h is string => typeof h === "string")
      .map((name) => phrase(key("removeHeader"), { name })),
  ];
}

/** `replaceFullPath` / `replacePrefixMatch` of a redirect or rewrite (`kind` "redirect" | "rewrite"). */
function pathModifier(path: unknown, kind: string): Phrase[] {
  const full = str(get(path, "replaceFullPath"));
  if (full !== undefined) return [phrase(`${kind}Path`, { value: full })];
  const prefix = str(get(path, "replacePrefixMatch"));
  return prefix !== undefined ? [phrase(`${kind}Prefix`, { value: prefix })] : [];
}

/** The backend a RequestMirror filter copies requests to, with defaults (a Service in the route's namespace). */
function mirrorOf(filter: unknown, routeNamespace: string | null): BackendRef | undefined {
  if (str(get(filter, "type")) !== "RequestMirror") return undefined;
  const b = get(filter, "requestMirror", "backendRef");
  if (!b) return undefined;
  return {
    group: str(get(b, "group")) ?? "",
    kind: str(get(b, "kind")) ?? "Service",
    name: str(get(b, "name")) ?? "",
    namespace: str(get(b, "namespace")) ?? routeNamespace,
    port: num(get(b, "port")),
    weight: 0,
    percent: 0,
  };
}

/**
 * A filter as phrases: header changes (each one), redirect, rewrite, mirror, extension; an unknown type by its name.
 * `routeNamespace` shortens a mirror backend in the route's own namespace.
 */
export function filterPhrases(filter: unknown, routeNamespace: string | null = null): Phrase[] {
  const type = str(get(filter, "type")) ?? "";
  switch (type) {
    case "RequestHeaderModifier":
      return headerChanges(get(filter, "requestHeaderModifier"), "");
    case "ResponseHeaderModifier":
      return headerChanges(get(filter, "responseHeaderModifier"), "response");
    case "RequestRedirect": {
      const r = get(filter, "requestRedirect");
      const scheme = str(get(r, "scheme"));
      const port = num(get(r, "port"));
      const target = `${scheme ? `${scheme}://` : ""}${str(get(r, "hostname")) ?? ""}${port !== undefined ? `:${port}` : ""}`;
      return [
        phrase("redirect", { target: target || "…", code: num(get(r, "statusCode")) ?? 302 }),
        ...pathModifier(get(r, "path"), "redirect"),
      ];
    }
    case "URLRewrite": {
      const r = get(filter, "urlRewrite");
      const host = str(get(r, "hostname"));
      return [...(host ? [phrase("rewriteHost", { host })] : []), ...pathModifier(get(r, "path"), "rewrite")];
    }
    case "RequestMirror": {
      const mirror = mirrorOf(filter, routeNamespace);
      return mirror ? [phrase("mirror", { backend: backendText(mirror, routeNamespace) })] : [];
    }
    case "ExtensionRef":
      return [
        phrase("extension", {
          kind: str(get(filter, "extensionRef", "kind")) ?? "",
          name: str(get(filter, "extensionRef", "name")) ?? "",
        }),
      ];
    default:
      return type ? [phrase("filter", { type })] : [];
  }
}

/**
 * The rules of a route, readable. HTTPRoute and GRPCRoute rules have matches and filters; TLS, TCP and UDP routes
 * only backends.
 */
export function routeRules(route: KubeObject, kind: Pick<KindRef, "group" | "kind">): RouteRule[] {
  const ns = namespaceOf(route);
  const grpc = isKind(kind, GRPC_ROUTE);
  const http = isKind(kind, HTTP_ROUTE);
  return arr(get(route, "spec", "rules")).map((rule, index) => ({
    index,
    name: str(get(rule, "name")),
    matches: http || grpc ? arr(get(rule, "matches")).map(grpc ? grpcMatchPhrases : httpMatchPhrases) : [],
    filters: http || grpc ? arr(get(rule, "filters")).flatMap((f) => filterPhrases(f, ns)) : [],
    mirrors: http || grpc ? arr(get(rule, "filters")).flatMap((f) => mirrorOf(f, ns) ?? []) : [],
    filterTypes: http || grpc ? arr(get(rule, "filters")).map((f) => str(get(f, "type")) ?? "") : [],
    backends: backendsOf(rule, ns),
  }));
}

export function ruleCount(route: KubeObject): number {
  return arr(get(route, "spec", "rules")).length;
}

/** Every backend of every rule (duplicates by kind, namespace, name and port removed). */
export function backendRefs(route: KubeObject): BackendRef[] {
  const ns = namespaceOf(route);
  const all = arr(get(route, "spec", "rules")).flatMap((rule) => backendsOf(rule, ns));
  return all.filter(
    (b, i) => all.findIndex((o) => backendKey(o) === backendKey(b)) === i,
  );
}

export const backendKey = (b: ObjRef & { port?: number }) =>
  `${b.group}/${b.kind}/${b.namespace ?? ""}/${b.name}:${b.port ?? ""}`;

/** "api-v2:8080", "other-ns/api:8080" (another namespace than `from`), "Bucket assets" (not a Service). */
export function backendText(b: BackendRef, fromNamespace: string | null): string {
  const service = b.group === "" && b.kind === "Service";
  const ns = b.namespace && b.namespace !== fromNamespace ? `${b.namespace}/` : "";
  const port = b.port !== undefined ? `:${b.port}` : "";
  return service ? `${ns}${b.name}${port}` : `${b.kind} ${ns}${b.name}${port}`;
}

/** "api-v2:8080 90%, api-v1:8080 10%"; one backend without a share. */
export function backendsText(rule: RouteRule, fromNamespace: string | null): string {
  return rule.backends
    .map((b) => (rule.backends.length > 1 ? `${backendText(b, fromNamespace)} ${b.percent}%` : backendText(b, fromNamespace)))
    .join(", ");
}

/** A backend in another namespace than the route: it needs a ReferenceGrant there. */
export function isCrossNamespace(b: ObjRef, fromNamespace: string | null): boolean {
  return b.namespace !== null && b.namespace !== fromNamespace;
}

const isService = (b: Pick<ObjRef, "group" | "kind">) => b.group === "" && b.kind === "Service";

/** What `backendIssue` knows about the cluster around a route. */
export interface BackendContext {
  /** The route: its namespace and kind (the `from` of a ReferenceGrant). */
  routeNamespace: string | null;
  routeKind: string;
  parents: readonly ParentStatus[];
  /** Names of every Service in a namespace; `undefined` while unknown. */
  servicesIn?: (namespace: string) => ReadonlySet<string> | undefined;
  /** The ReferenceGrants of a namespace; `undefined` while unknown. */
  grantsIn?: (namespace: string) => readonly KubeObject[] | undefined;
}

/**
 * What is wrong with one backend (or mirror), as a condition reason:
 *  - `RefNotPermitted` — a parent reported it, the backend is in another namespace and no ReferenceGrant there permits
 *    it (while the grants are unknown, every backend in another namespace is suspected);
 *  - `InvalidKind` — a parent reported it and the backend is not a Service;
 *  - `BackendNotFound` — the Service is not among those of its namespace.
 */
export function backendIssue(backend: BackendRef, context: BackendContext): string | undefined {
  const { routeNamespace, routeKind, parents, servicesIn, grantsIn } = context;
  const reported = new Set(parents.map((p) => p.resolvedRefs).filter((c) => c?.status === "False").map((c) => c?.reason));
  if (reported.has("RefNotPermitted") && isCrossNamespace(backend, routeNamespace) && routeNamespace) {
    const grants = backend.namespace ? grantsIn?.(backend.namespace) : undefined;
    const from = { group: GATEWAY_GROUP, kind: routeKind, namespace: routeNamespace };
    if (!grants || !referencePermitted(grants, from, backend)) return "RefNotPermitted";
  }
  if (reported.has("InvalidKind") && !isService(backend)) return "InvalidKind";
  if (isService(backend) && backend.namespace) {
    const known = servicesIn?.(backend.namespace);
    if (known && !known.has(backend.name)) return "BackendNotFound";
  }
  return undefined;
}

/**
 * The certificates of a listener in another namespace than the Gateway that no ReferenceGrant there permits (while
 * the grants of a namespace are unknown, its certificates are suspected).
 */
export function unpermittedCertificates(
  gateway: KubeObject,
  listener: Pick<Listener, "certificateRefs">,
  grantsIn?: (namespace: string) => readonly KubeObject[] | undefined,
): ObjRef[] {
  const ns = namespaceOf(gateway);
  if (!ns) return [];
  const from = { group: GATEWAY_GROUP, kind: "Gateway", namespace: ns };
  return listener.certificateRefs.filter((ref) => {
    if (!isCrossNamespace(ref, ns)) return false;
    const grants = ref.namespace ? grantsIn?.(ref.namespace) : undefined;
    return !grants || !referencePermitted(grants, from, ref);
  });
}

/** Ready endpoints of a Service from its EndpointSlices (`kubernetes.io/service-name`); an endpoint counts once. */
export function serviceReadiness(
  slices: Iterable<KubeObject>,
  service: { namespace: string; name: string },
): { ready: number; total: number } {
  const seen = new Map<string, boolean>();
  for (const slice of slices) {
    if (slice.metadata?.namespace !== service.namespace) continue;
    if (record(slice.metadata?.labels)["kubernetes.io/service-name"] !== service.name) continue;
    for (const e of arr(get(slice, "endpoints"))) {
      const key = str(get(e, "targetRef", "uid")) ?? arr(get(e, "addresses")).map(String).join(",");
      // `ready` absent means ready (EndpointSlice API).
      const ready = get(e, "conditions", "ready") !== false;
      seen.set(key, (seen.get(key) ?? false) || ready);
    }
  }
  const values = [...seen.values()];
  return { ready: values.filter(Boolean).length, total: values.length };
}

// ---------- ReferenceGrant ----------

export interface GrantFrom {
  group: string;
  kind: string;
  namespace: string;
}

export interface GrantTo {
  group: string;
  kind: string;
  /** Only this object; any of the kind when absent. */
  name?: string;
}

export function grantFrom(grant: KubeObject): GrantFrom[] {
  return arr(get(grant, "spec", "from")).map((f) => ({
    group: str(get(f, "group")) ?? "",
    kind: str(get(f, "kind")) ?? "",
    namespace: str(get(f, "namespace")) ?? "",
  }));
}

export function grantTo(grant: KubeObject): GrantTo[] {
  return arr(get(grant, "spec", "to")).map((t) => ({
    group: str(get(t, "group")) ?? "",
    kind: str(get(t, "kind")) ?? "",
    name: str(get(t, "name")) || undefined,
  }));
}

/** Whether one of `grants` (in `to.namespace`) lets objects like `from` refer to `to`. */
export function referencePermitted(grants: readonly KubeObject[], from: GrantFrom, to: ObjRef): boolean {
  return grants.some(
    (grant) =>
      namespaceOf(grant) === to.namespace &&
      grantFrom(grant).some((f) => f.group === from.group && f.kind === from.kind && f.namespace === from.namespace) &&
      grantTo(grant).some((t) => t.group === to.group && t.kind === to.kind && (t.name === undefined || t.name === to.name)),
  );
}

/** A DNS-1123 name of at most 63 characters. */
function dnsName(parts: string[]): string {
  return parts
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 63)
    .replace(/^-+|-+$/g, "");
}

/**
 * The ReferenceGrant that lets objects of `from`'s kind in `from.namespace` refer to `to` (only that object, when
 * `to` names one): it lives in `to`'s namespace. `apiVersion` is the one the cluster serves (v1beta1 in the standard
 * channel).
 */
export function referenceGrantFor(
  from: GrantFrom,
  to: { group: string; kind: string; namespace: string; name?: string },
  apiVersion = `${GATEWAY_GROUP}/${REFERENCE_GRANT.version}`,
): KubeObject {
  const name = dnsName(["allow", from.kind, "from", from.namespace, "to", to.kind, ...(to.name ? [to.name] : [])]);
  return {
    apiVersion,
    kind: "ReferenceGrant",
    metadata: { name, namespace: to.namespace },
    spec: {
      from: [{ group: from.group, kind: from.kind, namespace: from.namespace }],
      to: [{ group: to.group, kind: to.kind, ...(to.name ? { name: to.name } : {}) }],
    },
  };
}

// ---------- Explanations ----------

/** Reasons `gateway:reasons.<reason>` explains in plain language. */
export const EXPLAINED_REASONS = [
  "NotAllowedByListeners",
  "NoMatchingListenerHostname",
  "NoMatchingParent",
  "UnsupportedValue",
  "RefNotPermitted",
  "BackendNotFound",
  "InvalidKind",
  "UnsupportedProtocol",
  "InvalidCertificateRef",
  "InvalidRouteKinds",
  "HostnameConflict",
  "ProtocolConflict",
  "PortUnavailable",
  "ListenersNotValid",
  "InvalidListeners",
  "AddressNotAssigned",
  "AddressNotUsable",
  "NoResources",
  "InvalidParameters",
  "UnsupportedAddress",
  "UnsupportedVersion",
  "Pending",
  "Invalid",
  "PartiallyInvalid",
] as const;

/** The i18n key of the plain-language explanation of a condition `reason`, if there is one. */
export function explainReason(reason: string | undefined): string | undefined {
  return reason && (EXPLAINED_REASONS as readonly string[]).includes(reason) ? `gateway:reasons.${reason}` : undefined;
}

// ---------- Problems ----------

/** Health of an object of the section's `kind`. ReferenceGrants have no status: always `ok`. */
export function healthOf(obj: KubeObject, kind: Pick<KindRef, "group" | "kind">): Health {
  if (isKind(kind, GATEWAY_CLASS)) return gatewayClassHealth(obj).health;
  if (isKind(kind, GATEWAY)) return gatewayHealth(obj).health;
  if (isRouteKind(kind)) return routeHealth(obj).health;
  if (isKind(kind, BACKEND_TLS_POLICY)) return policyHealth(obj).health;
  return "ok";
}

/**
 * What the "Only problems" filter keeps and the section counter counts: `problem` health only — something a
 * controller rejected. `pending` (not processed yet) is shown as such but is not a problem.
 */
export function isProblem(obj: KubeObject, kind: Pick<KindRef, "group" | "kind">): boolean {
  return healthOf(obj, kind) === "problem";
}

/** How many of `objects` (all of `kind`) are problems. */
export function problemCount(objects: Iterable<KubeObject>, kind: Pick<KindRef, "group" | "kind">): number {
  let n = 0;
  for (const obj of objects) if (isProblem(obj, kind)) n++;
  return n;
}

// ---------- Policies (BackendTLSPolicy and implementation policies with targetRefs) ----------

/** `spec.targetRefs` (or the older single `spec.targetRef`), in the policy's namespace. */
export function policyTargets(policy: KubeObject): (ObjRef & { sectionName?: string })[] {
  const ns = namespaceOf(policy);
  const single = get(policy, "spec", "targetRef");
  return [...arr(get(policy, "spec", "targetRefs")), ...(single ? [single] : [])].map((t) => ({
    group: str(get(t, "group")) ?? "",
    kind: str(get(t, "kind")) ?? "",
    name: str(get(t, "name")) ?? "",
    namespace: ns,
    sectionName: str(get(t, "sectionName")),
  }));
}

/** One ancestor (a Gateway, usually) of a policy and what its controller said. */
export interface AncestorStatus {
  ref: ObjRef & { sectionName?: string };
  controllerName?: string;
  conditions: Condition[];
  health: Health;
  problem?: Condition;
}

export function policyAncestors(policy: KubeObject): AncestorStatus[] {
  const ns = namespaceOf(policy);
  return arr(get(policy, "status", "ancestors")).map((a) => {
    const ref = get(a, "ancestorRef");
    const conditions = conditionsOf(get(a, "conditions"));
    return {
      ref: {
        group: str(get(ref, "group")) ?? GATEWAY_GROUP,
        kind: str(get(ref, "kind")) ?? "Gateway",
        name: str(get(ref, "name")) ?? "",
        namespace: str(get(ref, "namespace")) ?? ns,
        sectionName: str(get(ref, "sectionName")),
      },
      controllerName: str(get(a, "controllerName")),
      conditions,
      ...judge(conditions, [
        ["Accepted", "False"],
        ["Conflicted", "True"],
      ]),
    };
  });
}

/**
 * A policy is a problem when an ancestor rejected it; one no controller reported on is `ok` (not every
 * implementation writes policy status).
 */
export function policyHealth(policy: KubeObject): { health: Health; problem?: Condition } {
  const broken = policyAncestors(policy).find((a) => a.health === "problem");
  return broken ? { health: "problem", problem: broken.problem } : { health: "ok" };
}
