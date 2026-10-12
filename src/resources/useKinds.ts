// Discovery of a cluster (`api.clusters.kinds`), fetched once per cluster and shared by every caller.
import { useEffect, useSyncExternalStore } from "react";
import { api, toApiError, type ApiError, type ClusterId, type KindRef, type ResourceKind } from "../api";
import { forgetCrdPrinterColumns } from "./crdColumns";

export interface ClusterKinds {
  kinds: ResourceKind[] | null;
  error: ApiError | null;
}

const EMPTY: ClusterKinds = Object.freeze({ kinds: null, error: null }) as ClusterKinds;
const cache = new Map<ClusterId, ClusterKinds>();
const inflight = new Set<ClusterId>();
/** Bumped by every refresh: an answer to an older request is dropped. */
const generations = new Map<ClusterId, number>();
const listeners = new Set<() => void>();

function set(clusterId: ClusterId, value: ClusterKinds): void {
  cache.set(clusterId, value);
  for (const fn of listeners) fn();
}

/** Loads (once) the kinds the cluster serves. `refreshClusterKinds` reloads them (the clusters store calls it on
 * every connect). */
export function loadClusterKinds(clusterId: ClusterId): void {
  if (inflight.has(clusterId) || cache.get(clusterId)?.kinds) return;
  inflight.add(clusterId);
  const generation = generations.get(clusterId) ?? 0;
  const current = () => (generations.get(clusterId) ?? 0) === generation;
  api.clusters.kinds(clusterId).then(
    (kinds) => {
      if (!current()) return;
      inflight.delete(clusterId);
      set(clusterId, { kinds, error: null });
    },
    (err: unknown) => {
      if (!current()) return;
      inflight.delete(clusterId);
      set(clusterId, { kinds: null, error: toApiError(err) });
    },
  );
}

/**
 * Forgets what is known about the cluster's kinds (a new connection may serve other kinds, e.g. a CRD created
 * since) and loads them again when anything was loaded or loading; otherwise the first user loads them.
 */
export function refreshClusterKinds(clusterId: ClusterId): void {
  if (!cache.has(clusterId) && !inflight.has(clusterId)) return;
  generations.set(clusterId, (generations.get(clusterId) ?? 0) + 1);
  inflight.delete(clusterId);
  cache.delete(clusterId);
  forgetCrdPrinterColumns(clusterId);
  loadClusterKinds(clusterId);
}

/** Forgets every cluster (tests). */
export function resetClusterKinds(): void {
  cache.clear();
  inflight.clear();
  generations.clear();
  forgetCrdPrinterColumns();
  for (const fn of listeners) fn();
}

export function useClusterKinds(clusterId: ClusterId | null): ClusterKinds {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => (clusterId ? (cache.get(clusterId) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
  useEffect(() => {
    if (clusterId) loadClusterKinds(clusterId);
  }, [clusterId]);
  return value;
}

/** The discovered kind for `group`/`kind` (preferred version), if the cluster serves it. */
export function findKind(kinds: ResourceKind[] | null, ref: Pick<KindRef, "group" | "kind">): ResourceKind | undefined {
  return kinds?.find((k) => k.kindRef.group === ref.group && k.kindRef.kind === ref.kind);
}

/**
 * API groups of Kubernetes itself (and its aggregated metrics APIs). Kinds of any other group are custom resources —
 * also CRDs in Kubernetes-named groups such as `gateway.networking.k8s.io`.
 */
const KUBERNETES_GROUPS = new Set([
  "",
  "admissionregistration.k8s.io",
  "apiextensions.k8s.io",
  "apiregistration.k8s.io",
  "apps",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "autoscaling",
  "batch",
  "certificates.k8s.io",
  "coordination.k8s.io",
  "custom.metrics.k8s.io",
  "discovery.k8s.io",
  "events.k8s.io",
  "external.metrics.k8s.io",
  "extensions",
  "flowcontrol.apiserver.k8s.io",
  "internal.apiserver.k8s.io",
  "metrics.k8s.io",
  "networking.k8s.io",
  "node.k8s.io",
  "policy",
  "rbac.authorization.k8s.io",
  "resource.k8s.io",
  "scheduling.k8s.io",
  "storage.k8s.io",
  "storagemigration.k8s.io",
]);

/**
 * The custom resource kinds among the discovered ones (for the sidebar): kinds outside Kubernetes' own API groups
 * that can be listed and watched. Discovery carries names, groups and versions only — no CRD (and none of their
 * schemas) is downloaded for it.
 */
export function customResourceKinds(kinds: ResourceKind[] | null): ResourceKind[] {
  return (kinds ?? []).filter(
    (k) => !KUBERNETES_GROUPS.has(k.kindRef.group) && k.verbs.includes("list") && k.verbs.includes("watch"),
  );
}
