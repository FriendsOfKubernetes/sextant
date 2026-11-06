// Items extensions add to a cluster's context menu (`contributes.menuItems` with `menu: "cluster"`, ADR-0157): after
// Sextant's own install items, in registration order; each opens the extension's window for that cluster.
import { useSyncExternalStore } from "react";
import type { ClusterId } from "../../api";
import type { IconName } from "../../components";

export interface ClusterMenuItem {
  id: string;
  /** Shown as written (an extension's title, already in the UI language). */
  label: string;
  icon?: IconName;
  run: (clusterId: ClusterId) => void;
}

let items: ClusterMenuItem[] = [];
const listeners = new Set<() => void>();

function changed(next: ClusterMenuItem[]): void {
  items = next;
  for (const listener of [...listeners]) listener();
}

/** Adds an item; returns what removes it. */
export function registerClusterMenuItem(item: ClusterMenuItem): () => void {
  changed([...items.filter((i) => i.id !== item.id), item]);
  return () => changed(items.filter((i) => i !== item));
}

export function useClusterMenuItems(): readonly ClusterMenuItem[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => items,
  );
}
