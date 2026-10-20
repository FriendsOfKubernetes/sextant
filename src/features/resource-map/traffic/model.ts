// Pure parts of the "Traffic" mode of the map (#211): which node an end of an edge is, the filters, how thick and
// which colour an edge is drawn, and the layout — the map's own columns-and-sweeps (`placeColumns` in ../layout.ts):
// callers in the first column, then each node one column right of its nearest caller. The edges come from the core
// (`metrics_traffic_graph`, ADR-0096), which builds every query itself; nothing here becomes a query.
import type { TrafficEdge, TrafficPeer, TrafficProtocol } from "../../../api";
import { placeColumns, type Placed } from "../layout";

/** Error share from which an edge is drawn as a warning, and as failing. */
export const WARN_ERROR_RATIO = 0.01;
export const BAD_ERROR_RATIO = 0.05;
/** Thinnest and thickest edge stroke, in pixels. */
export const MIN_STROKE = 1.5;
export const MAX_STROKE = 8;

export type ErrorLevel = "ok" | "warn" | "bad" | "unknown";
export const ERROR_LEVELS: readonly ErrorLevel[] = ["ok", "warn", "bad", "unknown"];

export type ProtocolFilter = "all" | "http" | "grpc" | "tcp";
export const PROTOCOL_FILTERS: readonly ProtocolFilter[] = ["all", "http", "grpc", "tcp"];
/** "errors": any failed request by the source's rule; the classes: edges with requests answered so. */
export type StatusFilter = "all" | "errors" | "5xx" | "4xx" | "2xx";
export const STATUS_FILTERS: readonly StatusFilter[] = ["all", "errors", "5xx", "4xx", "2xx"];

export interface TrafficFilters {
  /** Only edges with an end in this namespace; `null`: every namespace asked. */
  namespace: string | null;
  protocol: ProtocolFilter;
  status: StatusFilter;
}

export const NO_FILTERS: TrafficFilters = { namespace: null, protocol: "all", status: "all" };

/** The node an end is drawn as: one per workload or Service, one "unknown" per namespace (or one without). */
export function peerId(peer: TrafficPeer): string {
  return `${peer.kind}|${peer.namespace ?? ""}|${peer.name ?? ""}`;
}

export function edgeId(edge: TrafficEdge): string {
  return `${edge.source}|${edge.protocol}|${peerId(edge.from)}>${peerId(edge.to)}`;
}

const PROTOCOL_OF: Record<Exclude<ProtocolFilter, "all">, TrafficProtocol> = { http: "http", grpc: "grpc", tcp: "tcp" };

function classRate(edge: TrafficEdge, cls: string): number {
  return edge.statusClasses.find((c) => c.class === cls)?.rate ?? 0;
}

export function matchesFilters(edge: TrafficEdge, filters: TrafficFilters): boolean {
  if (filters.namespace !== null && edge.from.namespace !== filters.namespace && edge.to.namespace !== filters.namespace)
    return false;
  if (filters.protocol !== "all" && edge.protocol !== PROTOCOL_OF[filters.protocol]) return false;
  switch (filters.status) {
    case "all":
      return true;
    case "errors":
      return (edge.errorRatio ?? 0) > 0;
    default:
      return classRate(edge, filters.status) > 0;
  }
}

export function errorLevel(errorRatio: number | null): ErrorLevel {
  if (errorRatio === null) return "unknown";
  if (errorRatio >= BAD_ERROR_RATIO) return "bad";
  if (errorRatio >= WARN_ERROR_RATIO) return "warn";
  return "ok";
}

const LEVEL_RANK: Record<ErrorLevel, number> = { unknown: 0, ok: 1, warn: 2, bad: 3 };

export function worstLevel(levels: readonly ErrorLevel[]): ErrorLevel {
  return levels.reduce<ErrorLevel>((worst, l) => (LEVEL_RANK[l] > LEVEL_RANK[worst] ? l : worst), "unknown");
}

/** Stroke width by rate on a log scale against the busiest drawn link, so 0.1 and 1000 req/s both show. */
export function strokeWidth(rate: number, maxRate: number): number {
  if (maxRate <= 0 || rate <= 0) return MIN_STROKE;
  const share = Math.log1p(rate) / Math.log1p(maxRate);
  return MIN_STROKE + (MAX_STROKE - MIN_STROKE) * Math.min(1, share);
}

