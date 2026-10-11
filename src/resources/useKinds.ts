// Discovery of a cluster (`api.clusters.kinds`), fetched once per cluster and shared by every caller.
import { useEffect, useSyncExternalStore } from "react";
import { api, toApiError, type ApiError, type ClusterId, type KindRef, type ResourceKind } from "../api";

export interface ClusterKinds {
  kinds: ResourceKind[] | null;
  error: ApiError | null;
}

const EMPTY: ClusterKinds = Object.freeze({ kinds: null, error: null }) as ClusterKinds;
const cache = new Map<ClusterId, ClusterKinds>();
const inflight = new Set<ClusterId>();
const listeners = new Set<() => void>();

function set(clusterId: ClusterId, value: ClusterKinds): void {
  cache.set(clusterId, value);
  for (const fn of listeners) fn();
}

/** Loads (once) the kinds the cluster serves. Call `refreshClusterKinds` after a reconnect to reload. */
export function loadClusterKinds(clusterId: ClusterId): void {
  if (inflight.has(clusterId) || cache.get(clusterId)?.kinds) return;
  inflight.add(clusterId);
  api.clusters.kinds(clusterId).then(
    (kinds) => {
      inflight.delete(clusterId);
      set(clusterId, { kinds, error: null });
    },
    (err: unknown) => {
      inflight.delete(clusterId);
      set(clusterId, { kinds: null, error: toApiError(err) });
    },
  );
}

export function refreshClusterKinds(clusterId: ClusterId): void {
  cache.delete(clusterId);
  loadClusterKinds(clusterId);
}

/** Forgets every cluster (tests). */
export function resetClusterKinds(): void {
  cache.clear();
  inflight.clear();
  for (const fn of listeners) fn();
}

export function useClusterKinds(clusterId: ClusterId | null): ClusterKinds {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => (clusterId ? (cache.get(clusterId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (clusterId) loadClusterKinds(clusterId);
  }, [clusterId]);
  return value;
}

/** The discovered kind for `group`/`kind` (preferred version), if the cluster serves it. */
export function findKind(kinds: ResourceKind[] | null, ref: Pick<KindRef, "group" | "kind">): ResourceKind | undefined {
  return kinds?.find((k) => k.kindRef.group === ref.group && k.kindRef.kind === ref.kind);
}
