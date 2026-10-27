// Known namespaces of a cluster (#285, ADR-0124): every namespace typed or selected in the namespace filter and the
// ones added in the cluster settings ("Accessible namespaces"), saved as `ClusterSettings.knownNamespaces`. They stay
// in the filter when unticked and across restarts; for a user who may not list Namespaces they are what "All
// namespaces" watches (`accessStore.ts`). Read leniently in the core (`settings/known_namespaces.rs`, same rules).
import { useMemo } from "react";
import { updateSettings, useSettings, type AppSettings, type ClusterId, type ClusterSettings } from "../../api";
import { clusterSettingsOf } from "../clusters/clusterSettings";

/** Known namespaces kept per cluster (`MAX_KNOWN_NAMESPACES` in the core). */
export const MAX_KNOWN_NAMESPACES = 200;

const NO_NAMES: readonly string[] = Object.freeze([]);

/** A namespace name: a DNS-1123 label (lowercase letters, digits and `-`, at most 63, alphanumeric at both ends). */
export function isNamespaceName(text: string): boolean {
  return text.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(text);
}

/**
 * `known` with `names` added at the end (namespace names only, no repeats); past `MAX_KNOWN_NAMESPACES` the oldest
 * go. The same array when nothing changes.
 */
export function withKnown(known: readonly string[], names: readonly string[]): readonly string[] {
  const added = [...new Set(names)].filter((n) => isNamespaceName(n) && !known.includes(n));
  if (added.length === 0) return known;
  const next = [...known, ...added];
  return next.length > MAX_KNOWN_NAMESPACES ? next.slice(next.length - MAX_KNOWN_NAMESPACES) : next;
}

/** The known namespaces as saved (namespace names only, no repeats, at most `MAX_KNOWN_NAMESPACES`). */
export function knownOf(settings: AppSettings | null, clusterId: ClusterId): readonly string[] {
  const saved = settings?.clusters[clusterId]?.knownNamespaces;
  return saved && saved.length > 0 ? withKnown(NO_NAMES, saved) : NO_NAMES;
}

/** What `ClusterSettings.knownNamespaces` becomes (`null` for none). */
function stored(names: readonly string[]): ClusterSettings["knownNamespaces"] {
  return names.length > 0 ? [...names] : null;
}

/** The settings patch that also remembers `names` (for one update with the selection). */
export function knownPatch(settings: AppSettings, clusterId: ClusterId, names: readonly string[]): Partial<ClusterSettings> {
  const known = knownOf(settings, clusterId);
  const next = withKnown(known, names);
  return next === known ? {} : { knownNamespaces: stored(next) };
}

/** Remembers `names` as known namespaces of the cluster. */
export async function addKnownNamespaces(clusterId: ClusterId, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  await updateClusterSettingsWith(clusterId, (current) => knownPatch(current, clusterId, names));
}

/** Forgets known namespaces of the cluster. */
export async function forgetKnownNamespaces(clusterId: ClusterId, names: readonly string[]): Promise<void> {
  await updateClusterSettingsWith(clusterId, (current) => {
    const known = knownOf(current, clusterId);
    const next = known.filter((n) => !names.includes(n));
    return next.length === known.length ? {} : { knownNamespaces: stored(next) };
  });
}

/** Merges a patch computed from the current settings (so two quick changes never lose one). */
async function updateClusterSettingsWith(
  clusterId: ClusterId,
  patch: (current: AppSettings) => Partial<ClusterSettings>,
): Promise<void> {
  await updateSettings((current) => {
    const change = patch(current);
    if (Object.keys(change).length === 0) return current;
    return { ...current, clusters: { ...current.clusters, [clusterId]: { ...clusterSettingsOf(current, clusterId), ...change } } };
  });
}

/** The cluster's known namespaces, kept up to date. */
export function useKnownNamespaces(clusterId: ClusterId): readonly string[] {
  const { settings } = useSettings();
  const saved = settings?.clusters[clusterId]?.knownNamespaces;
  return useMemo(() => (saved && saved.length > 0 ? withKnown(NO_NAMES, saved) : NO_NAMES), [saved]);
}
