// Sidebar pages that are not a resource table (cluster overview, events, Helm, port forwarding, settings, pages of
// extensions). A feature calls `registerPage` from its `index.ts`; the sidebar and the main view read the registry and
// re-render when it changes (`usePagesVersion`), so pages registered or removed later show up at once.
import type { ComponentType } from "react";
import type { ClusterId } from "../api";
import type { IconName } from "../components";
import { createRegistryVersion } from "./registryVersion";

export interface PageProps {
  clusterId: ClusterId;
}

export interface PageDef {
  /** Also the `view` value in the store when the page is open. */
  id: string;
  /** Sidebar section the entry belongs to, e.g. "cluster", "workloads", "network", "helm", or a section of its own. */
  section: string;
  /** Header of a section of its own (not one of Sextant's), as shown; without it the section id is shown. */
  sectionTitle?: string;
  /** Position inside the section (ascending). */
  order: number;
  /** i18n key of the sidebar label, e.g. "helm:sidebar.releases". */
  labelKey?: string;
  /** The label as shown (an extension's title), when there is no i18n key. */
  label?: string;
  /** Icon left of the label in the sidebar; without one the sidebar draws `DEFAULT_ENTRY_ICON`. */
  icon?: IconName;
  Component: ComponentType<PageProps>;
}

const pages = new Map<string, PageDef>();
const version = createRegistryVersion();

/** Registers a page; registering the same id again replaces it. */
export function registerPage(def: PageDef): void {
  pages.set(def.id, def);
  version.bump();
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
  if (pages.delete(id)) version.bump();
}

/** Re-renders the caller when pages are registered or removed. */
export function usePagesVersion(): number {
  return version.use();
}
