// Whether the command palette is open, and what was chosen in it recently (shown first while nothing is typed).
// Kept in memory for the window's session, not in settings.json.
import { create } from "zustand";
import type { ClusterId, KindRef } from "../../api";

/** An object chosen in the palette, enough to show it again among the recent items. */
export interface RecentObject {
  clusterId: ClusterId;
  kind: KindRef;
  namespace: string | null;
  name: string;
}

export interface RecentEntry {
  /** Key of the palette item (`page:…`, `kind:…`, `cluster:…`, `settings:…`, `object:…`). */
  key: string;
  /** Set for objects: they are not among the items the palette builds without a query. */
  object?: RecentObject;
}

/** How many recent items are kept. */
export const RECENT_LIMIT = 8;

interface PaletteState {
  open: boolean;
  recent: RecentEntry[];
}

export const usePalette = create<PaletteState>(() => ({ open: false, recent: [] }));

export function openPalette(): void {
  usePalette.setState({ open: true });
}

export function closePalette(): void {
  usePalette.setState({ open: false });
}

export function togglePalette(): void {
  usePalette.setState((s) => ({ open: !s.open }));
}

/** Puts `entry` first among the recent items (once). */
export function rememberRecent(entry: RecentEntry): void {
  usePalette.setState((s) => ({
    recent: [entry, ...s.recent.filter((r) => r.key !== entry.key)].slice(0, RECENT_LIMIT),
  }));
}

/** Closed, nothing recent (tests). */
export function resetPalette(): void {
  usePalette.setState({ open: false, recent: [] });
}
