// Narrow window (phone-sized or a thin desktop window): the cluster rail and the sidebar move into a menu, the details
// panel and the dock take the full width.
import { useSyncExternalStore } from "react";

/** Widths up to this (CSS px) use the narrow layout; `layout.css` uses the same breakpoint. */
export const NARROW_MAX_WIDTH = 768;
const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH}px)`;

function query(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  if (!list) return () => undefined;
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

const isNarrow = () => query()?.matches ?? false;

/** Whether the window is at most `NARROW_MAX_WIDTH` wide; follows resizes. */
export function useNarrowLayout(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, () => false);
}
