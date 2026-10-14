// UI state of the window (zustand). Data from clusters lives in src/api hooks, not here.
import { create } from "zustand";
import type { ClusterId, ObjectRef, WindowLayout } from "../api";

/** Built-in tab kinds, and `ext:<extensionId>:<id>` for an extension's dock tab. */
export type DockTabType = "logs" | "exec" | "terminal" | "create" | "edit" | `ext:${string}`;

export interface DockTab {
  id: string;
  type: DockTabType;
  /** Already human-readable (usually a resource name), not an i18n key. */
  title: string;
  payload: unknown;
}

/** Per-cluster view state, kept while switching between clusters. */
export interface ClusterView {
  /** Sidebar entry that is open (a page id or a resource view id); `null` = default view. */
  view: string | null;
  /** Selected namespaces; `null` = all namespaces. */
  namespaces: string[] | null;
  search: string;
}

export interface DockState {
  open: boolean;
  height: number;
  tabs: DockTab[];
  activeTabId: string | null;
}

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 480;
export const DOCK_MIN_HEIGHT = 120;
export const DOCK_MAX_HEIGHT = 1600;

export const EMPTY_CLUSTER_VIEW: ClusterView = Object.freeze({ view: null, namespaces: null, search: "" }) as ClusterView;

export interface AppState {
  activeClusterId: ClusterId | null;
  clusterViews: Record<ClusterId, ClusterView>;
  details: ObjectRef | null;
  dock: DockState;
  sidebarWidth: number;
  /** The cluster rail shows names next to the icons. */
  railExpanded: boolean;

  setActiveCluster(clusterId: ClusterId | null): void;
  setView(clusterId: ClusterId, view: string | null): void;
  setNamespaces(clusterId: ClusterId, namespaces: string[] | null): void;
  setSearch(clusterId: ClusterId, search: string): void;

  openDetails(ref: ObjectRef): void;
  closeDetails(): void;

  /** Opens (or re-activates, when `id` is already open) a dock tab and shows the dock. Returns the tab id. */
  openDockTab(tab: Omit<DockTab, "id"> & { id?: string }): string;
  closeDockTab(id: string): void;
  setActiveDockTab(id: string): void;
  setDockOpen(open: boolean): void;
  toggleDock(): void;
  setDockHeight(height: number): void;
  setSidebarWidth(width: number): void;
  setRailExpanded(expanded: boolean): void;

  /** Applies the saved window layout (on start). */
  hydrateLayout(layout: WindowLayout): void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

let tabCounter = 0;

export const initialAppState = {
  activeClusterId: null,
  clusterViews: {},
  details: null,
  dock: { open: false, height: 300, tabs: [], activeTabId: null },
  sidebarWidth: 220,
  railExpanded: false,
} satisfies Partial<AppState>;

export const useAppStore = create<AppState>()((set, get) => {
  const patchView = (clusterId: ClusterId, patch: Partial<ClusterView>) =>
    set((s) => ({
      clusterViews: {
        ...s.clusterViews,
        [clusterId]: { ...(s.clusterViews[clusterId] ?? EMPTY_CLUSTER_VIEW), ...patch },
      },
    }));

  return {
    ...initialAppState,

    setActiveCluster: (clusterId) => set({ activeClusterId: clusterId, details: null }),
    setView: (clusterId, view) => patchView(clusterId, { view }),
    setNamespaces: (clusterId, namespaces) => patchView(clusterId, { namespaces }),
    setSearch: (clusterId, search) => patchView(clusterId, { search }),

    openDetails: (ref) => set({ details: ref }),
    closeDetails: () => set({ details: null }),

    openDockTab: (tab) => {
      const id = tab.id ?? `${tab.type}-${++tabCounter}`;
      const { dock } = get();
      const exists = dock.tabs.some((t) => t.id === id);
      set({
        dock: {
          ...dock,
          open: true,
          tabs: exists ? dock.tabs : [...dock.tabs, { ...tab, id }],
          activeTabId: id,
        },
      });
      return id;
    },
    closeDockTab: (id) => {
      const { dock } = get();
      const index = dock.tabs.findIndex((t) => t.id === id);
      if (index < 0) return;
      const tabs = dock.tabs.filter((t) => t.id !== id);
      let activeTabId = dock.activeTabId;
      if (activeTabId === id) activeTabId = (tabs[index] ?? tabs[index - 1])?.id ?? null;
      set({ dock: { ...dock, tabs, activeTabId } });
    },
    setActiveDockTab: (id) => set((s) => ({ dock: { ...s.dock, activeTabId: id, open: true } })),
    setDockOpen: (open) => set((s) => ({ dock: { ...s.dock, open } })),
    toggleDock: () => set((s) => ({ dock: { ...s.dock, open: !s.dock.open } })),
    setDockHeight: (height) =>
      set((s) => ({ dock: { ...s.dock, height: clamp(height, DOCK_MIN_HEIGHT, DOCK_MAX_HEIGHT) } })),
    setSidebarWidth: (width) => set({ sidebarWidth: clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH) }),
    setRailExpanded: (expanded) => set({ railExpanded: expanded }),

    hydrateLayout: (layout) =>
      set((s) => ({
        sidebarWidth: clamp(layout.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
        // A file from before the rail could be expanded has no such field.
        railExpanded: layout.railExpanded === true,
        dock: {
          ...s.dock,
          open: layout.dockOpen,
          height: clamp(layout.dockHeight, DOCK_MIN_HEIGHT, DOCK_MAX_HEIGHT),
        },
      })),
  };
});

/** View state of one cluster (a stable empty object when nothing was set yet). */
export function useClusterView(clusterId: ClusterId | null): ClusterView {
  return useAppStore((s) => (clusterId ? (s.clusterViews[clusterId] ?? EMPTY_CLUSTER_VIEW) : EMPTY_CLUSTER_VIEW));
}

/** Resets the store to its initial state (tests). */
export function resetAppStore(): void {
  useAppStore.setState({ ...initialAppState, dock: { ...initialAppState.dock, tabs: [] }, clusterViews: {} });
}
