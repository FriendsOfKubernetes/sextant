// Registry of resource kinds: how each kind appears in the sidebar, which columns its table has, which actions
// its rows offer. Built-in kinds register themselves from src/resources/kinds/*; a kind without a registration
// (a custom resource) gets a generic description from its CRD printer columns.
//
// Using it from a feature:
//
//   const def = getResourceDef({ group: "apps", version: "v1", kind: "Deployment" });
//   def.columns   // ColumnDef[] including columns added through extendColumns
//   def.actions   // ActionId[] offered in the table's context menu and the details ActionBar
//
//   // Add CPU/Memory to the pods table, right after "Restarts" (returns a function that removes them):
//   extendColumns({ group: "", kind: "Pod" }, [{ id: "cpu", titleKey: "metrics:columns.cpu", after: "restarts",
//                                              value: (obj) => usage(obj)?.cpu, render: (obj) => … }]);
import { useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { ClusterId, KindRef, KubeObject, ResourceKind } from "../api";
import type { IconName } from "../components";
import { i18n } from "../i18n";
import { genericResourceDef } from "./generic";
import { kindKey } from "./refs";

export { kindFromApiVersion, kindKey, parseViewId, refOf, viewIdOf } from "./refs";

/**
 * Actions a row can offer. Implementations are registered in src/features/actions/registry.ts. An extension's action
 * is `ext:<extensionId>:<id>` (src/extensions), offered for kinds through `extendActions`.
 */
export type ActionId = BuiltInActionId | `ext:${string}`;

export type BuiltInActionId =
  | "edit"
  | "delete"
  | "scale"
  | "restart"
  | "logs"
  | "exec"
  | "portForward"
  | "cordon"
  | "drain"
  | "trigger"
  | "suspend"
  // Rollout history (src/features/rollouts)
  | "rolloutUndo"
  // Flux (src/features/flux)
  | "reconcile"
  | "reconcileWithSource"
  | "fluxSuspend"
  | "fluxResume"
  // Argo CD (src/features/argocd)
  | "argoSync"
  | "argoRefresh"
  | "argoHardRefresh"
  | "argoTerminate"
  | "argoDiff"
  | "argoOpenUi";

/** What a cell renderer gets besides the object. */
export interface CellContext {
  clusterId: ClusterId;
  kind: KindRef;
  /** Current time (ms), refreshed periodically so ages tick. */
  now: number;
}

export interface ColumnDef {
  /** Unique within the table; also the sort key. */
  id: string;
  /** i18n key of the header, e.g. "resources:columns.name". */
  titleKey?: string;
  /** Header that is already human-readable (CRD printer columns); used when `titleKey` is absent. */
  title?: string;
  /** Value for sorting (numbers sort numerically) and the default cell text. */
  value: (obj: KubeObject) => string | number | boolean | null | undefined;
  /** Custom cell; the default shows `value`. */
  render?: (obj: KubeObject, ctx: CellContext) => ReactNode;
  /** CSS grid track, e.g. "120px" or "minmax(160px, 3fr)". Default "minmax(80px, 1fr)". */
  width?: string;
  /** Default true. */
  sortable?: boolean;
  /** Placement when added through `extendColumns`: right after / before the column with this id. */
  after?: string;
  before?: string;
  /** Placement after the column with this header as shown (extensions name columns by their titles). */
  afterTitle?: string;
  /** Where it goes when the column it should follow is not there: at the end (default: before "age"). */
  fallback?: "end" | "beforeAge";
}

/**
 * Sidebar sections in Lens order. Pages (`registerPage`) use the same ids in `section`. `gatewayApi`, `flux` and
 * `argocd` belong to APIs and tools installed in the cluster: see `DISCOVERED_SECTIONS`.
 */
export const SIDEBAR_SECTIONS = [
  "cluster",
  "nodes",
  "workloads",
  "config",
  "network",
  "gatewayApi",
  "storage",
  "namespaces",
  "events",
  "helm",
  "accessControl",
  "certManager",
  "trivy",
  "flux",
  "argocd",
  "customResources",
] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

/**
 * Sections of APIs and tools a cluster may or may not have (Gateway API, Flux, Argo CD): their kinds are listed only
 * once discovery says the cluster serves them, never before it comes, so a section without served kinds — the CRDs
 * are not installed — is not drawn at all.
 */
export const DISCOVERED_SECTIONS: ReadonlySet<SidebarSection> = new Set<SidebarSection>([
  "gatewayApi",
  "flux",
  "argocd",
  "certManager",
  "trivy",
]);

/** Icon of each sidebar section's header (and of a section shown as one link); `settings` is the Settings page. */
export const SECTION_ICONS: Record<SidebarSection | "settings", IconName> = {
  cluster: "cluster",
  nodes: "nodes",
  workloads: "workloads",
  config: "config",
  network: "network",
  gatewayApi: "gatewayApi",
  storage: "storage",
  namespaces: "namespaces",
  events: "events",
  helm: "helm",
  accessControl: "accessControl",
  certManager: "certManager",
  trivy: "trivy",
  flux: "flux",
  argocd: "argocd",
  customResources: "customResources",
  settings: "settings",
};

/** For entries without an icon of their own: custom resources from discovery, a registration that names none. */
export const DEFAULT_ENTRY_ICON: IconName = "customResource";

export interface SidebarEntry {
  section: SidebarSection;
  /** Position inside the section (ascending), shared with pages of the same section. */
  order: number;
  /** i18n key of the label, plural ("Pods"); also the table title. */
  labelKey: string;
  /** Icon left of the label; without one the sidebar draws `DEFAULT_ENTRY_ICON`. */
  icon?: IconName;
}

export interface ResourceDef {
  kind: KindRef;
  /** `null` for kinds that have no sidebar entry of their own (custom resources get theirs from the CRD tree). */
  sidebar: SidebarEntry | null;
  columns: ColumnDef[];
  /** Kind-specific block of the details panel, if any. */
  details?: ComponentType<{ obj: KubeObject }>;
  actions: ActionId[];
  /** Default true. Cluster-scoped kinds have no namespace column and ignore the namespace filter. */
  namespaced?: boolean;
  /** Human-readable plural title when there is no i18n key (custom resources). */
  title?: string;
  /** Whether an object is in trouble; with it the kind's table offers an "Only problems" filter. */
  problem?: (obj: KubeObject) => boolean;
}

const defs = new Map<string, ResourceDef>();
// Additions by kind, keyed ignoring case (`extensionKey`): kinds in extension manifests are compared ignoring case.
const extensions = new Map<string, Map<string, ColumnDef[]>>();
const extraActions = new Map<string, Map<string, ActionId[]>>();
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version++;
  for (const fn of listeners) fn();
}

