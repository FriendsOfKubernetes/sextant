// Every update of the watches the window already has open, for a feature that wants to see changes without opening a
// watch of its own (the change timeline, #145). The shared watch layers report what they receive — `useWatch`, the
// problem sources (`features/problems/store.ts`) and the views' shared watches (`features/resource-map/watches.ts`) —
// so the same object may be reported by several watches; an observer tells them apart itself.
//
//   const stop = observeWatchUpdates((clusterId, spec, update) => …);
//
// Observers run synchronously in the watch's callback: they must be cheap and must not throw (a throw is swallowed so a
// watch never breaks because of one).
import type { ClusterId, WatchSpec, WatchUpdate } from "./types";

export type WatchObserver = (clusterId: ClusterId, spec: WatchSpec, update: WatchUpdate) => void;

const observers = new Set<WatchObserver>();

/** Calls `observer` with every update of every watch reported from now on; the returned function stops it. */
export function observeWatchUpdates(observer: WatchObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/** Called by the watch layers with each update they receive. */
export function reportWatchUpdate(clusterId: ClusterId, spec: WatchSpec, update: WatchUpdate): void {
  if (observers.size === 0) return;
  for (const observer of [...observers]) {
    try {
      observer(clusterId, spec, update);
    } catch {
      // An observer's bug never breaks the watch that reported.
    }
  }
}
