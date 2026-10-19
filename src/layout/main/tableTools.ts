// Controls a feature adds to the header of the main kind table (features/views: "Save view", "Pin"), without
// editing src/layout. Each gets the cluster and the open view id (`viewIdOf(kind)`).
import type { ComponentType } from "react";
import type { ClusterId } from "../../api";
import { createRegistryVersion } from "../registryVersion";

export interface TableToolProps {
  clusterId: ClusterId;
  view: string;
}

const tools: { id: string; Component: ComponentType<TableToolProps> }[] = [];
const version = createRegistryVersion();

/** Adds (or replaces, by `id`) a control of the table header. */
export function registerTableTool(id: string, Component: ComponentType<TableToolProps>): void {
  const index = tools.findIndex((t) => t.id === id);
  if (index >= 0) tools[index] = { id, Component };
  else tools.push({ id, Component });
  version.bump();
}

export function getTableTools(): readonly { id: string; Component: ComponentType<TableToolProps> }[] {
  return tools;
}

export function useTableToolsVersion(): number {
  return version.use();
}