/** Registers (or replaces) the description of a kind. */
export function registerResource(def: ResourceDef): void {
  defs.set(kindKey(def.kind), def);
  changed();
}

export function unregisterResource(kind: Pick<KindRef, "group" | "kind">): void {
  defs.delete(kindKey(kind));
  changed();
}

let extensionCounter = 0;

/**
 * Adds columns to the table of a kind (built-in or custom). Each column goes after/before the column named in its
 * `after`/`before`, otherwise before "age". Returns a function that removes them again.
 */
export function extendColumns(kind: Pick<KindRef, "group" | "kind">, columns: ColumnDef[]): () => void {
  const key = extensionKey(kind);
  const token = `ext-${++extensionCounter}`;
  const byKind = extensions.get(key) ?? new Map<string, ColumnDef[]>();
  byKind.set(token, columns);
  extensions.set(key, byKind);
  changed();
  return () => {
    extensions.get(key)?.delete(token);
    changed();
  };
}

/**
 * Offers more actions (registered with `registerAction`) for a kind, after its own `ResourceDef.actions`, in the table's
 * row menu and the details panel. The kind is matched ignoring case. Returns a function that removes them again.
 */
export function extendActions(kind: Pick<KindRef, "group" | "kind">, ids: readonly ActionId[]): () => void {
  const key = extensionKey(kind);
  const token = `ext-${++extensionCounter}`;
  const byKind = extraActions.get(key) ?? new Map<string, ActionId[]>();
  byKind.set(token, [...ids]);
  extraActions.set(key, byKind);
  changed();
  return () => {
    if (extraActions.get(key)?.delete(token)) changed();
  };
}

