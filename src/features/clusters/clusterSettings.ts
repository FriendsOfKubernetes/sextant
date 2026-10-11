// Per-cluster settings (`AppSettings.clusters[clusterId]`) owned by this feature: display name, color, last view.
import { updateSettings, type AppSettings, type ClusterId, type ClusterInfo, type ClusterSettings } from "../../api";

/** Same defaults as `ClusterSettings::default()` in Rust. */
export function defaultClusterSettings(): ClusterSettings {
  return {
    displayName: null,
    color: null,
    namespaces: null,
    lastView: null,
    prometheus: { mode: "auto" },
    usageSource: "auto",
  };
}

export function clusterSettingsOf(settings: AppSettings | null, id: ClusterId): ClusterSettings {
  return { ...defaultClusterSettings(), ...settings?.clusters[id] };
}

/** Merges `patch` into the cluster's settings and saves them. */
export function updateClusterSettings(id: ClusterId, patch: Partial<ClusterSettings>): Promise<AppSettings> {
  return updateSettings((current) => ({
    ...current,
    clusters: { ...current.clusters, [id]: { ...clusterSettingsOf(current, id), ...patch } },
  }));
}

/** The name shown in the rail: the user's display name, else the context name. */
export function displayNameOf(cluster: ClusterInfo, settings: AppSettings | null): string {
  const name = settings?.clusters[cluster.id]?.displayName?.trim();
  return name || cluster.context;
}

/** Label colors offered in the cluster settings. */
export const CLUSTER_COLORS = ["#3d90ce", "#48a868", "#d6a01e", "#e0703a", "#ce3933", "#a05ad0", "#2aa3a3", "#7a8590"];

/** Color of the rail icon: the chosen one, else a stable color derived from the id. */
export function colorOf(cluster: ClusterInfo, settings: AppSettings | null): string {
  const chosen = settings?.clusters[cluster.id]?.color;
  if (chosen) return chosen;
  let hash = 0;
  for (const ch of cluster.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return CLUSTER_COLORS[hash % CLUSTER_COLORS.length] ?? CLUSTER_COLORS[0]!;
}

/** Up to two letters for the rail icon: "kind-sextant-test" → "KS", "prod" → "PR". */
export function initialsOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? name).slice(0, 2).toUpperCase();
}
