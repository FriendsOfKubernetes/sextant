// Live list of a kind (interfaces.md §3: `useWatch(clusterId, spec)`).
//
// The backend sends a full snapshot first (and after every reconnect), then deltas at most every 250 ms; each
// update becomes exactly one new `items` map, so a batch of changes costs one render.
//
//   const { items, status, error } = useWatch(clusterId, { kind, namespaces: null, labelSelector: null, fieldSelector: null });
//
// `status`: "loading" until the first snapshot · "ready" · "reconnecting" (connection lost, `items` keep the last
// data) · "error" (`error.code`, e.g. "forbidden" — the watch has ended). Passing `null` for the cluster or the spec
// watches nothing. The spec is compared by value, so an inline object literal does not restart the watch.
import { useEffect, useMemo, useState } from "react";
import type { KubeObject } from "./commands";
import { resources } from "./commands";
import { toApiError, type ApiError } from "./errors";
import { events } from "./events";
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
      return { items, status: state.status === "loading" ? "ready" : state.status, error: state.error };
    }
    case "reconnecting":
      return { items: state.items, status: "reconnecting" };
    case "error":
      return { items: state.items, status: "error", error: toApiError(update) };
  }
}

export function useWatch(clusterId: ClusterId | null, spec: WatchSpec | null): WatchState {
  const key = clusterId && spec ? JSON.stringify([clusterId, spec]) : null;
  // Keyed state: a different cluster/spec starts from "loading" in the same render.
  const [state, setState] = useState<{ key: string | null; value: WatchState }>({ key, value: EMPTY });

  useEffect(() => {
    if (!key) return;
    const [cluster, watchSpec] = JSON.parse(key) as [ClusterId, WatchSpec];
    let cancelled = false;
    let subscriptionId: string | null = null;
    let unlisten: (() => void) | null = null;
    const update = (fn: (s: WatchState) => WatchState) =>
      setState((prev) => ({ key, value: fn(prev.key === key ? prev.value : EMPTY) }));

    resources.watchStart(cluster, watchSpec).then(
      async (id) => {
        if (cancelled) {
          void resources.watchStop(id).catch(() => undefined);
          return;
        }
        subscriptionId = id;
        const off = await events.onWatch(id, (u) => {
          if (!cancelled) update((s) => applyWatchUpdate(s, u));
        });
        if (cancelled) off();
        else unlisten = off;
      },
      (err: unknown) => {
        if (!cancelled) update(() => ({ items: new Map(), status: "error", error: toApiError(err) }));
      },
    );

    return () => {
      cancelled = true;
      unlisten?.();
      if (subscriptionId) void resources.watchStop(subscriptionId).catch(() => undefined);
    };
  }, [key]);

  return useMemo(() => (state.key === key ? state.value : EMPTY), [state, key]);
}
