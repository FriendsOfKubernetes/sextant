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
/** Bumped by every refresh: an answer to an older request is dropped. */
const generations = new Map<ClusterId, number>();
const listeners = new Set<() => void>();

function set(clusterId: ClusterId, value: ClusterKinds): void {
  cache.set(clusterId, value);
  for (const fn of listeners) fn();
}

/** Loads (once) the kinds the cluster serves. `refreshClusterKinds` reloads them (the clusters store calls it on
 * every connect). */
export function loadClusterKinds(clusterId: ClusterId): void {
  if (inflight.has(clusterId) || cache.get(clusterId)?.kinds) return;
  inflight.add(clusterId);
  const generation = generations.get(clusterId) ?? 0;
  const current = () => (generations.get(clusterId) ?? 0) === generation;
  api.clusters.kinds(clusterId).then(
    (kinds) => {
      if (!current()) return;
      inflight.delete(clusterId);
      set(clusterId, { kinds, error: null });
    },
    (err: unknown) => {
      if (!current()) return;
      inflight.delete(clusterId);
      set(clusterId, { kinds: null, error: toApiError(err) });
    },
  );
}

/**
 * Forgets what is known about the cluster's kinds (a new connection may serve other kinds, e.g. a CRD created
 * since) and loads them again when anything was loaded or loading; otherwise the first user loads them.
 */
export function refreshClusterKinds(clusterId: ClusterId): void {
  if (!cache.has(clusterId) && !inflight.has(clusterId)) return;
  generations.set(clusterId, (generations.get(clusterId) ?? 0) + 1);
  inflight.delete(clusterId);
  cache.delete(clusterId);
  loadClusterKinds(clusterId);
}

/** Forgets every cluster (tests). */
export function resetClusterKinds(): void {
  cache.clear();
  inflight.clear();
  generations.clear();
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
