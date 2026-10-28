// Live data of the autoscaling views, bounded and shared:
//  - nodes and the requests of bound pods are taps on the problems store's cluster-wide Node and Pod watches
//    (`acquireRows`), reduced to compact rows at once, so opening a Pending pod opens no second watch of either; a
//    tap stays held `TAP_LINGER_MS` after the last view lets go, so going from one Pending pod to the next does not
//    relist the pods;
//  - lists of one namespace (HPAs, ScaledObjects, pods, claims) and the cluster-wide Karpenter lists go through the
//    resource map's shared watches (src/features/resource-map/watches.ts), shared with the "Related" tab;
//  - an object's events and single objects by name are plain `useWatch`es that end with the component.
// A kind the cluster does not serve is never watched, and nothing of an installed tool is watched before discovery.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec, type WatchState } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { NODE as PROBLEM_NODE, POD as PROBLEM_POD } from "../problems/model";
import { sourceKey, type SourceDef } from "../problems/sources";
import { acquireRows, epochOf, getRows, sourcesVersion, subscribeSources, type RowsState, type RowTap } from "../problems/store";
import { useSharedWatches } from "../resource-map/watches";
import { EVENT, eventRow, type EventRow } from "./model";
import { boundPodRow, nodeRow, type BoundPodRow, type NodeRow } from "./scheduling";

/** How long a tap stays held after its last view unmounts. */
export const TAP_LINGER_MS = 60_000;
/** Rows kept per tap at most (beyond it the tap says `truncated`). */
export const MAX_NODE_ROWS = 5000;
export const MAX_POD_ROWS = 50_000;

/** Groups of Kubernetes itself whose kinds are watched at their registered version when discovery failed. */
const BUILT_IN_GROUPS = new Set(["", "apps", "autoscaling"]);

/**
 * The version of `kind` the cluster serves; `null` when it does not; `undefined` while discovery is coming. When
 * discovery failed, a built-in kind is taken at its registered version and an installed tool's kind is not watched.
 */
export function useServed(clusterId: ClusterId, kind: Pick<KindRef, "group" | "kind"> & { version?: string }): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  if (!kinds.error) return undefined;
  return kind.version && BUILT_IN_GROUPS.has(kind.group) ? { group: kind.group, version: kind.version, kind: kind.kind } : null;
}

// ---------- Taps on the problems store ----------

const NODE_SOURCE: SourceDef = { category: "nodes", kind: PROBLEM_NODE, fieldSelector: null, discovered: false };
const POD_SOURCE: SourceDef = { category: "pods", kind: PROBLEM_POD, fieldSelector: null, discovered: false };
const NODE_TAP: RowTap<NodeRow> = { id: "autoscaling:nodes", toRow: nodeRow, max: MAX_NODE_ROWS };
const POD_TAP: RowTap<BoundPodRow | null> = { id: "autoscaling:boundPods", toRow: boundPodRow, max: MAX_POD_ROWS };

interface Held {
  release: () => void;
  refs: number;
  timer?: ReturnType<typeof setTimeout>;
}

const held = new Map<string, Held>();

