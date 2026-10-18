// One watch per (cluster, spec) for every RBAC view that asks for it at the same time: the Permissions page and a
// details section (a ServiceAccount's, a ClusterRole's) open the same lists, and a second view joins the first one's
// stream instead of opening its own. Reference-counted: the stream starts with the first user and stops when the last
// one unmounts, so nothing outlives the views (same life as `useWatch`, just shared).
import { useCallback, useSyncExternalStore } from "react";
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

const EMPTY: WatchState = Object.freeze({ items: new Map(), status: "loading" }) as WatchState;

interface Entry {
  state: WatchState;
  refs: number;
  listeners: Set<() => void>;
  stop: () => void;
}

const entries = new Map<string, Entry>();

function acquire(key: string): Entry {
  const existing = entries.get(key);
  if (existing) {
    existing.refs++;
    return existing;
  }
  const [cluster, spec] = JSON.parse(key) as [ClusterId, WatchSpec];
  const entry: Entry = { state: EMPTY, refs: 1, listeners: new Set(), stop: () => undefined };
  const update = (fn: (s: WatchState) => WatchState) => {
    const next = fn(entry.state);
    if (next === entry.state) return;
    entry.state = next;
    for (const listener of [...entry.listeners]) listener();
  };
  entries.set(key, entry);
  entry.stop = openStream<WatchUpdate>({
    start: (id, channel) => api.resources.watchStart(cluster, spec, id, channel),
    stop: api.resources.watchStop,
    onEvent: (u) => update((s) => applyWatchUpdate(s, u)),
    onStartError: (err) => update(() => ({ items: new Map(), status: "error", error: toApiError(err) })),
  });
  return entry;
}

function release(key: string, entry: Entry): void {
  entry.refs--;
  if (entry.refs > 0) return;
  if (entries.get(key) === entry) entries.delete(key);
  entry.stop();
}

/** Like `useWatch`, but views asking for the same cluster and spec share one stream. */
export function useSharedWatch(clusterId: ClusterId | null, spec: WatchSpec | null): WatchState {
  const key = clusterId && spec ? JSON.stringify([clusterId, spec]) : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => undefined;
      const entry = acquire(key);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        release(key, entry);
      };
    },
    [key],
  );
  const snapshot = useCallback(() => (key ? (entries.get(key)?.state ?? EMPTY) : EMPTY), [key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** How many shared streams are open (tests). */
export function sharedWatchCount(): number {
  return entries.size;
}
