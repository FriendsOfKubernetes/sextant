// The namespace filter of each cluster: kept in the store (`clusterViews[id].namespaces`, `null` = all) and saved
// as `ClusterSettings.namespaces`, so the choice survives a restart.
import { useEffect, useState } from "react";
import { useSettings, type ClusterId } from "../../api";
import { useAppStore } from "../../app/store";
import { updateClusterSettings } from "../clusters/clusterSettings";

const restored = new Set<ClusterId>();

/**
 * Selected namespaces of the cluster (`null` = all namespaces), or `undefined` until the saved choice has been
 * read from the settings — wait for it before starting a watch, so the first watch already uses it.
 */
export function useSelectedNamespaces(clusterId: ClusterId): string[] | null | undefined {
  const { settings, error } = useSettings();
  const namespaces = useAppStore((s) => s.clusterViews[clusterId]?.namespaces ?? null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (restored.has(clusterId) || (!settings && !error)) return;
    restored.add(clusterId);
    const saved = settings?.clusters[clusterId]?.namespaces;
    if (saved && saved.length > 0) useAppStore.getState().setNamespaces(clusterId, saved);
    setTick((n) => n + 1);
  }, [clusterId, settings, error]);

  return restored.has(clusterId) ? namespaces : undefined;
}

/** Changes the filter of a cluster and saves it (`[]` is the same as `null`: all namespaces). */
export async function selectNamespaces(clusterId: ClusterId, namespaces: string[] | null): Promise<void> {
  const value = namespaces && namespaces.length > 0 ? [...new Set(namespaces)] : null;
  restored.add(clusterId);
  useAppStore.getState().setNamespaces(clusterId, value);
  await updateClusterSettings(clusterId, { namespaces: value });
}

/** Forgets which clusters were restored (tests). */
export function resetNamespaceRestore(): void {
  restored.clear();
}
