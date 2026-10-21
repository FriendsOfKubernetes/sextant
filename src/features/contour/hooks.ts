// Live data of the Contour details, bounded and shared:
//  - the delegation tree reads every HTTPProxy as a compact row (`proxyRow`), a tap on the problems store's
//    cluster-wide HTTPProxy watch (the source of the `contour` category, src/features/problems/sources.ts), so the
//    tree opens no second watch of the kind; the tap stays held `TAP_LINGER_MS` after the last view lets go;
//  - the TLSCertificateDelegations of one namespace (where a delegated Secret lives) through the resource map's shared
//    watches (src/features/resource-map/watches.ts).
// Nothing of Contour is watched before discovery or where the cluster does not serve the kind.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { sourceKey, sourcesFor, type SourceDef } from "../problems/sources";
import { acquireRows, epochOf, getRows, sourcesVersion, subscribeSources, type RowsState, type RowTap } from "../problems/store";
import { useSharedWatches } from "../resource-map/watches";
import { indexRows, proxyRow, TLS_DELEGATION, type ProxyIndex, type ProxyRow } from "./model";

/** How long the tap stays held after its last view unmounts (moving from one proxy to the next keeps it). */
export const TAP_LINGER_MS = 60_000;
/** Rows the tap keeps at most (beyond it the tree says it may be incomplete). */
export const MAX_PROXY_ROWS = 5000;

const PROXY_TAP: RowTap<ProxyRow> = { id: "contour:proxies", toRow: proxyRow, max: MAX_PROXY_ROWS };

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
    entry = { release: acquireRows(clusterId, def, PROXY_TAP as RowTap), refs: 0 };
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
export function resetContourTaps(): void {
  for (const entry of held.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.release();
  }
  held.clear();
}

export interface ProxyIndexState {
  index: ProxyIndex;
  loading: boolean;
  /** The list could not be read (no permission, an error): the tree is not known. */
  failed: boolean;
  /** More proxies than the tap keeps: the tree may lack some. */
  truncated: boolean;
}

const EMPTY: ProxyIndex = new Map();

/** Every HTTPProxy of the cluster as a row, keyed `namespace/name`, while `enabled`. */
export function useProxyIndex(clusterId: ClusterId, enabled: boolean): ProxyIndexState {
  const kinds = useClusterKinds(clusterId);
  const def = useMemo(() => (kinds.kinds ? sourcesFor(["contour"], kinds.kinds)[0] : undefined), [kinds.kinds]);
  const version = useSyncExternalStore(subscribeSources, sourcesVersion, sourcesVersion);
  const epoch = epochOf(clusterId);
  const on = enabled && def !== undefined;
  useEffect(() => {
    if (!on || !def) return;
    return hold(clusterId, def);
  }, [clusterId, on, def, epoch]);
  return useMemo(() => {
    void version;
    const rows = on && def ? (getRows(sourceKey(clusterId, def), PROXY_TAP.id) as RowsState<ProxyRow> | undefined) : undefined;
    // Not held yet (the tap comes after this render), or discovery has not come.
    if (!rows) return { index: EMPTY, loading: enabled && (on || (!kinds.kinds && !kinds.error)), failed: false, truncated: false };
    return {
      index: indexRows(rows.rows.values()),
      loading: rows.status === "loading",
      failed: rows.status === "error",
      truncated: rows.truncated,
    };
  }, [clusterId, on, def, version, epoch, enabled, kinds.kinds, kinds.error]);
}

/** The TLSCertificateDelegations of `namespace`; `served` false where the cluster has none of the kind. */
export function useDelegations(clusterId: ClusterId, namespace: string | undefined): { items: KubeObject[]; state: WatchState | undefined; served: boolean | undefined } {
  const kinds = useClusterKinds(clusterId);
  const served = kinds.kinds ? (findKind(kinds.kinds, TLS_DELEGATION)?.kindRef ?? null) : undefined;
  const specs = useMemo<WatchSpec[]>(
    () => (served && namespace ? [{ kind: served, namespaces: [namespace], labelSelector: null, fieldSelector: null }] : []),
    [served, namespace],
  );
  const [state] = useSharedWatches(clusterId, specs);
  const items = useMemo(() => (state?.status === "ready" ? [...state.items.values()] : []), [state]);
  return { items, state, served: served === undefined ? undefined : served !== null };
}
