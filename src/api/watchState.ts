// The state of a watch as the window keeps it, and how each update from the backend changes it (`useWatch`,
// the shared watches of `watchRegistry.ts` and every store that applies watch updates itself).
import type { KubeObject } from "./commands";
import { toApiError, type ApiError } from "./errors";
import type { WatchUpdate } from "./types";

export type WatchStatus = "loading" | "ready" | "reconnecting" | "error";

export interface WatchState {
  /** Objects by `metadata.uid`. A new map after every update that changes it; never mutated. */
  items: Map<string, KubeObject>;
  /**
   * "loading" until the first list is complete — a watch started with `WatchOptions.progressive` already has the
   * objects of the parts that came (`items` not empty) while it loads.
   */
  status: WatchStatus;
  error?: ApiError;
  /** Namespaces left out for lack of permission (the backend sends them all in each `forbidden` update). */
  forbidden?: string[];
  /**
   * With `WatchOptions.maxObjects`: how many objects match in all. Above `items.size`, the watch keeps only the first
   * ones and the rest are left out.
   */
  total?: number;
}

/** `metadata.uid`, or `namespace/name` for an object without one (same rule as the backend). */
export function uidOf(obj: KubeObject): string {
  const meta = obj.metadata ?? {};
  return meta.uid ?? `${meta.namespace ?? ""}/${meta.name ?? ""}`;
}

/** Whether the watch keeps fewer objects than match (`WatchOptions.maxObjects`). */
export function isCapped(state: WatchState): boolean {
  return state.total !== undefined && state.total > state.items.size;
}

/** The state after one update from the backend. Pure; exported for tests and for non-React consumers. */
export function applyWatchUpdate(state: WatchState, update: WatchUpdate): WatchState {
  switch (update.type) {
    case "snapshot": {
      const items = new Map<string, KubeObject>();
      for (const obj of update.items as KubeObject[]) items.set(uidOf(obj), obj);
      return { items, status: "ready", forbidden: state.forbidden, total: state.total };
    }
    case "snapshotPart": {
      // More of the first list: added to what came before; still loading.
      const items = new Map(state.items);
      for (const obj of update.items as KubeObject[]) items.set(uidOf(obj), obj);
      return { ...state, items };
    }
    case "snapshotEnd": {
      const items = new Map(state.items);
      for (const uid of update.deleted) items.delete(uid);
      for (const obj of update.items as KubeObject[]) items.set(uidOf(obj), obj);
      return { items, status: "ready", forbidden: state.forbidden, total: state.total };
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
      return { ...state, items };
    }
    case "capped":
      return state.total === update.total ? state : { ...state, total: update.total };
    case "reconnecting":
      // Nothing was listed yet: still loading (an empty `items` would read as "no objects").
      return {
        items: state.items,
        status: state.status === "loading" ? "loading" : "reconnecting",
        forbidden: state.forbidden,
        total: state.total,
      };
    case "error":
      return { items: state.items, status: "error", error: toApiError(update), forbidden: state.forbidden, total: state.total };
    case "forbidden":
      return { ...state, forbidden: [...update.namespaces] };
  }
}
