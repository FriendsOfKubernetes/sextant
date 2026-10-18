// Live list of a kind (interfaces.md §3: `useWatch(clusterId, spec)`).
//
// The backend sends a full snapshot as soon as it is listed (and after every reconnect), then deltas at most every
// 250 ms; each update becomes exactly one new `items` map, so a batch of changes costs one render (a batch that
// changes nothing costs none).
//
//   const { items, status, error } = useWatch(clusterId, { kind, namespaces: null, labelSelector: null, fieldSelector: null });
//
// `status`: "loading" until the first snapshot (also while reconnecting before it) · "ready" · "reconnecting"
// (connection lost, `items` keep the last data) · "error" (`error.code`, e.g. "forbidden" — the watch has ended).
// `forbidden`: selected namespaces that cannot be listed (no permission); the others are shown.
// Passing `null` for the cluster or the spec watches nothing. The spec is compared by value, so an inline object literal does not restart the watch.
import { useEffect, useMemo, useState } from "react";
import type { KubeObject } from "./commands";
import { resources } from "./commands";
import { toApiError, type ApiError } from "./errors";
import { openStream } from "./stream";
import { reportWatchUpdate } from "./watchObservers";
import type { ClusterId, WatchSpec, WatchUpdate } from "./types";

export type WatchStatus = "loading" | "ready" | "reconnecting" | "error";

export interface WatchState {
  /** Objects by `metadata.uid`. A new map after every update that changes it; never mutated. */
  items: Map<string, KubeObject>;
  status: WatchStatus;
  error?: ApiError;
  /** Namespaces left out for lack of permission (the backend sends them all in each `forbidden` update). */
  forbidden?: string[];
}

const EMPTY: WatchState = Object.freeze({ items: new Map(), status: "loading" }) as WatchState;

/** `metadata.uid`, or `namespace/name` for an object without one (same rule as the backend). */
export function uidOf(obj: KubeObject): string {
  const meta = obj.metadata ?? {};
  return meta.uid ?? `${meta.namespace ?? ""}/${meta.name ?? ""}`;
}

/** The state after one update from the backend. Pure; exported for tests and for non-React consumers. */
export function applyWatchUpdate(state: WatchState, update: WatchUpdate): WatchState {
  switch (update.type) {
    case "snapshot": {
      const items = new Map<string, KubeObject>();
      for (const obj of update.items as KubeObject[]) items.set(uidOf(obj), obj);
      return { items, status: "ready", forbidden: state.forbidden };
    }
    case "delta": {
      // Deletions of objects the window never had (the backend reports one deleted before it was listed) change
      // nothing; a delta of only those keeps the state, so React skips the render and nothing copies the map.
      const deleted = update.deleted.filter((uid) => state.items.has(uid));
      if (update.upserted.length === 0 && deleted.length === 0) return state;
      // A new map per batch (consumers memoize on `items` identity); the objects themselves are not copied.
      const items = new Map(state.items);
      for (const obj of update.upserted as KubeObject[]) items.set(uidOf(obj), obj);
      for (const uid of deleted) items.delete(uid);
      // Only a snapshot ends "loading": a delta before it is not the whole list.
      return { items, status: state.status, error: state.error, forbidden: state.forbidden };
    }
    case "reconnecting":
      // Nothing was listed yet: still loading (an empty `items` would read as "no objects").
      return {
        items: state.items,
        status: state.status === "loading" ? "loading" : "reconnecting",
        forbidden: state.forbidden,
      };
    case "error":
      return { items: state.items, status: "error", error: toApiError(update), forbidden: state.forbidden };
    case "forbidden":
      return { ...state, forbidden: [...update.namespaces] };
  }
}

export function useWatch(clusterId: ClusterId | null, spec: WatchSpec | null): WatchState {
  const key = clusterId && spec ? JSON.stringify([clusterId, spec]) : null;
  // Keyed state: a different cluster/spec starts from "loading" in the same render.
  const [state, setState] = useState<{ key: string | null; value: WatchState }>({ key, value: EMPTY });

  useEffect(() => {
    if (!key) return;
    const [cluster, watchSpec] = JSON.parse(key) as [ClusterId, WatchSpec];
    const update = (fn: (s: WatchState) => WatchState) =>
      setState((prev) => {
        const base = prev.key === key ? prev.value : EMPTY;
        const value = fn(base);
        // An update that changed nothing keeps the same state object: no render.
        return value === base && prev.key === key ? prev : { key, value };
      });

    return openStream<WatchUpdate>({
      start: (id, channel) => resources.watchStart(cluster, watchSpec, id, channel),
      stop: resources.watchStop,
      onEvent: (u) => {
        reportWatchUpdate(cluster, watchSpec, u);
        update((s) => applyWatchUpdate(s, u));
      },
      onStartError: (err) => update(() => ({ items: new Map(), status: "error", error: toApiError(err) })),
    });
  }, [key]);

  return useMemo(() => (state.key === key ? state.value : EMPTY), [state, key]);
}
