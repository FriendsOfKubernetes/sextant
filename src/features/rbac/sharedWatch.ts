// One watch per (cluster, spec) for every RBAC view that asks for it at the same time: the Permissions page and a
// details section (a ServiceAccount's, a ClusterRole's) open the same lists, and a second view joins the first one's
// stream instead of opening its own. Reference-counted: the stream starts with the first user and stops when the last
// one unmounts, so nothing outlives the views (same life as `useWatch`, just shared). The sharing itself is the
// app-wide watch registry (`src/api/watchRegistry.ts`, #157), so a table of the same list shares the stream too.
import { useEffect } from "react";
import { isWatchOpen, useWatch, watchKey, type ClusterId, type WatchSpec, type WatchState } from "../../api";

/** Keys the RBAC views hold, with how many views hold each. */
const held = new Map<string, number>();

/** Like `useWatch`, but views asking for the same cluster and spec share one stream. */
export function useSharedWatch(clusterId: ClusterId | null, spec: WatchSpec | null): WatchState {
  const key = clusterId && spec ? watchKey(clusterId, spec) : null;
  useEffect(() => {
    if (!key) return;
    held.set(key, (held.get(key) ?? 0) + 1);
    return () => {
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) held.set(key, left);
      else held.delete(key);
    };
  }, [key]);
  return useWatch(clusterId, spec);
}

/** How many shared streams the RBAC views hold open (tests). */
export function sharedWatchCount(): number {
  return [...held.keys()].filter(isWatchOpen).length;
}
