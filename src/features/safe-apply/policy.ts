// "Preview changes before applying" (#141): whether a cluster asks for the server's dry run before a change is sent.
// Stored per cluster as `clusters[id].previewChanges` (written here only): `true`/`false` once the user chose,
// `null` (the default) to follow the cluster's name.
import { useSettings, type AppSettings, type ClusterId, type ClusterInfo } from "../../api";
import { useClustersStore } from "../clusters/clustersStore";

/**
 * A production-looking name: "prod" or "production" as a word of its own — between separators, digits or the ends
 * ("rees46-prod", "eks_production", "prod1", "gke_acme_europe-west1_prod-eu"), not inside another word ("products",
 * "preprod", "reproduce"). Simpler than a list of environments, and the user overrides it either way.
 */
const PRODUCTION_WORD = /(^|[^a-z])prod(uction)?([^a-z]|$)/i;

/** Whether any of the names (display name, context, the kubeconfig's cluster name) looks like production. */
export function previewByDefault(names: readonly (string | null | undefined)[]): boolean {
  return names.some((name) => typeof name === "string" && PRODUCTION_WORD.test(name));
}

/** The names a cluster is known by, for {@link previewByDefault}. */
export function namesOf(cluster: ClusterInfo | undefined, settings: AppSettings | null): string[] {
  if (!cluster) return [];
  const display = settings?.clusters[cluster.id]?.displayName ?? "";
  return [display, cluster.context, cluster.clusterName].filter((n) => n !== "");
}

/** Whether changes to the cluster are previewed before they are sent: the user's choice, else the name rule. */
export function previewsChanges(
  clusterId: ClusterId,
  cluster: ClusterInfo | undefined,
  settings: AppSettings | null,
): boolean {
  const chosen = settings?.clusters[clusterId]?.previewChanges;
  if (typeof chosen === "boolean") return chosen;
  return previewByDefault(namesOf(cluster, settings));
}

/** {@link previewsChanges} for a cluster, following the settings and the cluster list. */
export function useAlwaysPreview(clusterId: ClusterId): boolean {
  const { settings } = useSettings();
  const cluster = useClustersStore((s) => s.clusters.find((c) => c.id === clusterId));
  return previewsChanges(clusterId, cluster, settings);
}
