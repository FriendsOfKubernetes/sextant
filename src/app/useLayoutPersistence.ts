import { useEffect, useState } from "react";
import { updateSettings, type AppSettings } from "../api";
import { useAppStore, type AppState } from "./store";

export const PERSIST_DELAY_MS = 300;

function layoutKey(s: AppState): string {
  return `${s.sidebarWidth}|${s.dock.height}|${s.dock.open}|${s.activeClusterId ?? ""}`;
}

/**
 * Restores sidebar width and dock size/visibility from the settings once they are loaded, then saves later
 * changes (debounced) into `settings.window`. Window size itself is saved by the backend.
 */
export function useLayoutPersistence(settings: AppSettings | null): void {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!settings || ready) return;
    useAppStore.getState().hydrateLayout(settings.window);
    setReady(true);
  }, [settings, ready]);

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
