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
  // Set image (src/features/set-image)
  | "setImage"
  // Storage insights (src/features/storage)
  | "snapshotCreate"
  | "snapshotRestore"
  | "veleroBackup"
  | "veleroRestore"
  // Favourites (src/features/views), offered for every kind through `extendActionsForAll`
  | "pin"
  | "unpin"
  // Comparing objects (src/features/compare), offered for every kind through `extendActionsForAll`
  | "compareWith"
  // Traffic path diagnosis (src/features/diagnose), offered for Services, Ingresses and HTTP/GRPC routes
  | "diagnose"
  // Copy namespace/name (src/features/copy-name), offered for every kind through `extendActionsForAll`
  | "copyNamespacedName"
  | "copyName"
  // OpenShift (src/features/openshift): `oc rollout latest` of a DeploymentConfig, `oc start-build` of a BuildConfig
  | "openshiftRolloutLatest"
  | "openshiftStartBuild";

/** What a cell renderer gets besides the object. */
export interface CellContext {
  clusterId: ClusterId;
  kind: KindRef;
  /** Current time (ms), refreshed periodically so ages tick. */
  now: number;
}

/** What `ColumnDef.searchText` gets: the time the table shows and a translation function (cached by the table). */
export interface SearchTextContext {
  now: number;
  t: (key: string, options?: Record<string, unknown>) => string;
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
  /** Raw filter semantics when sorting differs from the cell (owners, ages, metrics). */
  filter?: {
    type?: "string" | "number" | "boolean" | "age";
    unit?: "cpu" | "bytes";
    value?: (obj: KubeObject, ctx: CellContext) => ColumnFilterValue;
    /** Shares an existing data subscription while a filter needs it, even with no visible rows. */
    observer?: ComponentType<{ context: CellContext; onChange: () => void }>;
    /** False while the values are not there (metrics loading or failing): the column's conditions keep every row. */
    ready?: (ctx: CellContext) => boolean;
  };
  /** Custom cell; the default shows `value`. */
  render?: (obj: KubeObject, ctx: CellContext) => ReactNode;
  /**
   * The cell's text as shown, for the table search (#279), when `value` is not it (an age is a time, shown "5m").
   * Without it a plain search word matches `value` as text, except a number under a `render` (a count drawn as
   * squares, a time drawn as an age), which the cell does not show.
   */
  searchText?: (obj: KubeObject, ctx: SearchTextContext) => string | null | undefined;
  /** `searchText` changes with `ctx.now` (an age): the table matches it again as time passes. */
  searchTextTimed?: boolean;
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

export type ColumnFilterValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean | null | undefined)[];

/**
 * Sidebar sections in Lens order. Pages (`registerPage`) use the same ids in `section`. `gatewayApi`, `certManager` and
 * others belong to APIs and tools installed in the cluster: see `DISCOVERED_SECTIONS`.
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
  "keda",
  "karpenter",
  "vpa",
  "volumeSnapshots",
  "velero",
  "istio",
  "linkerd",
  "traefik",
  "contour",
  "crossplane",
  "kyverno",
  "sealedSecrets",
  "prometheusOperator",
  "clusterApi",
  "k3s",
  "helmController",
  "dra",
  "gpuOperator",
  "kueue",
  "openshift",
  "customResources",
] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

/**
 * Places kept for the sections of Sextant's own extensions (ADR-0162), which were Sextant's sections before 0.30: the
 * section comes where it always was, after the Sextant section named here, whatever its manifest's `after` says.
 */
export const EXTENSION_SECTION_PLACES: readonly (readonly [section: string, after: SidebarSection])[] = [
  ["flux", "velero"],
  ["argocd", "velero"],
  ["argoRollouts", "velero"],
  ["argoWorkflows", "velero"],
  ["knative", "contour"],
  ["knativeEventing", "contour"],
  ["externalSecrets", "kyverno"],
  ["cnpg", "sealedSecrets"],
  ["strimzi", "sealedSecrets"],
  ["jobset", "kueue"],
  ["kuberay", "kueue"],
  ["kserve", "kueue"],
  ["olm", "kueue"],
];

/**
 * Sections of APIs and tools a cluster may or may not have (Gateway API, Flux, Argo CD): their kinds are listed only
 * once discovery says the cluster serves them, never before it comes, so a section without served kinds — the CRDs
 * are not installed — is not drawn at all.
 */
