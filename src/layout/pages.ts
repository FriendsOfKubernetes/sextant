// Sidebar pages that are not a resource table (cluster overview, events, Helm, port forwarding, settings).
// A feature calls `registerPage` from its `index.ts`; the sidebar and the main view read the registry.
import type { ComponentType } from "react";
import type { ClusterId } from "../api";
import type { IconName } from "../components";

export interface PageProps {
  clusterId: ClusterId;
}

export interface PageDef {
  /** Also the `view` value in the store when the page is open. */
  id: string;
  /** Sidebar section the entry belongs to, e.g. "cluster", "workloads", "network", "helm", "app". */
  section: string;
  /** Position inside the section (ascending). */
  order: number;
  /** i18n key of the sidebar label, e.g. "helm:sidebar.releases". */
  labelKey: string;
  /** Icon left of the label in the sidebar; without one the sidebar draws `DEFAULT_ENTRY_ICON`. */
  icon?: IconName;
  Component: ComponentType<PageProps>;
}

const pages = new Map<string, PageDef>();

/** Registers a page; registering the same id again replaces it. */
export function registerPage(def: PageDef): void {
  pages.set(def.id, def);
}

export function getPage(id: string): PageDef | undefined {
  return pages.get(id);
}

/** All pages, by section and then by order. */
export function getPages(section?: string): PageDef[] {
  return [...pages.values()]
    .filter((p) => section === undefined || p.section === section)
    .sort((a, b) => a.section.localeCompare(b.section) || a.order - b.order || a.id.localeCompare(b.id));
}

export function unregisterPage(id: string): void {
  pages.delete(id);
}
