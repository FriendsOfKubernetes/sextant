// Dock tabs and dock header buttons are registered by features, not listed in the dock.
import type { ComponentType } from "react";
import type { ClusterId } from "../../api";
import type { DockTab, DockTabType } from "../../app/store";
import type { IconName } from "../../components/icons";

export interface DockTabProps {
  tab: DockTab;
  /** Whether this tab is the visible one (inactive tabs stay mounted to keep their sessions). */
  active: boolean;
}

const tabComponents = new Map<DockTabType, ComponentType<DockTabProps>>();

/** The component that renders every dock tab of `type` (e.g. "logs" → the log viewer). */
export function registerDockTab(type: DockTabType, Component: ComponentType<DockTabProps>): void {
  tabComponents.set(type, Component);
}

export function getDockTabComponent(type: DockTabType): ComponentType<DockTabProps> | undefined {
  return tabComponents.get(type);
}

export function unregisterDockTab(type: DockTabType): void {
  tabComponents.delete(type);
}

export interface DockActionContext {
  activeClusterId: ClusterId | null;
}

/** A button in the dock header, e.g. the "add" icon (create resource) or "Terminal". */
export interface DockActionDef {
  id: string;
  order: number;
  /** i18n key of the button label / tooltip. */
  labelKey: string;
  /** Icon shown on the button instead of the label (an `IconName` of the set such as "add"), if any. */
  icon?: IconName;
  /** Hidden when it returns false (e.g. a terminal needs an active cluster). */
  available?: (ctx: DockActionContext) => boolean;
  run: (ctx: DockActionContext) => void;
}

const actions = new Map<string, DockActionDef>();

export function registerDockAction(def: DockActionDef): void {
  actions.set(def.id, def);
}

export function getDockActions(): DockActionDef[] {
  return [...actions.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function unregisterDockAction(id: string): void {
  actions.delete(id);
}
