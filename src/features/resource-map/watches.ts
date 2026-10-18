// Watches the map and the "Related" tab share: one watch per (cluster, spec) however many views ask, opened by the
// first and closed `LINGER_MS` after the last lets go, so opening an object's details from the map (or switching
// between the tab and the map) reuses the namespace's lists instead of listing them again. Updates reach the views at
// most every `FLUSH_MS`: twenty kinds batching every 250 ms each would otherwise rebuild the graph many times per
// batch window. A cluster whose connection comes or goes loses its watches at once (the backend closes them without a
// word) and `epochOf` moves on, so the views acquire anew — the same rule as the problems store.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  api,
  applyWatchUpdate,
  openStream,
  toApiError,
  type ClusterId,
  type WatchSpec,
  type WatchState,
  type WatchUpdate,
} from "../../api";
import { reportWatchUpdate } from "../../api/watchObservers";
import { useClustersStore } from "../clusters/clustersStore";

export const LINGER_MS = 5000;
export const FLUSH_MS = 100;
let linger = LINGER_MS;

const LOADING: WatchState = Object.freeze({ items: new Map(), status: "loading" }) as WatchState;

interface Entry {
  clusterId: ClusterId;
  state: WatchState;
  refs: number;
  linger?: ReturnType<typeof setTimeout>;
  stop: () => void;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
let flush: ReturnType<typeof setTimeout> | undefined;
const epochs = new Map<ClusterId, number>();
const connected = new Map<ClusterId, boolean>();
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
  for (const [key, entry] of [...entries]) {
    if (entry.clusterId !== clusterId) continue;
    if (entry.linger) clearTimeout(entry.linger);
    entries.delete(key);
    entry.stop();
  }
  epochs.set(clusterId, epochOf(clusterId) + 1);
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
  return epochs.get(clusterId) ?? 0;
}

export function specKey(clusterId: ClusterId, spec: WatchSpec): string {
  return JSON.stringify([clusterId, spec.kind, spec.namespaces, spec.labelSelector, spec.fieldSelector, spec.metadataOnly ?? false]);
}

/** Starts (or shares) the watch; the returned function lets go of it. */
export function acquireWatch(clusterId: ClusterId, spec: WatchSpec): () => void {
  followConnections();
  const key = specKey(clusterId, spec);
  let entry = entries.get(key);
  if (!entry) {
    const created: Entry = { clusterId, state: LOADING, refs: 0, stop: () => undefined };
    entries.set(key, created);
    created.stop = openStream<WatchUpdate>({
      start: (id, channel) => api.resources.watchStart(clusterId, spec, id, channel),
      stop: api.resources.watchStop,
      onEvent: (update) => {
        if (entries.get(key) !== created) return;
        reportWatchUpdate(clusterId, spec, update);
        const next = applyWatchUpdate(created.state, update);
        if (next === created.state) return;
        created.state = next;
        notify();
      },
      onStartError: (err) => {
        if (entries.get(key) !== created) return;
        created.state = { items: new Map(), status: "error", error: toApiError(err) };
        notify();
      },
    });
    entry = created;
  }
  const held = entry;
  if (held.linger) {
    clearTimeout(held.linger);
    held.linger = undefined;
  }
  held.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs--;
    if (held.refs > 0) return;
    held.linger = setTimeout(() => {
      if (entries.get(key) !== held || held.refs > 0) return;
      entries.delete(key);
      held.stop();
    }, linger);
  };
}

export function watchState(clusterId: ClusterId, spec: WatchSpec): WatchState {
  return entries.get(specKey(clusterId, spec))?.state ?? LOADING;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How many watches are open (tests). */
export function openWatchCount(): number {
  return entries.size;
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
  for (const entry of entries.values()) {
    if (entry.linger) clearTimeout(entry.linger);
    entry.stop();
  }
  entries.clear();
  if (flush) clearTimeout(flush);
  flush = undefined;
  unfollow?.();
  unfollow = undefined;
  epochs.clear();
  connected.clear();
  version++;
}