function hold(clusterId: ClusterId, def: SourceDef, tap: RowTap): () => void {
  const key = `${clusterId}|${tap.id}|${epochOf(clusterId)}`;
  let entry = held.get(key);
  if (!entry) {
    entry = { release: acquireRows(clusterId, def, tap as RowTap), refs: 0 };
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
export function resetAutoscalingTaps(): void {
  for (const entry of held.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.release();
  }
  held.clear();
}

const LOADING: RowsState<never> = Object.freeze({ status: "loading", rows: new Map<string, never>(), truncated: false }) as RowsState<never>;

function useTap<R>(clusterId: ClusterId, def: SourceDef, tap: RowTap<R>, enabled: boolean): RowsState<R> {
  const version = useSyncExternalStore(subscribeSources, sourcesVersion, sourcesVersion);
  const epoch = epochOf(clusterId);
  useEffect(() => {
    if (!enabled) return;
    return hold(clusterId, def, tap as RowTap);
  }, [clusterId, enabled, epoch, def, tap]);
  return useMemo(() => {
    void version;
    if (!enabled) return LOADING;
    return (getRows(sourceKey(clusterId, def), tap.id) as RowsState<R> | undefined) ?? LOADING;
  }, [clusterId, enabled, version, epoch, def, tap]);
}

/** Compact rows of every node (labels, taints, allocatable), while `enabled`. */
export function useNodeRows(clusterId: ClusterId, enabled: boolean): RowsState<NodeRow> {
  return useTap(clusterId, NODE_SOURCE, NODE_TAP, enabled);
}

/** The node and requests of every bound pod that holds them, while `enabled`. */
export function useBoundPods(clusterId: ClusterId, enabled: boolean): RowsState<BoundPodRow | null> {
  return useTap(clusterId, POD_SOURCE, POD_TAP, enabled);
}

// ---------- Shared lists ----------

/** Objects of `kind` in `namespace` (or the whole cluster for `null`), shared; nothing for a kind not served. */
export function useSharedList(
  clusterId: ClusterId,
  kind: Pick<KindRef, "group" | "kind">,
  namespace: string | null,
  enabled = true,
): { items: KubeObject[]; state: WatchState | undefined; served: boolean | undefined } {
  const served = useServed(clusterId, kind);
  const specs = useMemo<WatchSpec[]>(
    () => (enabled && served ? [{ kind: served, namespaces: namespace === null ? null : [namespace], labelSelector: null, fieldSelector: null }] : []),
    [enabled, served, namespace],
  );
  const [state] = useSharedWatches(clusterId, specs);
  const items = useMemo(() => (state ? [...state.items.values()] : []), [state]);
  return { items, state, served: served === undefined ? undefined : served !== null };
}

/** One object by name (a watch of it), or nothing for `null`. */
export function useObject(clusterId: ClusterId, kind: KindRef | null | undefined, namespace: string | null, name: string | undefined): KubeObject | undefined {
  const spec = useMemo<WatchSpec | null>(
    () => (kind && name ? { kind, namespaces: namespace ? [namespace] : null, labelSelector: null, fieldSelector: `metadata.name=${name}` } : null),
    [kind, namespace, name],
  );
  const watch = useWatch(clusterId, spec);
  return useMemo(() => [...watch.items.values()][0], [watch.items]);
}

/** Events about one object (by uid when namespaced, by kind and name otherwise), as rows. */
export function useObjectEvents(clusterId: ClusterId, obj: KubeObject | null | undefined, kind: string, enabled = true): EventRow[] {
  return useObjectEventsSource(clusterId, obj, kind, enabled).events;
}

/** The conditional details disclosures also need to know whether an empty result is complete or unknown. */
export function useObjectEventsSource(clusterId: ClusterId, obj: KubeObject | null | undefined, kind: string, enabled = true) {
  const uid = obj?.metadata?.uid;
  const name = obj?.metadata?.name;
  const namespace = obj?.metadata?.namespace ?? null;
  const spec = useMemo<WatchSpec | null>(() => {
    if (!enabled || !name) return null;
    const fieldSelector = namespace && uid ? `involvedObject.uid=${uid}` : `involvedObject.kind=${kind},involvedObject.name=${name}`;
    return { kind: EVENT, namespaces: namespace ? [namespace] : null, labelSelector: null, fieldSelector };
  }, [enabled, uid, name, namespace, kind]);
  const watch = useWatch(clusterId, spec);
  const events = useMemo(() => [...watch.items.values()].map(eventRow), [watch.items]);
  return { events, state: watch };
}

/** Events about objects of one kind (cluster-scoped kinds: every NodeClaim's), as rows. */
export function useKindEvents(clusterId: ClusterId, kind: string, enabled: boolean): EventRow[] {
  const spec = useMemo<WatchSpec | null>(
    () => (enabled ? { kind: EVENT, namespaces: null, labelSelector: null, fieldSelector: `involvedObject.kind=${kind}` } : null),
    [enabled, kind],
  );
  const watch = useWatch(clusterId, spec);
  return useMemo(() => [...watch.items.values()].map(eventRow), [watch.items]);
}
