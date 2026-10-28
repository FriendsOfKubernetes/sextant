// Dock tabs and dock header buttons are registered by features, not listed in the dock. The dock re-renders when
// they change (`useDockVersion`).
import { useEffect, type ComponentType } from "react";
import type { ClusterId } from "../../api";
import type { DockTab, DockTabType } from "../../app/store";
import type { IconName } from "../../components/icons";
import { createRegistryVersion } from "../registryVersion";

export interface DockTabProps {
  tab: DockTab;
  /** Whether this tab is the visible one (inactive tabs stay mounted to keep their sessions). */
  active: boolean;
}

const tabComponents = new Map<DockTabType, ComponentType<DockTabProps>>();
const version = createRegistryVersion();

/** The component that renders every dock tab of `type` (e.g. "logs" → the log viewer). */
export function registerDockTab(type: DockTabType, Component: ComponentType<DockTabProps>): void {
  tabComponents.set(type, Component);
  version.bump();
}

export function getDockTabComponent(type: DockTabType): ComponentType<DockTabProps> | undefined {
  return tabComponents.get(type);
}

export function unregisterDockTab(type: DockTabType): void {
  if (tabComponents.delete(type)) version.bump();
}

export interface DockActionContext {
  activeClusterId: ClusterId | null;
}

/** A button in the dock header, e.g. the "add" icon (create resource) or "Terminal". */
export interface DockActionDef {
  id: string;
  order: number;
  /** i18n key of the button label / tooltip. */
  labelKey?: string;
  /** The label as shown (an extension's title), when there is no i18n key. */
  label?: string;
  /** Icon shown on the button instead of the label (an `IconName` of the set such as "add"), if any. */
  icon?: IconName;
  /** Hidden when it returns false (e.g. a terminal needs an active cluster). */
  available?: (ctx: DockActionContext) => boolean;
  run: (ctx: DockActionContext) => void;
}

const actions = new Map<string, DockActionDef>();

export function registerDockAction(def: DockActionDef): void {
  actions.set(def.id, def);
  version.bump();
}

export function getDockActions(): DockActionDef[] {
  return [...actions.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function unregisterDockAction(id: string): void {
  if (actions.delete(id)) version.bump();
}

/** Re-renders the caller when dock tabs or buttons are registered or removed. */
export function useDockVersion(): number {
  return version.use();
}

// Tabs whose content would be lost on close (an editor with unsaved text): the dock asks before closing them, whether
// by the close button, Delete, Cmd+W or Ctrl+W.
const unsavedTabs = new Set<string>();

/** Marks tab `tabId` as holding unsaved changes while `unsaved` is true (and the calling component is mounted). */
export function useUnsavedChanges(tabId: string, unsaved: boolean): void {
  useEffect(() => {
    if (!unsaved) return;
    unsavedTabs.add(tabId);
    return () => {
      unsavedTabs.delete(tabId);
    };
  }, [tabId, unsaved]);
}

export function hasUnsavedChanges(tabId: string): boolean {
  return unsavedTabs.has(tabId);
}