export interface TrafficNode extends Placed {
  peer: TrafficPeer;
  /** Requests per second into and out of the node over the drawn links (TCP connections not counted). */
  inRate: number;
  outRate: number;
}

/** The edges between two drawn nodes (several sources or protocols), drawn as one line. */
export interface TrafficLink {
  id: string;
  from: string;
  to: string;
  edges: TrafficEdge[];
  /** Requests per second (HTTP, gRPC, or a protocol the source does not tell): per source the sum of its edges, then
   * the busiest source's — two sources seeing the same calls (Istio and Hubble on Cilium) are not added up. The line
   * is as thick as this. */
  rate: number;
  /** New TCP connections per second, the same way; never added to `rate` (another unit). */
  tcpRate: number;
  level: ErrorLevel;
}

/** Per pair of ends: the busiest source's requests, and its connections, each family on its own. */
function linkRates(edges: readonly TrafficEdge[]): { rate: number; tcpRate: number } {
  const requests = new Map<string, number>();
  const connections = new Map<string, number>();
  for (const edge of edges) {
    const family = edge.protocol === "tcp" ? connections : requests;
    family.set(edge.source, (family.get(edge.source) ?? 0) + edge.rate);
  }
  return { rate: Math.max(0, ...requests.values()), tcpRate: Math.max(0, ...connections.values()) };
}

export interface TrafficLayout {
  nodes: TrafficNode[];
  links: TrafficLink[];
  width: number;
  height: number;
  maxRate: number;
}

const byPeer = (a: TrafficNode, b: TrafficNode) =>
  `${a.peer.namespace ?? "~"}|${a.peer.name ?? "~"}`.localeCompare(`${b.peer.namespace ?? "~"}|${b.peer.name ?? "~"}`, undefined, {
    numeric: true,
  });

/** Nodes and links of `edges`: a node's column is its distance from the nearest node nobody calls (a node in a
 * cycle nobody outside calls starts one), so calls run left to right. */
export function layoutTraffic(edges: readonly TrafficEdge[]): TrafficLayout {
  const nodes = new Map<string, TrafficNode>();
  const node = (peer: TrafficPeer) => {
    const id = peerId(peer);
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, peer, column: -1, x: 0, y: 0, inRate: 0, outRate: 0 }));
    return n;
  };
  const links = new Map<string, TrafficLink>();
  for (const edge of edges) {
    const from = node(edge.from);
    const to = node(edge.to);
    const id = `${from.id}>${to.id}`;
    const link =
      links.get(id) ??
      links.set(id, { id, from: from.id, to: to.id, edges: [], rate: 0, tcpRate: 0, level: "unknown" }).get(id)!;
    link.edges.push(edge);
  }
  for (const link of links.values()) {
    Object.assign(link, linkRates(link.edges));
    link.level = worstLevel(link.edges.map((e) => errorLevel(e.errorRatio)));
    nodes.get(link.from)!.outRate += link.rate;
    nodes.get(link.to)!.inRate += link.rate;
  }

  const callees = new Map<string, string[]>();
  const called = new Set<string>();
  for (const link of links.values()) {
    if (link.from === link.to) continue;
    (callees.get(link.from) ?? callees.set(link.from, []).get(link.from)!).push(link.to);
    called.add(link.to);
  }
  const ordered = [...nodes.values()].sort(byPeer);
  const visit = (roots: TrafficNode[]) => {
    const queue = roots.filter((r) => r.column < 0);
    for (const r of queue) r.column = 0;
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]!;
      for (const id of callees.get(current.id) ?? []) {
        const next = nodes.get(id)!;
        if (next.column >= 0) continue;
        next.column = current.column + 1;
        queue.push(next);
      }
    }
  };
  visit(ordered.filter((n) => !called.has(n.id)));
  for (const n of ordered) if (n.column < 0) visit([n]);

  const drawn = ordered.sort((a, b) => a.column - b.column || byPeer(a, b));
  const placed = placeColumns(drawn, [...links.values()]);
  const maxRate = Math.max(0, ...[...links.values()].map((l) => l.rate));
  return { nodes: placed.nodes, links: [...links.values()], width: placed.width, height: placed.height, maxRate };
}
