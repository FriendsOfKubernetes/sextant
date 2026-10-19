// What the palette offers: places to go (sections and pages of the active cluster, Settings tabs, clusters) and the
// objects found by name, grouped by kind. Built from the registries Sextant already has — the resource registry, the
// pages registry, Settings' tabs and the clusters store — so pages and actions of extensions come in the same way.
import type { TFunction } from "i18next";
import type { AppSettings, ClusterId, ClusterInfo, ConnectionState, KindRef, KubeObject, ResourceKind } from "../../api";
import { useAppStore } from "../../app/store";
import type { IconName } from "../../components";
import { getPages } from "../../layout/pages";
import {
  customResourceKinds,
  findKind,
  findResourceDef,
  getResourceDef,
  getResourceDefs,
  kindKey,
  viewIdOf,
  type ResourceDef,
  type SidebarSection,
} from "../../resources";
import { DEFAULT_ENTRY_ICON, DISCOVERED_SECTIONS, SECTION_ICONS } from "../../resources/registry";
import { displayNameOf } from "../clusters/clusterSettings";
import { selectCluster } from "../clusters/clustersStore";
import { SETTINGS_PAGE_ID } from "../settings/constants";
import { openSettings, SETTINGS_TABS } from "../settings/store";
import { containsScore, fuzzyScore } from "./fuzzy";
import type { IndexedKind, KindQuery } from "./objectIndex";
import type { RecentEntry, RecentObject } from "./store";

/** An object the palette can open or act on. */
export interface ObjectTarget extends RecentObject {
  resourceKind: ResourceKind | null;
  /** Its metadata, when it came from the search (for its status before the whole object is read). */
  meta?: KubeObject;
}

export interface PaletteItem {
  /** Unique among the items a group shows; also the key of the recent entry. */
  key: string;
  label: string;
  /** Shown after the label, muted: the namespace of an object, the section of a page, the state of a cluster. */
  detail?: string;
  icon?: IconName;
  danger?: boolean;
  /** Enter. */
  run?: () => void;
  /** Running it keeps the palette open (and is not remembered). */
  stay?: boolean;
  /** An object: Tab shows its actions. */
  object?: ObjectTarget;
  /** What is remembered among the recent items when the item is chosen. */
  recent?: RecentEntry;
  /** Match score (higher first); 0 without a query. */
  score: number;
}

export interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}

/** Objects shown at most, over all kinds, and per kind. */
export const MAX_OBJECT_RESULTS = 50;
export const MAX_RESULTS_PER_KIND = 8;

export function objectKey(target: RecentObject): string {
  return `object:${target.clusterId}:${kindKey(target.kind)}:${target.namespace ?? ""}/${target.name}`;
}

export function objectItem(target: ObjectTarget, score = 0): PaletteItem {
  const key = objectKey(target);
  const { clusterId, kind, namespace, name } = target;
  return {
    key,
    label: name,
    detail: namespace ?? undefined,
    icon: iconOfKind(kind),
    object: target,
    run: () => useAppStore.getState().openDetails({ kind, namespace, name }),
    recent: { key, object: { clusterId, kind, namespace, name } },
    score,
  };
}

/** The title of a kind as the sidebar shows it ("Pods"); the kind's name for custom resources. */
export function kindTitle(t: TFunction, kind: KindRef, resourceKind: ResourceKind | null): string {
  const def = findResourceDef(kind);
  if (def?.sidebar) return t(def.sidebar.labelKey);
  return getResourceDef(kind, resourceKind).title ?? kind.kind;
}

function iconOfKind(kind: Pick<KindRef, "group" | "kind">): IconName {
  return findResourceDef(kind)?.sidebar?.icon ?? DEFAULT_ENTRY_ICON;
}

function sectionLabel(t: TFunction, section: string, title?: string): string {
  return t(`resources:sections.${section}`, { defaultValue: title ?? section });
}

function sectionIcon(section: string): IconName | undefined {
  return (SECTION_ICONS as Record<string, IconName | undefined>)[section];
}

/** Opens a section of the active cluster, as its sidebar entry does. */
function goTo(clusterId: ClusterId, view: string): void {
  const app = useAppStore.getState();
  if ((app.clusterViews[clusterId]?.view ?? null) !== view) app.setSearch(clusterId, "");
  app.setView(clusterId, view);
}

