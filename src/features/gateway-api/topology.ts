// The topology of one Gateway as a tree: Gateway → listeners → the routes attached to each listener → their rules →
// backends (Services with pod readiness), each node with a health and, when broken, the reason. The Gateway's health
// is its own and its listeners' (a broken listener makes it a problem). Routes that name the Gateway but are not
// accepted there (refused, or not processed yet) are gathered in one "Not attached" group under the Gateway, each with
// the reason, whatever listener they name. Pure: the view lists the routes, Services, EndpointSlices and
// ReferenceGrants and passes what it knows.
import type { KindRef, KubeObject } from "../../api";
import { gatewayRoutes } from "./exposure";
import {
  backendIssue,
  gatewayHealth,
  gatewayOwnHealth,
  GATEWAY_GROUP,
  GRPC_ROUTE,
  HTTP_ROUTE,
  isKind,
  listenerStatuses,
  parentStatuses,
  routeRules,
  type BackendContext,
  type BackendRef,
  type Health,
  type ListenerStatus,
  type ObjRef,
  type ParentStatus,
  type RouteRule,
} from "./model";

interface NodeBase {
  /** Unique in the tree (the path from the root). */
  key: string;
  health: Health;
  /** Why the node is not ok: a condition reason, a backend issue, `NoBackends`, `NoEndpoints`, `PodsNotReady`. */
  reason?: string;
  /** The controller's message for `reason`, if it gave one. */
  message?: string;
  /** Parameters of Sextant's own reason text (`gateway:topology.reasons.<reason>`). */
  params?: Record<string, string | number>;
  children: TopologyNode[];
}

export type TopologyNode =
  | (NodeBase & { type: "gateway"; ref: ObjRef })
  | (NodeBase & { type: "listener"; listener: ListenerStatus })
  /** The routes naming the Gateway that it did not accept. */
  | (NodeBase & { type: "notAttached" })
  | (NodeBase & { type: "route"; ref: ObjRef; routeKind: KindRef; parent: ParentStatus; hostnames?: string[] })
  | (NodeBase & { type: "rule"; rule: RouteRule; routeNamespace: string | null; routeKind: KindRef })
  | (NodeBase & {
      type: "backend";
      backend: BackendRef;
      /** Gets copies of requests (a RequestMirror filter), no share of the traffic. */
      mirror: boolean;
      /** Shown with its share when the rule splits traffic. */
      split: boolean;
      routeNamespace: string | null;
      readiness?: { ready: number; total: number };
    });

export interface TopologyContext {
  /** The routes of each served kind, in all namespaces. */
  routes: readonly { kind: KindRef; items: readonly KubeObject[] }[];
  servicesIn?: BackendContext["servicesIn"];
  grantsIn?: BackendContext["grantsIn"];
  /** Ready endpoints of a Service backend; `undefined` while unknown. */
  readiness?: (b: BackendRef) => { ready: number; total: number } | undefined;
}

const isService = (b: BackendRef) => b.group === "" && b.kind === "Service";

function backendNode(
  key: string,
  backend: BackendRef,
  mirror: boolean,
  split: boolean,
  routeNamespace: string | null,
  issue: string | undefined,
  readiness: TopologyContext["readiness"],
): TopologyNode {
  const base = { type: "backend" as const, key, backend, mirror, split, routeNamespace, children: [] };
  if (issue) return { ...base, health: "problem", reason: issue };
  if (!isService(backend)) return { ...base, health: "ok" };
  const state = readiness?.(backend);
  if (!state) return { ...base, health: "pending" };
  if (state.total === 0) return { ...base, readiness: state, health: "problem", reason: "NoEndpoints" };
  if (state.ready === 0) return { ...base, readiness: state, health: "problem", reason: "PodsNotReady" };
  return { ...base, readiness: state, health: state.ready === state.total ? "ok" : "pending" };
}

function ruleNode(
  key: string,
  rule: RouteRule,
  route: KubeObject,
  kind: KindRef,
  parents: ParentStatus[],
  context: TopologyContext,
): TopologyNode {
  const ns = route.metadata?.namespace ?? null;
  const backendContext: BackendContext = {
    routeNamespace: ns,
    routeKind: kind.kind,
    parents,
    servicesIn: context.servicesIn,
    grantsIn: context.grantsIn,
  };
  const split = rule.backends.length > 1;
  const children = [
    ...rule.backends.map((b, i) =>
      backendNode(`${key}/b${i}`, b, false, split, ns, backendIssue(b, backendContext), context.readiness),
    ),
    ...rule.mirrors.map((b, i) =>
      backendNode(`${key}/m${i}`, b, true, false, ns, backendIssue(b, backendContext), context.readiness),
    ),
  ];
  const broken = children.find((c) => c.health === "problem");
  const matched = isKind(kind, HTTP_ROUTE, GRPC_ROUTE);
  const base = { type: "rule" as const, key, rule, routeNamespace: ns, routeKind: kind, children };
  // A rule with no backends that does not answer itself (a redirect) gets an error response.
  if (matched && rule.backends.length === 0 && !rule.filterTypes.includes("RequestRedirect"))
    return { ...base, health: "problem", reason: "NoBackends" };
  if (broken) return { ...base, health: "problem", reason: broken.reason };
  return { ...base, health: children.some((c) => c.health === "pending") ? "pending" : "ok" };
}

