// The namespace map's layout: a plain layered drawing, no graph library (a force or Sugiyama package would add
// 100+ KB for a picture whose columns are known in advance). Kinds sit in fixed columns from the way in to what is
// used — routes and Ingresses → Services and policies → workloads → ReplicaSets and Jobs → pods → configuration and
// claims → cluster objects — and rows inside a column are ordered by the average row of their neighbours to the left
// (then to the right), which untangles most edges in two sweeps.
//
// Large groups collapse: the pods (or ReplicaSets, Jobs) of one owner become one node "42 pods" once there are more
// than `OWNER_GROUP_MIN`, and any kind with more than `KIND_GROUP_MIN` leftover nodes in a namespace becomes one node
// per kind. Expanding a group shows up to `EXPANDED_MAX` members; the rest stay grouped. At most `MAX_NODES` are
// drawn, so 2000 pods cost a group node, not 2000 boxes.
import { worstHealth, type MapHealth, nodeHealth } from "./health";
import type { Graph, GraphNode, Relation } from "./relations";

export const OWNER_GROUP_MIN = 5;
export const KIND_GROUP_MIN = 30;
export const EXPANDED_MAX = 100;
export const MAX_NODES = 400;

export const NODE_W = 200;
export const NODE_H = 44;
export const GAP_X = 72;
export const GAP_Y = 12;

/** Column of each kind (by `group/kind`); a kind not listed goes with the workloads. */
const COLUMNS: Record<string, number> = {
  "networking.k8s.io/Ingress": 0,
  "gateway.networking.k8s.io/Gateway": 0,
  "gateway.networking.k8s.io/HTTPRoute": 0,
  "gateway.networking.k8s.io/GRPCRoute": 0,
  "gateway.networking.k8s.io/TLSRoute": 0,
  "gateway.networking.k8s.io/TCPRoute": 0,
  "gateway.networking.k8s.io/UDPRoute": 0,
  "/Service": 1,
  "autoscaling/HorizontalPodAutoscaler": 1,
  "policy/PodDisruptionBudget": 1,
  "networking.k8s.io/NetworkPolicy": 1,
  "discovery.k8s.io/EndpointSlice": 1,
  "apps/Deployment": 2,
  "apps/StatefulSet": 2,
  "apps/DaemonSet": 2,
  "batch/CronJob": 2,
  "apps/ReplicaSet": 3,
  "batch/Job": 3,
  "/Pod": 4,
  "/ConfigMap": 5,
  "/Secret": 5,
  "/ServiceAccount": 5,
  "/PersistentVolumeClaim": 5,
  "/PersistentVolume": 6,
  "storage.k8s.io/StorageClass": 6,
  "/Node": 6,
  "networking.k8s.io/IngressClass": 6,
  "gateway.networking.k8s.io/GatewayClass": 6,
};
const DEFAULT_COLUMN = 2;

/** Kinds left off the map until the filter asks for them: cluster objects, and slices that repeat Service → pods. */
export const HIDDEN_BY_DEFAULT: readonly string[] = [
  "/Node",
  "/PersistentVolume",
  "storage.k8s.io/StorageClass",
  "networking.k8s.io/IngressClass",
  "gateway.networking.k8s.io/GatewayClass",
  "discovery.k8s.io/EndpointSlice",
];

export const kindId = (ref: { group: string; kind: string }) => `${ref.group}/${ref.kind}`;

export interface MapNode {
  id: string;
  /** `group/kind`. */
  kindId: string;
  kind: string;
  namespace: string | null;
  /** The object's name; empty for a group. */
  name: string;
  /** The object; absent for a group. */
  node?: GraphNode;
  /** A group: the keys of its members (all of them, also those not drawn). */
  members: string[];
  /** A group that can be expanded (or collapsed again). */
  groupId?: string;
  /** Whether the group is expanded (this is its "N more" remainder). */
  remainder?: boolean;
  health: MapHealth;
  /** Members (or the object itself) by health. */
  healthCounts: Partial<Record<MapHealth, number>>;
  column: number;
  x: number;
  y: number;
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  relation: Relation;
  /** Edges between the same two drawn nodes with this relation. */
  count: number;
}

export interface MapLayout {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
  /** Nodes left out over `MAX_NODES`. */
  truncated: number;
  /** Every kind of the graph with its object count, for the filter. */
  kinds: { id: string; kind: string; count: number }[];
}

export interface MapOptions {
  /** `group/kind` of the kinds not drawn. */
  hidden: ReadonlySet<string>;
  /** Group ids the user expanded. */
  expanded: ReadonlySet<string>;
  now: number;
}

const columnOf = (id: string) => COLUMNS[id] ?? DEFAULT_COLUMN;

function controllerOwner(graph: Graph, key: string): string | undefined {
  return (graph.out.get(key) ?? []).find((e) => e.relation === "owner")?.to;
}