/** Groups another feature adds after "Go to" (features/views: saved views and pins). */
export type NavigationProvider = (input: NavigationInput) => PaletteGroup[];
const providers = new Map<string, NavigationProvider>();

/** Adds (or replaces, by `id`) a provider of palette groups. */
export function registerNavigationProvider(id: string, provider: NavigationProvider): void {
  providers.set(id, provider);
}

export interface NavigationInput {
  t: TFunction;
  clusterId: ClusterId | null;
  kinds: ResourceKind[] | null;
  clusters: ClusterInfo[];
  states: Record<ClusterId, ConnectionState>;
  settings: AppSettings | null;
}

/**
 * The places to go, by group: the sections and pages of the active cluster (the sidebar's entries, under the same
 * rules: kinds the cluster serves, pages of installed tools only with the tool), the clusters, and Settings' tabs.
 */
export function navigationGroups({ t, clusterId, kinds, clusters, states, settings }: NavigationInput): PaletteGroup[] {
  const groups: PaletteGroup[] = [];
  if (clusterId) {
    const items: PaletteItem[] = [];
    const served = new Set<string>();
    for (const def of getResourceDefs()) {
      if (!def.sidebar) continue;
      if (kinds ? !findKind(kinds, def.kind) : DISCOVERED_SECTIONS.has(def.sidebar.section)) continue;
      served.add(def.sidebar.section);
      items.push(viewItem(clusterId, def, t));
    }
    for (const page of getPages()) {
      if (page.id === SETTINGS_PAGE_ID) continue;
      if (DISCOVERED_SECTIONS.has(page.section as SidebarSection) && !served.has(page.section)) continue;
      const key = `page:${page.id}`;
      items.push({
        key,
        label: page.labelKey ? t(page.labelKey) : (page.label ?? page.id),
        detail: sectionLabel(t, page.section, page.sectionTitle),
        icon: page.icon ?? sectionIcon(page.section) ?? DEFAULT_ENTRY_ICON,
        run: () => goTo(clusterId, page.id),
        recent: { key },
        score: 0,
      });
    }
    for (const rk of customResourceKinds(kinds)) {
      const { group, kind } = rk.kindRef;
      if (findResourceDef({ group, kind })) continue;
      const view = viewIdOf({ group, kind });
      const key = `kind:${view}`;
      if (items.some((i) => i.key === key)) continue;
      items.push({
        key,
        label: kind,
        detail: group,
        icon: "customResource",
        run: () => goTo(clusterId, view),
        recent: { key },
        score: 0,
      });
    }
    groups.push({ id: "goTo", label: t("palette:groups.goTo"), items });
  }
  for (const provide of providers.values()) {
    try {
      groups.push(...provide({ t, clusterId, kinds, clusters, states, settings }).filter((g) => g.items.length > 0));
    } catch {
      // A provider's failure never empties the palette.
    }
  }

  groups.push({
    id: "clusters",
    label: t("palette:groups.clusters"),
    items: clusters.map((cluster) => {
      const key = `cluster:${cluster.id}`;
      const state = states[cluster.id]?.state ?? "disconnected";
      const detail =
        cluster.id === clusterId
          ? t("palette:cluster.current")
          : state === "connected"
            ? t("palette:cluster.switch")
            : t("palette:cluster.connect");
      return {
        key,
        label: displayNameOf(cluster, settings),
        detail,
        icon: "cluster",
        run: () => selectCluster(cluster.id),
        recent: { key },
        score: 0,
      };
    }),
  });

  groups.push({
    id: "settings",
    label: t("palette:groups.settings"),
    items: SETTINGS_TABS.map((tab) => {
      const key = `settings:${tab}`;
      return {
        key,
        label: t("palette:settingsTab", { tab: t(`settings:tabs.${tab}`) }),
        icon: "settings",
        run: () => openSettings({ tab }),
        recent: { key },
        score: 0,
      };
    }),
  });
  return groups;
}

function viewItem(clusterId: ClusterId, def: ResourceDef, t: TFunction): PaletteItem {
  const view = viewIdOf(def.kind);
  const key = `kind:${view}`;
  return {
    key,
    label: t(def.sidebar!.labelKey),
    detail: sectionLabel(t, def.sidebar!.section),
    icon: def.sidebar!.icon ?? DEFAULT_ENTRY_ICON,
    run: () => goTo(clusterId, view),
    recent: { key },
    score: 0,
  };
}

