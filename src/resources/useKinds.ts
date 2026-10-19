// Discovery of a cluster (`api.clusters.kinds`), fetched once per cluster and shared by every caller, and fetched
// again when the cluster's CRDs change (`watchCrdChanges`), so a kind created while connected (Flux or Argo CD
// installed) shows up without reconnecting.
import { useEffect, useSyncExternalStore } from "react";
import {
  api,
  openStream,
  toApiError,
  type ApiError,
  type ClusterId,
  type KindRef,
  type KubeObject,
  type ResourceKind,
  type WatchSpec,
  type WatchUpdate,
} from "../api";
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
  fetchKinds(clusterId, false);
}

/** Asks the backend; an answer to an older request is dropped. With `keep`, a failure keeps the kinds known. */
function fetchKinds(clusterId: ClusterId, keep: boolean): void {
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
      const known = cache.get(clusterId)?.kinds;
      if (keep && known) return;
      set(clusterId, { kinds: null, error: toApiError(err) });
    },
  );
}

export interface RefreshOptions {
  /** Keep showing the kinds known so far until the new ones come (a CRD changed; nothing else did). */
  keep?: boolean;
}

/**
 * Forgets what is known about the cluster's kinds (a new connection may serve other kinds, e.g. a CRD created
 * since) and loads them again when anything was loaded or loading; otherwise the first user loads them.
 */
export function refreshClusterKinds(clusterId: ClusterId, { keep = false }: RefreshOptions = {}): void {
  if (!cache.has(clusterId) && !inflight.has(clusterId)) return;
  generations.set(clusterId, (generations.get(clusterId) ?? 0) + 1);
  inflight.delete(clusterId);
  if (!keep) cache.delete(clusterId);
  forgetCrdPrinterColumns(clusterId);
  if (keep) fetchKinds(clusterId, true);
  else loadClusterKinds(clusterId);
}

/** Forgets every cluster (tests). */
export function resetClusterKinds(): void {
  cache.clear();
  inflight.clear();
  generations.clear();
  for (const watch of crdWatches.values()) {
    watch.stop();
    if (watch.timer) clearTimeout(watch.timer);
  }
  crdWatches.clear();
  knownCrds.clear();
  forgetCrdPrinterColumns();
  for (const fn of listeners) fn();
}

// ---------- CRD changes ----------

/** How long CRD changes are collected before the kinds are fetched again (installing Flux creates a dozen CRDs). */
export const CRD_REFRESH_DELAY = 1000;

const CRD_WATCH: WatchSpec = {
  kind: { group: "apiextensions.k8s.io", version: "v1", kind: "CustomResourceDefinition" },
  namespaces: null,
  labelSelector: null,
  fieldSelector: null,
  metadataOnly: true,
};

interface CrdWatch {
  users: number;
  stop: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const crdWatches = new Map<ClusterId, CrdWatch>();
/** `metadata.generation` of each CRD by uid, per cluster; kept when the watch restarts, so a CRD created while
 * nobody watched is noticed by the next first list. */
const knownCrds = new Map<ClusterId, Map<string, unknown>>();

/**
 * Watches the metadata of the cluster's CRDs (one watch per cluster, however many callers). A CRD created or deleted
 * after the first list, or one whose spec changed (a new version), makes the backend forget its discovery
 * (`api.clusters.refreshKinds`) and the window fetch the kinds again, once a series of changes has paused for
 * `CRD_REFRESH_DELAY`; the kinds
 * known so far stay shown meanwhile. A cluster whose CRDs cannot be watched (no permission) is left as it is. The
 * returned function stops watching once every caller has called it.
 */
export function watchCrdChanges(clusterId: ClusterId): () => void {
  let watch = crdWatches.get(clusterId);
  if (!watch) {
    const created: CrdWatch = { users: 0, stop: () => undefined, timer: null };
    created.stop = openStream<WatchUpdate>({
      start: (id, channel) => api.resources.watchStart(clusterId, CRD_WATCH, id, channel),
      stop: api.resources.watchStop,
      onEvent: (update) => {
        if (crdsChanged(clusterId, update)) scheduleRefresh(clusterId, created);
      },
    });
    crdWatches.set(clusterId, created);
    watch = created;
  }
  const current = watch;
  current.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.users--;
    if (current.users > 0 || crdWatches.get(clusterId) !== current) return;
    crdWatches.delete(clusterId);
    current.stop();
  };
}

/** Records the update; whether the set of CRDs (or a CRD's spec) changed since the first list. */
function crdsChanged(clusterId: ClusterId, update: WatchUpdate): boolean {
  const generationOf = (obj: KubeObject) => obj.metadata?.generation;
  const uidOf = (obj: KubeObject) => obj.metadata?.uid ?? obj.metadata?.name ?? "";
  if (update.type === "snapshot") {
    const before = knownCrds.get(clusterId);
    const now = new Map<string, unknown>();
    for (const obj of update.items as KubeObject[]) now.set(uidOf(obj), generationOf(obj));
    knownCrds.set(clusterId, now);
    if (!before) return false;
    return before.size !== now.size || [...now].some(([uid, generation]) => before.get(uid) !== generation);
  }
  if (update.type !== "delta") return false;
  const known = knownCrds.get(clusterId);
  if (!known) return false;
  let changed = false;
  for (const obj of update.upserted as KubeObject[]) {
    const uid = uidOf(obj);
    if (!known.has(uid) || known.get(uid) !== generationOf(obj)) changed = true;
    known.set(uid, generationOf(obj));
  }
  for (const uid of update.deleted) {
    if (known.delete(uid)) changed = true;
  }
  return changed;
}

/** Refreshes `CRD_REFRESH_DELAY` after the last of a series of changes. */
function scheduleRefresh(clusterId: ClusterId, watch: CrdWatch): void {
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = setTimeout(() => {
    watch.timer = null;
    api.clusters.refreshKinds(clusterId).then(
      () => refreshClusterKinds(clusterId, { keep: true }),
      // Not connected any more: the next connection fetches the kinds anyway.
      () => undefined,
    );
  }, CRD_REFRESH_DELAY);
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

/**
 * The kinds the cluster serves as known now, read outside React and without loading them (`null` until discovery
 * came): for a check that must not wait, such as whether an action applies.
 */
export function knownClusterKinds(clusterId: ClusterId | null): ResourceKind[] | null {
  return clusterId ? (cache.get(clusterId)?.kinds ?? null) : null;
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

