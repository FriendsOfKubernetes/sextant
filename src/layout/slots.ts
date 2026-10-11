// Places in the window shell that features fill without editing src/layout:
//   "clusterRail" — content of the cluster rail (features/clusters);
//   "welcome"     — the main area when no cluster is active (features/clusters: "No clusters found", etc.);
//   "railFooter"  — the bottom of the cluster rail (features/settings: the Settings button).
import type { ComponentType } from "react";

export type SlotName = "clusterRail" | "welcome" | "railFooter";

const slots = new Map<SlotName, ComponentType>();

export function registerSlot(name: SlotName, Component: ComponentType): void {
  slots.set(name, Component);
}

export function getSlot(name: SlotName): ComponentType | undefined {
  return slots.get(name);
}

export function unregisterSlot(name: SlotName): void {
  slots.delete(name);
}
