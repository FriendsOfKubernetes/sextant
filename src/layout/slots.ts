// Places in the window shell that features fill without editing src/layout:
//   "clusterRail" — content of the cluster rail (features/clusters);
//   "welcome"     — the main area when no cluster is active (features/clusters: "No clusters found", etc.);
//   "railFooter"  — the bottom of the cluster rail (features/settings: the Settings button; features/mcp: the agent
//                   activity button);
//   "home"        — the main area when no cluster is active and a window-wide page is open (`useAppStore().homeView`;
//                   features/fleet: the overview of several clusters).
// Several features may fill one slot: their components are drawn one after another, by `order`. Registering the same
// component again only changes its order.
import { createElement, Fragment, type ComponentType } from "react";
import { createRegistryVersion } from "./registryVersion";

export type SlotName = "clusterRail" | "welcome" | "railFooter" | "home";

interface SlotEntry {
  Component: ComponentType;
  order: number;
  /** Registration sequence: equal orders keep the order of registration. */
  seq: number;
}

const slots = new Map<SlotName, SlotEntry[]>();
const composed = new Map<SlotName, ComponentType>();
const version = createRegistryVersion();
let seq = 0;

/** Adds `Component` to the slot (`order` ascending, default 0). */
export function registerSlot(name: SlotName, Component: ComponentType, order = 0): void {
  const entries = (slots.get(name) ?? []).filter((e) => e.Component !== Component);
  entries.push({ Component, order, seq: ++seq });
  entries.sort((a, b) => a.order - b.order || a.seq - b.seq);
  slots.set(name, entries);
  composed.delete(name);
  version.bump();
}

/** One component that draws everything registered for the slot; `undefined` when the slot is empty. */
export function getSlot(name: SlotName): ComponentType | undefined {
  const entries = slots.get(name);
  if (!entries || entries.length === 0) return undefined;
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only) return only.Component;
  let Slot = composed.get(name);
  if (!Slot) {
    const list = entries.map((e) => e.Component);
    Slot = function SlotContent() {
      return createElement(Fragment, null, ...list.map((C, i) => createElement(C, { key: i })));
    };
    composed.set(name, Slot);
  }
  return Slot;
}

/** Removes `Component` from the slot, or everything in it when no component is named. */
export function unregisterSlot(name: SlotName, Component?: ComponentType): void {
  const entries = slots.get(name);
  if (!entries) return;
  const left = Component ? entries.filter((e) => e.Component !== Component) : [];
  if (left.length === entries.length) return;
  if (left.length === 0) slots.delete(name);
  else slots.set(name, left);
  composed.delete(name);
  version.bump();
}

/** Re-renders the caller when slots change. */
export function useSlotsVersion(): number {
  return version.use();
}