export function layoutMap(graph: Graph, options: MapOptions): MapLayout {
  const kindCounts = new Map<string, { id: string; kind: string; count: number }>();
  const visible: GraphNode[] = [];
  for (const node of graph.nodes.values()) {
    const id = kindId(node.ref);
    const entry = kindCounts.get(id) ?? kindCounts.set(id, { id, kind: node.ref.kind, count: 0 }).get(id)!;
    entry.count++;
    if (!options.hidden.has(id)) visible.push(node);
  }

  // Groups: by owner first, then the leftovers of a kind in a namespace.
  const health = new Map<string, MapHealth>();
  for (const node of visible) health.set(node.key, nodeHealth(node, options.now));
  const byOwner = new Map<string, GraphNode[]>();
  for (const node of visible) {
    const owner = controllerOwner(graph, node.key);
    if (!owner) continue;
    const id = `owner|${kindId(node.ref)}|${owner}`;
    (byOwner.get(id) ?? byOwner.set(id, []).get(id)!).push(node);
  }
  const groupOf = new Map<string, string>();
  for (const [id, members] of byOwner) {
    if (members.length > OWNER_GROUP_MIN) for (const m of members) groupOf.set(m.key, id);
  }
  const byKind = new Map<string, GraphNode[]>();
  for (const node of visible) {
    if (groupOf.has(node.key)) continue;
    const id = `kind|${kindId(node.ref)}|${node.ref.namespace ?? ""}`;
    (byKind.get(id) ?? byKind.set(id, []).get(id)!).push(node);
  }
  for (const [id, members] of byKind) {
    if (members.length > KIND_GROUP_MIN) for (const m of members) groupOf.set(m.key, id);
  }

  const groups = new Map<string, GraphNode[]>();
  for (const node of visible) {
    const g = groupOf.get(node.key);
    if (g) (groups.get(g) ?? groups.set(g, []).get(g)!).push(node);
  }

  // Drawn nodes, and where each graph node is drawn.
  const drawn: MapNode[] = [];
  const drawnAs = new Map<string, string>();
  const objectNode = (node: GraphNode): MapNode => {
    const h = health.get(node.key)!;
    return {
      id: `n:${node.key}`,
      kindId: kindId(node.ref),
      kind: node.ref.kind,
      namespace: node.ref.namespace,
      name: node.ref.name,
      node,
      members: [node.key],
      health: h,
      healthCounts: { [h]: 1 },
      column: columnOf(kindId(node.ref)),
      x: 0,
      y: 0,
    };
  };
  const groupNode = (groupId: string, members: GraphNode[], remainder: boolean): MapNode => {
    const counts: Partial<Record<MapHealth, number>> = {};
    for (const m of members) {
      const h = health.get(m.key)!;
      counts[h] = (counts[h] ?? 0) + 1;
    }
    const first = members[0]!;
    return {
      id: `g:${groupId}${remainder ? "|rest" : ""}`,
      kindId: kindId(first.ref),
      kind: first.ref.kind,
      namespace: first.ref.namespace,
      name: "",
      members: members.map((m) => m.key),
      groupId,
      remainder,
      health: worstHealth(members.map((m) => health.get(m.key)!)),
      healthCounts: counts,
      column: columnOf(kindId(first.ref)),
      x: 0,
      y: 0,
    };
  };
  const byName = (a: GraphNode, b: GraphNode) => a.ref.name.localeCompare(b.ref.name, undefined, { numeric: true });
  for (const node of visible) {
    if (groupOf.has(node.key)) continue;
    const m = objectNode(node);
    drawn.push(m);
    drawnAs.set(node.key, m.id);
  }
  for (const [groupId, members] of groups) {
    members.sort(byName);
    if (options.expanded.has(groupId)) {
      const shown = members.slice(0, EXPANDED_MAX);
      for (const node of shown) {
        const m = objectNode(node);
        m.groupId = groupId;
        drawn.push(m);
        drawnAs.set(node.key, m.id);
      }
      const rest = members.slice(EXPANDED_MAX);
      if (rest.length > 0) {
        const g = groupNode(groupId, rest, true);
        drawn.push(g);
        for (const node of rest) drawnAs.set(node.key, g.id);
      }
    } else {
      const g = groupNode(groupId, members, false);
      drawn.push(g);
      for (const node of members) drawnAs.set(node.key, g.id);
    }
  }

  // Edges between drawn nodes, merged.
  const edgeMap = new Map<string, MapEdge>();
  for (const [from, list] of graph.out) {
    const a = drawnAs.get(from);
    if (!a) continue;
    for (const edge of list) {
      const b = drawnAs.get(edge.to);
      if (!b || a === b) continue;
      const id = `${a}|${b}|${edge.relation}`;
      const existing = edgeMap.get(id);
      if (existing) existing.count++;
      else edgeMap.set(id, { id, from: a, to: b, relation: edge.relation, count: 1 });
    }
  }

  // Columns that have nodes, in order; rows by kind and name first.
  const order = (n: MapNode) => `${n.kindId}\u0000${n.namespace ?? ""}\u0000${n.groupId && !n.node ? "" : n.name}`;
  drawn.sort((a, b) => a.column - b.column || order(a).localeCompare(order(b), undefined, { numeric: true }));
  let truncated = 0;
  if (drawn.length > MAX_NODES) {
    truncated = drawn.length - MAX_NODES;
    drawn.length = MAX_NODES;
  }
  const kept = new Set(drawn.map((n) => n.id));
  const edges = [...edgeMap.values()].filter((e) => kept.has(e.from) && kept.has(e.to));

  const { nodes, width, height } = placeColumns(drawn, edges);
  const kinds = [...kindCounts.values()].sort((a, b) => columnOf(a.id) - columnOf(b.id) || a.kind.localeCompare(b.kind));
  return { nodes, edges, width, height, truncated, kinds };
}

