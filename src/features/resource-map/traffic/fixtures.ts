// Traffic graphs for the tests: shaped like the core's answers to the per-source fixtures
// (crates/sextant-core/src/metrics/traffic/testdata/).
import type { TrafficEdge, TrafficGraph, TrafficPeer } from "../../../api";

export const NOW_S = 1_760_000_000;

export const workload = (namespace: string, name: string): TrafficPeer => ({ kind: "workload", namespace, name });
export const service = (namespace: string | null, name: string): TrafficPeer => ({ kind: "service", namespace, name });
export const unknown = (namespace: string | null = null): TrafficPeer => ({ kind: "unknown", namespace, name: null });

export function edge(from: TrafficPeer, to: TrafficPeer, patch: Partial<TrafficEdge> = {}): TrafficEdge {
  return {
    source: "istio",
    via: "cluster",
    from,
    to,
    protocol: "http",
    rate: 1,
    errorRatio: 0,
    p50Ms: 10,
    p95Ms: 50,
    statusClasses: [{ class: "2xx", rate: 1 }],
    ...patch,
  };
}

/** frontend → web (10 % errors), web → db over gRPC, web → redis over TCP, an unknown caller → web, web → a host. */
export const SHOP_EDGES: TrafficEdge[] = [
  edge(workload("shop", "frontend"), workload("shop", "web"), {
    rate: 12,
    errorRatio: 0.1,
    statusClasses: [
      { class: "2xx", rate: 10.8 },
      { class: "5xx", rate: 1.2 },
    ],
  }),
  edge(workload("shop", "web"), workload("pay", "db"), { protocol: "grpc", rate: 4, errorRatio: 0.02 }),
  edge(unknown(), workload("shop", "web"), { rate: 2, statusClasses: [{ class: "4xx", rate: 2 }] }),
  edge(workload("shop", "web"), service(null, "api.example.com"), { rate: 0.5 }),
  edge(workload("shop", "web"), workload("cache", "redis"), {
    protocol: "tcp",
    rate: 0.25,
    errorRatio: null,
    p50Ms: null,
    p95Ms: null,
    statusClasses: [],
  }),
];

export function graph(patch: Partial<TrafficGraph> = {}): TrafficGraph {
  return {
    evaluatedAt: NOW_S,
    window: "minutes5",
    namespaces: ["shop", "pay"],
    prometheus: true,
    sources: [{ kind: "istio", via: "cluster", latency: true }],
    requestOnly: [],
    failed: [],
    edges: SHOP_EDGES,
    totalEdges: SHOP_EDGES.length,
    ...patch,
  };
}
