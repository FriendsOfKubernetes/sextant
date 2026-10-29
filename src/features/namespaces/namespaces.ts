// The namespace filter of each cluster: kept in the store (`clusterViews[id].namespaces`, `null` = all) and saved
// as `ClusterSettings.namespaces`, so the choice survives a restart. Every namespace selected is also remembered as a
// known namespace (`known.ts`, #285).
import { useEffect, useState } from "react";
import { updateSettings, type ClusterId } from "../../api";
import { getSettingsSnapshot, useSettingsSelector } from "../../api/settings";
import { useAppStore } from "../../app/store";
import { clusterSettingsOf } from "../clusters/clusterSettings";
import { useClustersStore } from "../clusters/clustersStore";
import { resetAccess, useAccess, useRestrictedScope } from "./accessStore";
import { knownPatch } from "./known";

const restored = new Set<ClusterId>();

/**
 * Selected namespaces of the cluster (`null` = all namespaces), or `undefined` until the saved choice has been
 * read from the settings — wait for it before starting a watch, so the first watch already uses it.
 *
 * "All namespaces" of a user who may not list Namespaces (#285) is the list of accessible known namespaces
 * (`restrictedScope`): every view then watches those instead of one cluster-wide list the API server refuses. While
 * a connected cluster's first access answer is pending (at most `CHECK_WAIT_MS`), "All namespaces" is `undefined` too.
 */
export function useSelectedNamespaces(clusterId: ClusterId): string[] | null | undefined {
  // Restoration needs only the first completed load, not later writes of window layout (including card widths).
  const ready = useSettingsSelector(s => s.settings !== null || s.error !== null);
  const namespaces = useAppStore((s) => s.clusterViews[clusterId]?.namespaces ?? null);
  const connected = useClustersStore((s) => s.states[clusterId]?.state === "connected");
  const access = useAccess(clusterId);
  const scope = useRestrictedScope(clusterId);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!ready) return;
    // Restored by another user of the hook (the sidebar and a table both ask): this one shows it too.
    if (restored.has(clusterId)) {
      setTick((n) => n + 1);
      return;
    }
    restored.add(clusterId);
    const saved = getSettingsSnapshot()?.clusters[clusterId]?.namespaces;
    if (saved && saved.length > 0) useAppStore.getState().setNamespaces(clusterId, saved);
    setTick((n) => n + 1);
  }, [clusterId, ready]);

  if (!restored.has(clusterId)) return undefined;
  if (namespaces !== null) return namespaces;
  if (connected && !access.settled) return undefined;
  return scope;
}

/**
 * Changes the filter of a cluster and saves it (`[]` is the same as `null`: all namespaces); the selected namespaces
 * are remembered as known ones in the same write.
 */
export async function selectNamespaces(clusterId: ClusterId, namespaces: string[] | null): Promise<void> {
  const value = namespaces && namespaces.length > 0 ? [...new Set(namespaces)] : null;
  restored.add(clusterId);
  useAppStore.getState().setNamespaces(clusterId, value);
  await updateSettings((current) => ({
    ...current,
    clusters: {
      ...current.clusters,
      [clusterId]: { ...clusterSettingsOf(current, clusterId), namespaces: value, ...knownPatch(current, clusterId, value ?? []) },
    },
  }));
}

/** Forgets which clusters were restored and every access check (tests). */
export function resetNamespaceRestore(): void {
  restored.clear();
  resetAccess();
}