function extensionKey(kind: Pick<KindRef, "group" | "kind">): string {
  return kindKey(kind).toLowerCase();
}

/** The registered description of a kind (without column extensions), if any. */
export function findResourceDef(kind: Pick<KindRef, "group" | "kind">): ResourceDef | undefined {
  return defs.get(kindKey(kind));
}

/** All registered built-in kinds (sidebar order is up to the caller). */
export function getResourceDefs(): ResourceDef[] {
  return [...defs.values()];
}

/**
 * Description of a kind: the registered one (with `kind.version` as asked) or a generic one built from the CRD
 * printer columns of `resourceKind` (from `api.clusters.kinds`). Columns added through `extendColumns` included.
 */
export function getResourceDef(kind: KindRef, resourceKind?: ResourceKind | null): ResourceDef {
  const registered = defs.get(kindKey(kind));
  const base: ResourceDef = registered
    ? { ...registered, kind: { ...registered.kind, version: kind.version || registered.kind.version } }
    : genericResourceDef(kind, resourceKind ?? null);
  const key = extensionKey(kind);
  const extra = extensions.get(key);
  const actions = extraActions.get(key);
  let def = base;
  if (extra && extra.size > 0) def = { ...def, columns: placeColumns(base.columns, [...extra.values()].flat()) };
  if (actions && actions.size > 0) {
    const added = [...actions.values()].flat().filter((id) => !base.actions.includes(id));
    def = { ...def, actions: [...base.actions, ...new Set(added)] };
  }
  return def;
}

function placeColumns(columns: ColumnDef[], added: ColumnDef[]): ColumnDef[] {
  const result = [...columns];
  for (const col of added) {
    const without = result.filter((c) => c.id !== col.id);
    let index = -1;
    if (col.after) {
      const at = without.findIndex((c) => c.id === col.after);
      if (at >= 0) index = at + 1;
    } else if (col.before) {
      index = without.findIndex((c) => c.id === col.before);
    } else if (col.afterTitle) {
      const wanted = col.afterTitle.toLowerCase();
      const at = without.findIndex((c) => headerOf(c)?.toLowerCase() === wanted);
      if (at >= 0) index = at + 1;
    }
    if (index < 0) {
      const age = col.fallback === "end" ? -1 : without.findIndex((c) => c.id === "age");
      index = age >= 0 ? age : without.length;
    }
    without.splice(index, 0, col);
    result.splice(0, result.length, ...without);
  }
  return result;
}

/** The header of a column as shown. */
function headerOf(column: ColumnDef): string | undefined {
  return column.titleKey ? i18n.t(column.titleKey) : column.title;
}

/** Hook form of `getResourceDef` that re-renders when the registry or column extensions change. */
export function useResourceDef(kind: KindRef, resourceKind?: ResourceKind | null): ResourceDef {
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);
  const { group, version: kindVersion, kind: name } = kind;
  // Stable while nothing changes, so tables do not rebuild their columns on every render.
  return useMemo(
    () => getResourceDef({ group, version: kindVersion, kind: name }, resourceKind),
    [current, group, kindVersion, name, resourceKind],
  );
}

/** Re-renders when the registry changes (e.g. the sidebar). */
export function useRegistryVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getVersion(): number {
  return version;
}