export const DISCOVERED_SECTIONS: ReadonlySet<SidebarSection> = new Set<SidebarSection>([
  "gatewayApi",
  "certManager",
  "trivy",
  "keda",
  "karpenter",
  "vpa",
  "volumeSnapshots",
  "velero",
  "istio",
  "linkerd",
  "traefik",
  "contour",
  "crossplane",
  "kyverno",
  "sealedSecrets",
  "prometheusOperator",
  "clusterApi",
  "k3s",
  "helmController",
  "dra",
  "gpuOperator",
  "kueue",
  "openshift",
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
  keda: "keda",
  karpenter: "karpenter",
  vpa: "vpa",
  volumeSnapshots: "volumeSnapshots",
  velero: "velero",
  istio: "istio",
  linkerd: "linkerd",
  traefik: "traefik",
  contour: "contour",
  crossplane: "crossplane",
  kyverno: "kyverno",
  sealedSecrets: "sealedSecrets",
  prometheusOperator: "prometheusOperator",
  clusterApi: "clusterApi",
  k3s: "k3s",
  helmController: "helmController",
  dra: "dra",
  gpuOperator: "gpuOperator",
  kueue: "kueue",
  openshift: "openshift",
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

/** Actions offered for every kind, after its own and its kind's extra ones (features/views: pin and unpin). */
const actionsForAll = new Set<ActionId>();

/** Offers `ids` for every kind (built-in and custom). Returns a function that removes them again. */
export function extendActionsForAll(ids: readonly ActionId[]): () => void {
  const added = ids.filter((id) => !actionsForAll.has(id));
  for (const id of added) actionsForAll.add(id);
  changed();
  return () => {
    for (const id of added) actionsForAll.delete(id);
    changed();
  };
}

function extensionKey(kind: Pick<KindRef, "group" | "kind">): string {
  return kindKey(kind).toLowerCase();
}

/**
 * Where an extension lists a custom kind (`contributes.kinds`, ADR-0152): a sidebar section of its own instead of
 * "Custom resources", the table's title and the "Only problems" filter from its problem rules. A kind Sextant
 * describes itself (`registerResource`) keeps its own place; of several extensions listing a kind, the first by id.
 */
export interface KindPlacement {
  /** The extension's id: of several, the smallest wins. */
  owner: string;
  section: string;
  sectionTitle?: string;
  /** The plural label and the table's title as shown (never translated by i18next). */
  label?: string;
  icon?: IconName;
  order: number;
  /** Whether an object has a problem of the owner's rules. */
  problem?: (obj: KubeObject) => boolean;
  /** Short names the command palette takes as a kind prefix (ADR-0160). */
  aliases?: readonly string[];
  /** The command palette searches the kind without being asked to. */
  searchByDefault?: boolean;
  /** `false`: the CRD's printer columns are left out of the table (ADR-0161). */
  printerColumns?: boolean;
}

const placements = new Map<string, KindPlacement[]>();

/** Lists a custom kind in an extension's section. Returns a function that removes it again. */
export function placeKind(kind: Pick<KindRef, "group" | "kind">, placement: KindPlacement): () => void {
  const key = extensionKey(kind);
  placements.set(key, [...(placements.get(key) ?? []), placement].sort((a, b) => a.owner.localeCompare(b.owner)));
  changed();
  return () => {
    const list = placements.get(key)?.filter((p) => p !== placement) ?? [];
    if (list.length > 0) placements.set(key, list);
    else placements.delete(key);
    changed();
  };
}

/** Where an extension lists `kind`, unless Sextant describes it itself. */
export function kindPlacement(kind: Pick<KindRef, "group" | "kind">): KindPlacement | undefined {
  if (defs.has(kindKey(kind))) return undefined;
  return placements.get(extensionKey(kind))?.[0];
}

/** An extension's own sidebar section (`contributes.sections`, ADR-0160): its header, icon and place. */
export interface SectionPlacement {
  owner: string;
  title?: string;
  icon?: IconName;
  /** One of Sextant's sections it comes right after. */
  after?: string;
}

const sectionPlacements = new Map<string, SectionPlacement[]>();

/** Describes an extension's own section. Returns a function that removes it again. */
export function placeSection(section: string, placement: SectionPlacement): () => void {
  sectionPlacements.set(section, [...(sectionPlacements.get(section) ?? []), placement].sort((a, b) => a.owner.localeCompare(b.owner)));
  changed();
  return () => {
    const list = sectionPlacements.get(section)?.filter((p) => p !== placement) ?? [];
    if (list.length > 0) sectionPlacements.set(section, list);
    else sectionPlacements.delete(section);
    changed();
  };
}

/** How an extension describes `section`, unless it is one of Sextant's. */
export function sectionPlacement(section: string): SectionPlacement | undefined {
  if ((SIDEBAR_SECTIONS as readonly string[]).includes(section)) return undefined;
  return sectionPlacements.get(section)?.[0];
}

/** The sections extensions list kinds in (a page of one shows only while one of its kinds is served). */
export function placedSections(): ReadonlySet<string> {
  return new Set([...placements.values()].map((list) => list[0]!.section));
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
  const placed = registered ? undefined : kindPlacement(kind);
  // A listed kind whose extension draws its own columns leaves the CRD's printer columns out (ADR-0161).
  const shown = placed?.printerColumns === false && resourceKind ? { ...resourceKind, printerColumns: [] } : resourceKind;
  const generic = registered ? undefined : genericResourceDef(kind, shown ?? null);
  const base: ResourceDef = registered
    ? { ...registered, kind: { ...registered.kind, version: kind.version || registered.kind.version } }
    : placed
      ? { ...generic!, title: placed.label ?? generic!.title, ...(placed.problem ? { problem: placed.problem } : {}) }
      : generic!;
  const key = extensionKey(kind);
  const extra = extensions.get(key);
  const actions = extraActions.get(key);
  let def = base;
  if (extra && extra.size > 0) def = { ...def, columns: placeColumns(base.columns, [...extra.values()].flat()) };
  if (actions && actions.size > 0) {
    const added = [...actions.values()].flat().filter((id) => !base.actions.includes(id));
    def = { ...def, actions: [...base.actions, ...new Set(added)] };
  }
  if (actionsForAll.size > 0) {
    const forAll = [...actionsForAll].filter((id) => !def.actions.includes(id));
    if (forAll.length > 0) def = { ...def, actions: [...def.actions, ...forAll] };
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