/** Items of `groups` that match `query` (the whole query against the label, or as a substring of the detail). */
export function filterGroups(groups: PaletteGroup[], query: string, recentKeys: ReadonlySet<string>): PaletteGroup[] {
  const q = query.trim();
  return groups
    .map((group) => {
      const items: PaletteItem[] = [];
      for (const item of group.items) {
        const byLabel = fuzzyScore(q, item.label);
        const byDetail = item.detail ? containsScore(q, item.detail) : null;
        const best = Math.max(byLabel ?? -Infinity, byDetail === null ? -Infinity : byDetail / 2);
        if (best === -Infinity) continue;
        // Something chosen lately wins a tie.
        items.push({ ...item, score: best + (recentKeys.has(item.key) ? 50 : 0) });
      }
      items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
      return { ...group, items };
    })
    .filter((g) => g.items.length > 0);
}

/**
 * Objects of the index that match `query` (`parseKindQuery`: a kind it names, and the words left), grouped by kind
 * (best groups first), at most `MAX_RESULTS_PER_KIND` per kind and `MAX_OBJECT_RESULTS` in all. Every word has to
 * match the name (scattered characters in order are enough) or the namespace (as a substring). A query that names a
 * kind searches only that kind, up to `MAX_OBJECT_RESULTS`; with no words left (`crd:`) it lists the kind by name.
 */
export function objectGroups(t: TFunction, clusterId: ClusterId, index: IndexedKind[], query: KindQuery): PaletteGroup[] {
  const { kind: only, words } = query;
  if (!only && words.length === 0) return [];
  const perKind = only ? MAX_OBJECT_RESULTS : MAX_RESULTS_PER_KIND;
  const groups: PaletteGroup[] = [];
  for (const indexed of index) {
    const { kind, resourceKind } = indexed;
    if (only && kindKey(only.kind) !== kindKey(kind)) continue;
    if (indexed.state.items.size === 0) continue;
    const hits: PaletteItem[] = [];
    for (const obj of indexed.state.items.values()) {
      const name = obj.metadata?.name ?? "";
      const namespace = obj.metadata?.namespace ?? null;
      let total = 0;
      let matched = true;
      for (const word of words) {
        const byName = fuzzyScore(word, name);
        const byNamespace = namespace ? containsScore(word, namespace) : null;
        const best = Math.max(byName ?? -Infinity, byNamespace === null ? -Infinity : byNamespace / 2);
        if (best === -Infinity) {
          matched = false;
          break;
        }
        total += best;
      }
      if (!matched) continue;
      const score = words.length > 0 ? total / words.length : 0;
      hits.push(objectItem({ clusterId, kind, namespace, name, resourceKind, meta: obj }, score));
    }
    if (hits.length === 0) continue;
    hits.sort(
      (a, b) => b.score - a.score || a.label.localeCompare(b.label) || (a.detail ?? "").localeCompare(b.detail ?? ""),
    );
    groups.push({ id: `kind:${kindKey(kind)}`, label: kindTitle(t, kind, resourceKind), items: hits.slice(0, perKind) });
  }
  groups.sort((a, b) => (b.items[0]?.score ?? 0) - (a.items[0]?.score ?? 0) || a.label.localeCompare(b.label));
  let left = MAX_OBJECT_RESULTS;
  const capped: PaletteGroup[] = [];
  for (const group of groups) {
    if (left <= 0) break;
    const items = group.items.slice(0, left);
    left -= items.length;
    capped.push({ ...group, items });
  }
  return capped;
}

/** The status of an object being deleted, as kubectl shows it. */
export const TERMINATING = "Terminating";

/** What a status of an object reads: "Terminating", else its kind's status (or conditions, or ready pods) column. */
export function statusOf(obj: KubeObject, kind: KindRef, resourceKind: ResourceKind | null): string | undefined {
  if (obj.metadata?.deletionTimestamp) return TERMINATING;
  const def = getResourceDef(kind, resourceKind);
  for (const id of ["status", "conditions", "pods"]) {
    const column = def.columns.find((c) => c.id === id);
    if (!column) continue;
    let value: unknown;
    try {
      value = column.value(obj);
    } catch {
      continue;
    }
    if ((typeof value === "string" && value !== "") || typeof value === "number") return String(value);
  }
  return undefined;
}