function routeNode(
  key: string,
  route: KubeObject,
  kind: KindRef,
  parent: ParentStatus,
  hostnames: string[] | undefined,
  context: TopologyContext,
  withRules = true,
): TopologyNode {
  const ref: ObjRef = { group: GATEWAY_GROUP, kind: kind.kind, name: route.metadata?.name ?? "", namespace: route.metadata?.namespace ?? null };
  const parents = parentStatuses(route);
  const children = withRules
    ? routeRules(route, kind).map((rule) => ruleNode(`${key}/r${rule.index}`, rule, route, kind, parents, context))
    : [];
  return {
    type: "route",
    key,
    ref,
    routeKind: kind,
    parent,
    hostnames,
    health: parent.health,
    reason: parent.health === "ok" ? undefined : parent.problem?.reason,
    message: parent.health === "ok" ? undefined : parent.problem?.message,
    children,
  };
}

const routeKey = (kind: KindRef, route: KubeObject) =>
  `${kind.kind}:${route.metadata?.namespace ?? ""}:${route.metadata?.name ?? ""}`;

/** Why the Gateway is not ok: its own condition, else how many of its listeners are broken (or still pending). */
function gatewayVerdict(gateway: KubeObject, listeners: readonly ListenerStatus[]): Omit<NodeBase, "key" | "children"> {
  const own = gatewayOwnHealth(gateway);
  const { health, problem } = gatewayHealth(gateway);
  if (health === "ok") return { health };
  if (own.health === health) return { health, reason: own.problem?.reason, message: own.problem?.message };
  const bad = listeners.filter((l) => l.health === health);
  const message = bad.map((l) => `${l.name}: ${l.problem?.reason ?? l.problem?.type ?? ""}`).join("\n");
  if (health === "problem")
    return { health, reason: "ListenersBroken", params: { count: bad.length, total: listeners.length }, message };
  return { health, reason: problem?.reason, message };
}

/**
 * The tree of `gateway`: its listeners (every one, with or without routes) with the routes attached to each, their
 * rules and backends; then the routes it did not accept, in a "Not attached" group (no rules: no traffic reaches
 * them through this Gateway).
 */
export function gatewayTopology(gateway: KubeObject, context: TopologyContext): TopologyNode {
  const ns = gateway.metadata?.namespace ?? null;
  const name = gateway.metadata?.name ?? "";
  const root = `gw:${ns ?? ""}:${name}`;
  const { attached, notAttached } = gatewayRoutes(gateway, context.routes);
  const onListener = new Map<string, TopologyNode[]>();
  for (const { kind, route, parent, listener, hostnames } of attached) {
    const key = `${root}/l:${listener.name}/${routeKey(kind, route)}`;
    const list = onListener.get(listener.name) ?? [];
    list.push(routeNode(key, route, kind, parent, hostnames, context));
    onListener.set(listener.name, list);
  }
  const all = listenerStatuses(gateway);
  const listeners: TopologyNode[] = all.map((listener) => ({
    type: "listener",
    key: `${root}/l:${listener.name}`,
    listener,
    health: listener.health,
    reason: listener.health === "ok" ? undefined : listener.problem?.reason,
    message: listener.health === "ok" ? undefined : listener.problem?.message,
    children: onListener.get(listener.name) ?? [],
  }));
  const refused = notAttached.map(({ kind, route, parent }, i) =>
    routeNode(`${root}/na${i}:${routeKey(kind, route)}`, route, kind, parent, undefined, context, false),
  );
  const group: TopologyNode[] =
    refused.length > 0
      ? [
          {
            type: "notAttached",
            key: `${root}/notAttached`,
            health: refused.some((r) => r.health === "problem") ? "problem" : "pending",
            children: refused,
          },
        ]
      : [];
  return {
    type: "gateway",
    key: root,
    ref: { group: GATEWAY_GROUP, kind: "Gateway", name, namespace: ns },
    ...gatewayVerdict(gateway, all),
    children: [...listeners, ...group],
  };
}

/**
 * Only the paths to broken nodes: a node stays when it is a problem or something below it is; below a kept node only
 * such nodes stay. `null` when nothing in the tree is broken.
 */
export function onlyProblems(node: TopologyNode): TopologyNode | null {
  const children = node.children.map(onlyProblems).filter((c): c is TopologyNode => c !== null);
  if (node.health !== "problem" && children.length === 0) return null;
  return { ...node, children };
}

/** The nodes in display order with their depth (the root is level 1). */
export function flattenTopology(node: TopologyNode, level = 1, rows: { node: TopologyNode; level: number }[] = []) {
  rows.push({ node, level });
  for (const child of node.children) flattenTopology(child, level + 1, rows);
  return rows;
}
