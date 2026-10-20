// Sections of the cluster settings dialog. Features add their own (e.g. metrics adds Prometheus settings)
// from their `index.ts` without editing the dialog.
//
// The dialog shows one tab per group of sections (#230): a section names its tab with `tab`; a section without one,
// or with a tab nobody registered, goes to "More", so a section of another feature always appears somewhere. A tab
// without sections is not shown. Built-in tabs are below; a feature may add its own with
// `registerClusterSettingsTab`.
import type { ComponentType } from "react";
import type { ClusterId, ClusterInfo } from "../../api";

export interface ClusterSettingsSectionProps {
  clusterId: ClusterId;
  cluster: ClusterInfo;
}

export interface ClusterSettingsSectionDef {
  id: string;
  /** Position in its tab (ascending). */
  order: number;
  /** i18n key of the section heading (shown when its tab holds several sections) and of its region's name. */
  titleKey?: string;
  /** Id of the tab the section is drawn in; default (and for an unknown id) `MORE_TAB`. */
  tab?: string;
  Component: ComponentType<ClusterSettingsSectionProps>;
}

export interface ClusterSettingsTabDef {
  id: string;
  /** Position in the tab list (ascending). */
  order: number;
  /** i18n key of the tab's label. */
  labelKey: string;
}

export interface ClusterSettingsTab extends ClusterSettingsTabDef {
  sections: ClusterSettingsSectionDef[];
}

/** The tab of sections that name no tab (or a tab that is not registered). */
export const MORE_TAB = "more";

/**
 * Built-in tabs. "Connection" holds where the context comes from (server, user, kubeconfig file) and is the place for
 * more about the connection, e.g. viewing the kubeconfig entry.
 */
const BUILT_IN_TABS: ClusterSettingsTabDef[] = [
  { id: "general", order: 0, labelKey: "clustersettings:tabs.general" },
  { id: "connection", order: 10, labelKey: "clustersettings:tabs.connection" },
  { id: "metrics", order: 20, labelKey: "clustersettings:tabs.metrics" },
  { id: "agentAccess", order: 30, labelKey: "clustersettings:tabs.agentAccess" },
  { id: "safeApply", order: 35, labelKey: "clustersettings:tabs.safeApply" },
  { id: "gitops", order: 40, labelKey: "clustersettings:tabs.gitops" },
  { id: MORE_TAB, order: 1000, labelKey: "clustersettings:tabs.more" },
];

const sections = new Map<string, ClusterSettingsSectionDef>();
const tabs = new Map<string, ClusterSettingsTabDef>(BUILT_IN_TABS.map((tab) => [tab.id, tab]));

/** Registers a section; registering the same id again replaces it. */
export function registerClusterSettingsSection(def: ClusterSettingsSectionDef): void {
  sections.set(def.id, def);
}

export function unregisterClusterSettingsSection(id: string): void {
  sections.delete(id);
}

/** Registers a tab; registering the same id again replaces it. */
export function registerClusterSettingsTab(def: ClusterSettingsTabDef): void {
  tabs.set(def.id, def);
}

/** Removes a tab a feature added; built-in tabs stay. */
export function unregisterClusterSettingsTab(id: string): void {
  if (!BUILT_IN_TABS.some((tab) => tab.id === id)) tabs.delete(id);
}

function bySectionOrder(a: ClusterSettingsSectionDef, b: ClusterSettingsSectionDef): number {
  return a.order - b.order || a.id.localeCompare(b.id);
}

/** All sections in order (of their tabs, then their own). */
export function getClusterSettingsSections(): ClusterSettingsSectionDef[] {
  return getClusterSettingsTabs().flatMap((tab) => tab.sections);
}

/** The tab a section is drawn in. */
function tabIdOf(def: ClusterSettingsSectionDef): string {
  return def.tab !== undefined && tabs.has(def.tab) ? def.tab : MORE_TAB;
}

/** The tabs that hold at least one section, in order, each with its sections in order. */
export function getClusterSettingsTabs(): ClusterSettingsTab[] {
  const grouped = new Map<string, ClusterSettingsSectionDef[]>();
  for (const def of sections.values()) {
    const id = tabIdOf(def);
    grouped.set(id, [...(grouped.get(id) ?? []), def]);
  }
  return [...tabs.values()]
    .filter((tab) => grouped.has(tab.id))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((tab) => ({ ...tab, sections: (grouped.get(tab.id) ?? []).sort(bySectionOrder) }));
}

/** The id of the tab that shows the section `sectionId`, or null for an unknown section. */
export function tabOfSection(sectionId: string): string | null {
  const def = sections.get(sectionId);
  return def ? tabIdOf(def) : null;
}
