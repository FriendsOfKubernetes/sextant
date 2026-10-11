// React hooks over the clusters store (interfaces.md: `useClusters()`, `useClusterState(clusterId)`).
import { useEffect } from "react";
import type { ApiError, ClusterId, ClusterInfo, ConnectionState, KubeconfigSource } from "../../api";
import { initClusters, refreshClusters, useClustersStore } from "./clustersStore";

export interface UseClusters {
  clusters: ClusterInfo[];
  sources: KubeconfigSource[];
  loaded: boolean;
  loading: boolean;
  error: ApiError | null;
  refresh: () => Promise<void>;
}

/** Clusters from the kubeconfig (loaded on first use) and "Refresh". */
export function useClusters(): UseClusters {
  const clusters = useClustersStore((s) => s.clusters);
  const sources = useClustersStore((s) => s.sources);
  const loaded = useClustersStore((s) => s.loaded);
  const loading = useClustersStore((s) => s.loading);
  const error = useClustersStore((s) => s.listError);
  useEffect(() => {
    void initClusters();
  }, []);
  return { clusters, sources, loaded, loading, error, refresh: refreshClusters };
}

const DISCONNECTED: ConnectionState = { state: "disconnected" };

/** Connection state of a cluster, following `cluster-state` events. */
export function useClusterState(clusterId: ClusterId | null): ConnectionState {
  return useClustersStore((s) => (clusterId ? (s.states[clusterId] ?? DISCONNECTED) : DISCONNECTED));
}
