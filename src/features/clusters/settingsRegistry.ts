// Sections of the cluster settings dialog. Features add their own (e.g. metrics adds Prometheus settings)
// from their `index.ts` without editing the dialog.
import type { ComponentType } from "react";
import type { ClusterId, ClusterInfo } from "../../api";

export interface ClusterSettingsSectionProps {
  clusterId: ClusterId;
  cluster: ClusterInfo;
}

export interface ClusterSettingsSectionDef {
  id: string;
  /** Position in the dialog (ascending). */
  order: number;
  /** i18n key of the section heading; no heading when omitted. */
  titleKey?: string;
  Component: ComponentType<ClusterSettingsSectionProps>;
}

const sections = new Map<string, ClusterSettingsSectionDef>();

/** Registers a section; registering the same id again replaces it. */
export function registerClusterSettingsSection(def: ClusterSettingsSectionDef): void {
  sections.set(def.id, def);
}

export function unregisterClusterSettingsSection(id: string): void {
  sections.delete(id);
}

/** All sections in order. */
export function getClusterSettingsSections(): ClusterSettingsSectionDef[] {
  return [...sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
