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
// Components asking for the same cluster, spec and options share one stream (`watchRegistry.ts`, #157). `options`
// (the tables): the first list in parts — rows show while it loads — and a cap on the objects kept (`total`).
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ClusterId, WatchOptions, WatchSpec } from "./types";
import {
  acquireWatch,
  subscribeAllWatches,
  subscribeWatchKey,
  watchEpochOf,
  watchKey,
  watchStateByKey,
} from "./watchRegistry";
import type { WatchState } from "./watchState";

export { applyWatchUpdate, isCapped, uidOf, type WatchState, type WatchStatus } from "./watchState";

const EMPTY: WatchState = Object.freeze({ items: new Map(), status: "loading" }) as WatchState;
const noSubscription = () => () => undefined;

export function useWatch(
  clusterId: ClusterId | null,
  spec: WatchSpec | null,
  options?: WatchOptions | null,
): WatchState {
  const key = clusterId && spec ? watchKey(clusterId, spec) : null;
  // What to acquire, by value: an inline spec or options literal does not restart the watch.
  const args = clusterId && spec ? JSON.stringify([clusterId, spec, options ?? null]) : null;
  const epoch = useSyncExternalStore(subscribeAllWatches, () => (clusterId ? watchEpochOf(clusterId) : 0));

  const subscribe = useMemo(
    () => (key ? (listener: () => void) => subscribeWatchKey(key, listener) : noSubscription),
    [key],
  );
  const snapshot = () => (key ? watchStateByKey(key) : EMPTY);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (!args) return;
    const [cluster, watchSpec, watchOptions] = JSON.parse(args) as [ClusterId, WatchSpec, WatchOptions | null];
    // `epoch`: a cluster whose watches were dropped (its connection came or went) is watched anew.
    return acquireWatch(cluster, watchSpec, { watch: watchOptions });
  }, [args, epoch]);

  return key ? state : EMPTY;
}