/** A node `placeColumns` places: its column, and where it ends up. */
export interface Placed {
  id: string;
  column: number;
  x: number;
  y: number;
}

/**
 * Places nodes in their columns (only the columns that have nodes, in order) and orders each column by the average
 * row of its neighbours to the left, then to the right, which untangles most edges in two sweeps. Nodes come in the
 * order they should keep when nothing else decides; shared by the namespace map and the traffic graph.
 */
export function placeColumns<T extends Placed>(
  drawn: T[],
  edges: readonly { from: string; to: string }[],
): { nodes: T[]; width: number; height: number } {
  const columns = [...new Set(drawn.map((n) => n.column))].sort((a, b) => a - b);
  const lanes = columns.map((c) => drawn.filter((n) => n.column === c));
  const neighboursOf = new Map<string, string[]>();
  for (const e of edges) {
    (neighboursOf.get(e.from) ?? neighboursOf.set(e.from, []).get(e.from)!).push(e.to);
    (neighboursOf.get(e.to) ?? neighboursOf.set(e.to, []).get(e.to)!).push(e.from);
  }
  const row = new Map<string, number>();
  const place = (lane: T[]) => lane.forEach((n, i) => row.set(n.id, i));
  lanes.forEach(place);
  const sweep = (lane: T[], laneIndex: number, towards: "left" | "right") => {
    const side = new Set(
      (towards === "left" ? lanes.slice(0, laneIndex) : lanes.slice(laneIndex + 1)).flatMap((l) => l.map((n) => n.id)),
    );
    const weight = new Map<string, number>();
    lane.forEach((n, i) => {
      const rows = (neighboursOf.get(n.id) ?? []).filter((id) => side.has(id)).map((id) => row.get(id)!);
      weight.set(n.id, rows.length > 0 ? rows.reduce((s, r) => s + r, 0) / rows.length : i);
    });
    lane.sort((a, b) => weight.get(a.id)! - weight.get(b.id)!);
    place(lane);
  };
  for (let i = 1; i < lanes.length; i++) sweep(lanes[i]!, i, "left");
  for (let i = lanes.length - 2; i >= 0; i--) sweep(lanes[i]!, i, "right");

  let height = 0;
  lanes.forEach((lane, c) => {
    lane.forEach((n, r) => {
      n.x = c * (NODE_W + GAP_X);
      n.y = r * (NODE_H + GAP_Y);
    });
    height = Math.max(height, lane.length * (NODE_H + GAP_Y) - GAP_Y);
  });
  const width = lanes.length > 0 ? lanes.length * (NODE_W + GAP_X) - GAP_X : 0;
  return { nodes: lanes.flat(), width, height: Math.max(height, 0) };
}

/** A curve from the side of `a` facing `b` to the side of `b` facing `a` (both right sides within one column). */
export function edgePath(a: Pick<MapNode, "x" | "y">, b: Pick<MapNode, "x" | "y">): string {
  const ay = a.y + NODE_H / 2;
  const by = b.y + NODE_H / 2;
  if (a.x === b.x) {
    const x = a.x + NODE_W;
    const bulge = Math.min(GAP_X - 8, 24 + Math.abs(by - ay) / 8);
    return `M ${x} ${ay} C ${x + bulge} ${ay}, ${x + bulge} ${by}, ${x} ${by}`;
  }
  const forward = b.x > a.x;
  const sx = forward ? a.x + NODE_W : a.x;
  const tx = forward ? b.x : b.x + NODE_W;
  const dx = Math.max(24, Math.abs(tx - sx) / 2);
  const c1 = forward ? sx + dx : sx - dx;
  const c2 = forward ? tx - dx : tx + dx;
  return `M ${sx} ${ay} C ${c1} ${ay}, ${c2} ${by}, ${tx} ${by}`;
}
