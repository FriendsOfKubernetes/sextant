// UI state of the window (zustand). Data from clusters lives in src/api hooks, not here.
import { create } from "zustand";
import type { AppSettings, ClusterId, ObjectRef, WindowLayout } from "../api";
import type { CustomColumnSpec } from "../api/generated/CustomColumnSpec";

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
  /**
   * How the open table is shown beyond the search (#149: what a saved view captures): its filters, sort and hidden
   * columns. Belongs to the view id it names; another view starts from the defaults (`null`).
   */
  table?: TableState | null;
}

/** Filters, sort and hidden columns of the table of one view (`ClusterView.table`). */
export interface TableState {
  /** The view id (sidebar entry) this state belongs to. */
  view: string;
  onlyProblems: boolean;
  /** A label selector the watch is asked for; empty = none. */
  labelSelector: string;
  /** The sorted column; `null` = the table's default. */
  sort: { column: string; desc: boolean } | null;
  hiddenColumns: string[];
  /** Custom columns an opened saved view brought (#214), shown besides the stored ones; absent = none. */
  viewColumns?: CustomColumnSpec[];
}

export const DEFAULT_TABLE_STATE: Omit<TableState, "view"> = Object.freeze({
  onlyProblems: false,
  labelSelector: "",
  sort: null,
  hiddenColumns: [],
}) as Omit<TableState, "view">;

/** The table state of `view` (the defaults when the stored one belongs to another view). */
export function tableStateOf(cv: ClusterView, view: string): TableState {
  return cv.table && cv.table.view === view ? cv.table : { ...DEFAULT_TABLE_STATE, view };
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
export const DETAILS_MIN_WIDTH = 480;
export const DETAILS_DEFAULT_WIDTH = 725;
type WidthScope = AppSettings["appearance"]["detailsWidthScope"];

export const EMPTY_CLUSTER_VIEW: ClusterView = Object.freeze({ view: null, namespaces: null, search: "" }) as ClusterView;

export interface AppState {
  activeClusterId: ClusterId | null;
  clusterViews: Record<ClusterId, ClusterView>;
  details: ObjectRef | null;
  dock: DockState;
  sidebarWidth: number;
  detailsWidths: Record<string, number>;
  detailsWidthScope: WidthScope;
  detailsWidthSessionOnly: boolean;
  /** The cluster rail shows names next to the icons. */
  railExpanded: boolean;
  /**
   * A window-wide page shown in the main area while no cluster is active (`"fleet"`: the overview of several
   * clusters, drawn by the "home" slot); `null` = the welcome area. An active cluster always takes the main area.
   */
  homeView: string | null;

  setActiveCluster(clusterId: ClusterId | null): void;
  setView(clusterId: ClusterId, view: string | null): void;
  setNamespaces(clusterId: ClusterId, namespaces: string[] | null): void;
  setSearch(clusterId: ClusterId, search: string): void;
  /** Changes the table state of `view` (starting from the defaults when the stored one is of another view). */
  setTableState(clusterId: ClusterId, view: string, patch: Partial<Omit<TableState, "view">>): void;
  /** Opens `view` with this search and table state at once (a saved view); namespaces go through their own setter. */
  openTableView(clusterId: ClusterId, view: string, search: string, table: Omit<TableState, "view">): void;

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
  setDetailsWidth(kind: string, width: number): void;
  setDetailsWidthPreferences(scope: WidthScope, sessionOnly: boolean, saved: Record<string, number>): void;
  setRailExpanded(expanded: boolean): void;
  /** Shows a window-wide page (`null`: the welcome area); a view other than `null` also leaves the active cluster. */
  setHomeView(view: string | null): void;

  /** Applies the saved window layout (on start). */
  hydrateLayout(layout: WindowLayout, appearance?: AppSettings["appearance"]): void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));

let tabCounter = 0;

export const initialAppState = {
  activeClusterId: null,
  clusterViews: {},
  details: null,
  dock: { open: false, height: 300, tabs: [], activeTabId: null },
  sidebarWidth: 220,
  detailsWidths: {},
  detailsWidthScope: "kind" as WidthScope,
  detailsWidthSessionOnly: false,
  railExpanded: false,
  homeView: null,
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
    // Another view starts with its table's defaults ("Only problems" off, default sort, every column).
    setView: (clusterId, view) =>
      patchView(clusterId, get().clusterViews[clusterId]?.table && get().clusterViews[clusterId]?.view !== view ? { view, table: null } : { view }),
    setNamespaces: (clusterId, namespaces) => patchView(clusterId, { namespaces }),
    setSearch: (clusterId, search) => patchView(clusterId, { search }),
    setTableState: (clusterId, view, patch) =>
      patchView(clusterId, {
        table: { ...tableStateOf(get().clusterViews[clusterId] ?? EMPTY_CLUSTER_VIEW, view), ...patch, view },
      }),
    openTableView: (clusterId, view, search, table) =>
      patchView(clusterId, { view, search, table: { ...table, hiddenColumns: [...table.hiddenColumns], view } }),

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
    setDetailsWidth: (kind, width) => {
      if (!Number.isFinite(width)) return;
      const value = Math.max(DETAILS_MIN_WIDTH, Math.round(width));
      const state = get();
      const key = state.detailsWidthScope === "global" ? "*" : kind;
      if ((state.detailsWidths[key] ?? DETAILS_DEFAULT_WIDTH) === value) return;
      set({ detailsWidths: { ...state.detailsWidths, [key]: value } });
    },
    setDetailsWidthPreferences: (scope, sessionOnly, saved) => {
      const state = get();
      if (state.detailsWidthScope === scope && state.detailsWidthSessionOnly === sessionOnly) return;
      set({
        detailsWidthScope: scope,
        detailsWidthSessionOnly: sessionOnly,
        ...(!sessionOnly && state.detailsWidthSessionOnly ? { detailsWidths: { ...saved, ...state.detailsWidths } } : {}),
      });
    },
    setRailExpanded: (expanded) => set({ railExpanded: expanded }),
    setHomeView: (view) =>
      set(view === null ? { homeView: null } : { homeView: view, activeClusterId: null, details: null }),

    hydrateLayout: (layout, appearance) =>
      set((s) => ({
        sidebarWidth: clamp(layout.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
        detailsWidths: appearance?.detailsWidthSessionOnly ? {} : { ...layout.detailsWidths },
        detailsWidthScope: appearance?.detailsWidthScope ?? "kind",
        detailsWidthSessionOnly: appearance?.detailsWidthSessionOnly ?? false,
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
