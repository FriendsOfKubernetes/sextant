// Live data of the Kueue details, bounded and shared; nothing of Kueue is watched before discovery or where the
// cluster does not serve the kind:
//  - every Workload as a compact row (`workloadRow`), a tap on the problems store's cluster-wide Workload watch (the
//    source of the `kueueWorkloads` category, src/features/problems/sources.ts, ≤ 5000), held while a queue's details
//    are open and `TAP_LINGER_MS` after, so the queues' waiting lists open no second Workload watch;
//  - the LocalQueues and ClusterQueues of the cluster (few: one LocalQueue per team namespace, ≤ 5000) through the
//    resource map's shared watches, while a queue's, flavor's or cohort's details are open;
//  - the Workloads of one job, in its namespace, by the label Kueue puts on them (`kueue.x-k8s.io/job-uid`, selected
//    by the API server), or a prebuilt Workload by name (its annotation first, then its label).
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { findKind, status, useClusterKinds } from "../../resources";
import { sourceKey, sourcesFor, type SourceDef } from "../problems/sources";
import { acquireRows, epochOf, getRows, sourcesVersion, subscribeSources, type RowsState, type RowTap } from "../problems/store";
import { useSharedWatches } from "../resource-map/watches";
import { CLUSTER_QUEUE, JOB_UID_LABEL, LOCAL_QUEUE, prebuiltWorkloadOf, WORKLOAD, workloadRow, type WorkloadRow } from "./model";

/** Rows the tap keeps at most, as the source's watch. */
export const MAX_WORKLOAD_ROWS = 5000;
/** How long the tap stays held after its last view unmounts (moving from one queue to the next keeps it). */
export const TAP_LINGER_MS = 60_000;
const WORKLOAD_TAP: RowTap<WorkloadRow> = { id: "kueue:workloads", toRow: workloadRow, max: MAX_WORKLOAD_ROWS };

interface Held {
  release: () => void;
  refs: number;
  timer?: ReturnType<typeof setTimeout>;
}

const held = new Map<string, Held>();

function hold(clusterId: ClusterId, def: SourceDef): () => void {
  const key = `${sourceKey(clusterId, def)}|${epochOf(clusterId)}`;
  let entry = held.get(key);
  if (!entry) {
    entry = { release: acquireRows(clusterId, def, WORKLOAD_TAP as RowTap), refs: 0 };
    held.set(key, entry);
  }
  const mine = entry;
  if (mine.timer) {
    clearTimeout(mine.timer);
    mine.timer = undefined;
  }
  mine.refs++;
  return () => {
    mine.refs--;
    if (mine.refs > 0) return;
    mine.timer = setTimeout(() => {
      if (held.get(key) !== mine || mine.refs > 0) return;
      held.delete(key);
      mine.release();
    }, TAP_LINGER_MS);
  };
}

/** Releases every held tap at once (tests). */
export function resetKueueTaps(): void {
  for (const entry of held.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.release();
  }
  held.clear();
}

export interface WorkloadRows {
  rows: WorkloadRow[];
  loading: boolean;
  /** The list could not be read: what waits is not known. */
  failed: boolean;
  /** More Workloads than the tap keeps: the lists may lack some. */
  truncated: boolean;
}

const NONE: WorkloadRow[] = [];

/** Every Workload of the cluster as a row, while `enabled`. */
export function useWorkloadRows(clusterId: ClusterId, enabled: boolean): WorkloadRows {
  const kinds = useClusterKinds(clusterId);
  const def = useMemo(() => (kinds.kinds ? sourcesFor(["kueueWorkloads"], kinds.kinds)[0] : undefined), [kinds.kinds]);
  const version = useSyncExternalStore(subscribeSources, sourcesVersion, sourcesVersion);
  const epoch = epochOf(clusterId);
  const on = enabled && def !== undefined;
  useEffect(() => {
    if (!on || !def) return;
    return hold(clusterId, def);
  }, [clusterId, on, def, epoch]);
  return useMemo(() => {
    void version;
    const rows = on && def ? (getRows(sourceKey(clusterId, def), WORKLOAD_TAP.id) as RowsState<WorkloadRow> | undefined) : undefined;
    if (!rows) return { rows: NONE, loading: enabled && (on || (!kinds.kinds && !kinds.error)), failed: false, truncated: false };
    return { rows: [...rows.rows.values()], loading: rows.status === "loading", failed: rows.status === "error", truncated: rows.truncated };
  }, [clusterId, on, def, version, epoch, enabled, kinds.kinds, kinds.error]);
}

