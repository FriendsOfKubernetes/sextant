// Watches the map and the "Related" tab share: one watch per (cluster, spec) however many views ask, opened by the
// first and closed `LINGER_MS` after the last lets go, so opening an object's details from the map (or switching
// between the tab and the map) reuses the namespace's lists instead of listing them again. Updates reach the views at
// most every `FLUSH_MS`: twenty kinds batching every 250 ms each would otherwise rebuild the graph many times per
// batch window. A cluster whose connection comes or goes loses its watches at once (the backend closes them without a
// word) and `epochOf` moves on, so the views acquire anew — the same rule as the problems store.
// The watches themselves live in the app-wide registry (`src/api/watchRegistry.ts`, #157), so a table and the map
// asking for the same list share one stream; this module adds the linger, the flushed notifications of its own
// watches and the following of connections.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  acquireWatch as acquireShared,
  dropClusterWatches,
  resetWatchRegistry,
  subscribeWatchKey,
  watchEpochOf,
  watchHolders,
  watchKey,
  watchStateOf,
  type ClusterId,
  type WatchSpec,
  type WatchState,
} from "../../api";
import { useClustersStore } from "../clusters/clustersStore";

export const LINGER_MS = 5000;
export const FLUSH_MS = 100;
let linger = LINGER_MS;

const listeners = new Set<() => void>();
let version = 0;
let flush: ReturnType<typeof setTimeout> | undefined;
const connected = new Map<ClusterId, boolean>();
/** Keys of the watches this module asked for, with how many of its holders hold each now. */
const mine = new Map<string, number>();
let unfollow: (() => void) | undefined;

function notify(now = false): void {
  if (now) {
    if (flush) clearTimeout(flush);
    flush = undefined;
    version++;
    for (const fn of [...listeners]) fn();
    return;
  }
  flush ??= setTimeout(() => notify(true), FLUSH_MS);
}

function dropCluster(clusterId: ClusterId): void {
  dropClusterWatches(clusterId);
  notify(true);
}

function followConnections(): void {
  if (unfollow) return;
  const look = (states: ReturnType<typeof useClustersStore.getState>["states"]) => {
    for (const id of new Set([...Object.keys(states), ...connected.keys()])) {
      const now = states[id]?.state === "connected";
      const was = connected.get(id);
      connected.set(id, now);
      if (was !== undefined && was !== now) dropCluster(id);
    }
  };
  look(useClustersStore.getState().states);
  unfollow = useClustersStore.subscribe((s, prev) => {
    if (s.states !== prev.states) look(s.states);
  });
}

export function epochOf(clusterId: ClusterId): number {
  return watchEpochOf(clusterId);
}

export function specKey(clusterId: ClusterId, spec: WatchSpec): string {
  return JSON.stringify([clusterId, spec.kind, spec.namespaces, spec.labelSelector, spec.fieldSelector, spec.metadataOnly ?? false]);
}

/**
 * Starts (or shares) the watch; the returned function lets go of it. `maxObjects` caps what the watch keeps (the
 * holder reads `total` to tell it is truncated); a holder without a cap lifts it for everyone.
 */
export function acquireWatch(clusterId: ClusterId, spec: WatchSpec, maxObjects?: number): () => void {
  followConnections();
  // The views hear of changes of their own watches only (flushed), not of every table's.
  const key = watchKey(clusterId, spec);
  mine.set(key, (mine.get(key) ?? 0) + 1);
  const unsubscribe = subscribeWatchKey(key, () => notify());
  const release = acquireShared(clusterId, spec, maxObjects === undefined ? { linger } : { linger, watch: { progressive: false, maxObjects } });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.set(key, (mine.get(key) ?? 1) - 1);
    unsubscribe();
    release();
  };
}

export function watchState(clusterId: ClusterId, spec: WatchSpec): WatchState {
  return watchStateOf(clusterId, spec);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Calls `listener` after the states of the shared watches change (flushed as for the views) or a cluster's watches
 * are dropped: for a store outside React (the service mesh analysis, #155). Returns the unsubscribe function.
 */
export function subscribeSharedWatches(listener: () => void): () => void {
  return subscribe(listener);
}

/** How many of the watches this module asked for are open: held by its views, or lingering after them (tests). */
export function openWatchCount(): number {
  let open = 0;
  for (const [key, refs] of [...mine]) {
    const holders = watchHolders(key);
    if (holders === null) mine.delete(key);
    else if (refs > 0 || holders === 0) open++;
  }
  return open;
}

/**
 * The states of `specs` (same order), kept open while the caller is mounted. A spec list equal by value keeps the
 * watches; when it changes, the specs still asked for are taken again within their linger, so they are not relisted.
 */
export function useSharedWatches(clusterId: ClusterId, specs: readonly WatchSpec[]): WatchState[] {
  const current = useSyncExternalStore(subscribe, () => version);
  const epoch = useSyncExternalStore(subscribe, () => epochOf(clusterId));
  const key = JSON.stringify([clusterId, specs.map((s) => specKey(clusterId, s))]);
  useEffect(() => {
    // `key` holds the cluster and the specs by value, so this render's `specs` are the ones it names; `epoch`
    // acquires anew after a reconnect.
    const releases = specs.map((spec) => acquireWatch(clusterId, spec));
    return () => releases.forEach((release) => release());
  }, [key, epoch]);
  return useMemo(() => specs.map((spec) => watchState(clusterId, spec)), [key, current, epoch]);
}

/** How long a released watch stays open (tests shorten it); `null` restores the default. */
export function setWatchLinger(ms: number | null): void {
  linger = ms ?? LINGER_MS;
}

/** Closes every watch and forgets them (tests). */
export function resetSharedWatches(): void {
  resetWatchRegistry();
  mine.clear();
  if (flush) clearTimeout(flush);
  flush = undefined;
  unfollow?.();
  unfollow = undefined;
  connected.clear();
  version++;
}
