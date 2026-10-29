import { useEffect, useState } from "react";
import { updateSettings, type AppSettings } from "../api";
import { useAppStore, type AppState } from "./store";

export const PERSIST_DELAY_MS = 300;

function layoutKey(s: AppState): string {
  return `${s.sidebarWidth}|${s.dock.height}|${s.dock.open}|${s.railExpanded}|${s.activeClusterId ?? ""}`;
}

/**
 * Restores sidebar width, dock size/visibility and the rail view from the settings once they are loaded, then
 * saves later changes (debounced) into `settings.window`. Window size itself is saved by the backend.
 */
export function useLayoutPersistence(settings: AppSettings | null): void {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!settings || ready) return;
    useAppStore.getState().hydrateLayout(settings.window, settings.appearance);
    setReady(true);
  }, [settings, ready]);

  useEffect(() => {
    if (!settings || !ready) return;
    useAppStore.getState().setDetailsWidthPreferences(
      settings.appearance.detailsWidthScope ?? "kind",
      settings.appearance.detailsWidthSessionOnly ?? false,
      settings.window.detailsWidths ?? {},
    );
  }, [settings, ready]);

  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = useAppStore.getState();
    const unsubscribe = useAppStore.subscribe((state) => {
      const changed = state.detailsWidths !== previous.detailsWidths;
      const resumed = previous.detailsWidthSessionOnly && !state.detailsWidthSessionOnly;
      previous = state;
      if (state.detailsWidthSessionOnly) { clearTimeout(timer); return; }
      if (!changed && !resumed) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (useAppStore.getState().detailsWidthSessionOnly) return;
        void updateSettings((current) => {
          const live = useAppStore.getState();
          if (live.detailsWidthSessionOnly) return current;
          return { ...current, window: { ...current.window, detailsWidths: { ...current.window.detailsWidths, ...live.detailsWidths } } };
        }).catch(() => {
          // Keep unsaved widths in memory; the next adjustment retries the write.
        });
      }, PERSIST_DELAY_MS);
    });
    return () => { unsubscribe(); clearTimeout(timer); };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastKey = layoutKey(useAppStore.getState());
    const unsubscribe = useAppStore.subscribe((state) => {
      const key = layoutKey(state);
      if (key === lastKey) return;
      lastKey = key;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const s = useAppStore.getState();
        updateSettings((current) => ({
          ...current,
          window: {
            ...current.window,
            sidebarWidth: s.sidebarWidth,
            dockHeight: s.dock.height,
            dockOpen: s.dock.open,
            railExpanded: s.railExpanded,
            lastCluster: s.activeClusterId ?? current.window.lastCluster,
          },
        })).catch(() => {
          // Not fatal: the layout is saved again on the next change.
        });
      }, PERSIST_DELAY_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [ready]);
}
