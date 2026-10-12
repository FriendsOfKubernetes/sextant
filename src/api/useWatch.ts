// Live list of a kind (interfaces.md §3: `useWatch(clusterId, spec)`).
//
// The backend sends a full snapshot as soon as it is listed (and after every reconnect), then deltas at most every
// 250 ms; each update becomes exactly one new `items` map, so a batch of changes costs one render.
//
//   const { items, status, error } = useWatch(clusterId, { kind, namespaces: null, labelSelector: null, fieldSelector: null });
//
// `status`: "loading" until the first snapshot (also while reconnecting before it) · "ready" · "reconnecting"
// (connection lost, `items` keep the last data) · "error" (`error.code`, e.g. "forbidden" — the watch has ended).
// Passing `null` for the cluster or the spec watches nothing. The spec is compared by value, so an inline object literal does not restart the watch.
import { useEffect, useMemo, useState } from "react";
import type { KubeObject } from "./commands";
import { resources } from "./commands";
import { toApiError, type ApiError } from "./errors";
import { events } from "./events";
import { openStream } from "./stream";
import type { ClusterId, WatchSpec, WatchUpdate } from "./types";

export type WatchStatus = "loading" | "ready" | "reconnecting" | "error";

export interface WatchState {
  /** Objects by `metadata.uid`. A new map after every update; never mutated. */
  items: Map<string, KubeObject>;
  status: WatchStatus;
  error?: ApiError;
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
      return { items, status: "ready" };
    }
    case "delta": {
      const items = new Map(state.items);
      for (const obj of update.upserted as KubeObject[]) items.set(uidOf(obj), obj);
      for (const uid of update.deleted) items.delete(uid);
      // Only a snapshot ends "loading": a delta before it is not the whole list.
      return { items, status: state.status, error: state.error };
    }
    case "reconnecting":
      // Nothing was listed yet: still loading (an empty `items` would read as "no objects").
      return { items: state.items, status: state.status === "loading" ? "loading" : "reconnecting" };
    case "error":
      return { items: state.items, status: "error", error: toApiError(update) };
    case "forbidden":
      // Not sent yet; the namespaces without permission are not shown.
      return state;
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
      setState((prev) => ({ key, value: fn(prev.key === key ? prev.value : EMPTY) }));

    return openStream<WatchUpdate>({
      start: (id) => resources.watchStart(cluster, watchSpec, id),
      listen: events.onWatch,
      stop: resources.watchStop,
      onEvent: (u) => update((s) => applyWatchUpdate(s, u)),
      onStartError: (err) => update(() => ({ items: new Map(), status: "error", error: toApiError(err) })),
    });
  }, [key]);

  return useMemo(() => (state.key === key ? state.value : EMPTY), [state, key]);
}
