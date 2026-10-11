// Saves the open sidebar section of every cluster as `ClusterSettings.lastView`, so the next start reopens it.
import type { ClusterId } from "../../api";
import { useAppStore, type ClusterView } from "../../app/store";
import { updateClusterSettings } from "./clusterSettings";

export const VIEW_PERSIST_DELAY_MS = 300;

/** Starts following view changes; returns the function that stops it. */
export function startViewPersistence(): () => void {
  let previous: Record<ClusterId, ClusterView> = useAppStore.getState().clusterViews;
  const timers = new Map<ClusterId, ReturnType<typeof setTimeout>>();

  const unsubscribe = useAppStore.subscribe((state) => {
    const views = state.clusterViews;
    if (views === previous) return;
    for (const [id, view] of Object.entries(views)) {
      if (!view.view || view.view === previous[id]?.view) continue;
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          const current = useAppStore.getState().clusterViews[id]?.view;
          if (current) {
            updateClusterSettings(id, { lastView: current }).catch(() => {
              // Not fatal: saved again on the next change.
            });
          }
        }, VIEW_PERSIST_DELAY_MS),
      );
    }
    previous = views;
  });

  return () => {
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