export interface Listed {
  items: KubeObject[];
  loading: boolean;
  failed: boolean;
}

const failedState = (s: WatchState | undefined) => s?.status === "error" || (s?.forbidden ?? []).length > 0;

function useClusterList(clusterId: ClusterId, kind: typeof LOCAL_QUEUE, enabled: boolean): Listed {
  const kinds = useClusterKinds(clusterId);
  const served = kinds.kinds ? (findKind(kinds.kinds, kind)?.kindRef ?? null) : undefined;
  const specs = useMemo<WatchSpec[]>(
    () => (enabled && served ? [{ kind: served, namespaces: null, labelSelector: null, fieldSelector: null }] : []),
    [enabled, served],
  );
  const [state] = useSharedWatches(clusterId, specs);
  return useMemo(
    () => ({
      items: state?.status === "ready" ? [...state.items.values()] : [],
      loading: enabled && (served === undefined || (served !== null && (!state || state.status === "loading"))),
      failed: served === null || failedState(state),
    }),
    [state, served, enabled],
  );
}

/** The LocalQueues of the cluster, while `enabled`. */
export const useLocalQueues = (clusterId: ClusterId, enabled = true) => useClusterList(clusterId, LOCAL_QUEUE, enabled);
/** The ClusterQueues of the cluster, while `enabled`. */
export const useClusterQueues = (clusterId: ClusterId, enabled = true) => useClusterList(clusterId, CLUSTER_QUEUE, enabled);

export interface JobWorkloads {
  /** `undefined` while loading or where Workloads are not served. */
  items: KubeObject[] | undefined;
  /** The cluster serves Workloads (`undefined` before discovery). */
  served: boolean | undefined;
  failed: boolean;
}

/** The Workloads of a job: Kueue's own (by the job-uid label and owner reference) or the prebuilt one it names. */
export function useJobWorkloads(clusterId: ClusterId, job: KubeObject | null): JobWorkloads {
  const kinds = useClusterKinds(clusterId);
  const served = kinds.kinds ? (findKind(kinds.kinds, WORKLOAD)?.kindRef ?? null) : undefined;
  const namespace = job?.metadata?.namespace;
  const uid = job?.metadata?.uid;
  const prebuilt = prebuiltWorkloadOf(job);
  const specs = useMemo<WatchSpec[]>(() => {
    if (!served || !namespace || !uid) return [];
    const ns = [namespace];
    const out: WatchSpec[] = [{ kind: served, namespaces: ns, labelSelector: `${JOB_UID_LABEL}=${uid}`, fieldSelector: null }];
    if (prebuilt) out.push({ kind: served, namespaces: ns, labelSelector: null, fieldSelector: `metadata.name=${prebuilt}` });
    return out;
  }, [served, namespace, uid, prebuilt]);
  const states = useSharedWatches(clusterId, specs);
  return useMemo(() => {
    if (served === null) return { items: undefined, served: false, failed: false };
    if (specs.length === 0 || states.length < specs.length || states.some((s) => s.status === "loading"))
      return { items: undefined, served: served === undefined ? undefined : true, failed: false };
    const byUid = new Map<string, KubeObject>();
    for (const s of states) for (const o of s.items.values()) byUid.set(o.metadata?.uid ?? `${o.metadata?.name}`, o);
    // A Workload labelled with the uid belongs to the job; one owned by another object is left out.
    const items = [...byUid.values()].filter((w) => {
      const owners = status.arr(w.metadata?.ownerReferences);
      return owners.length === 0 || owners.some((r) => status.get(r, "uid") === uid) || w.metadata?.name === prebuilt;
    });
    return { items, served: true, failed: states.some(failedState) };
  }, [served, specs, states, uid, prebuilt]);
}
