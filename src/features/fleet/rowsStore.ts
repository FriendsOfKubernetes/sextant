// Rows of a kind per cluster for the overview of several clusters. They are a tap on the problem watch of the kind
// (`acquireRows`, src/features/problems/store.ts): the health cards hold that watch anyway, so the overview never
// opens a second watch of the same (cluster, kind). Each update is reduced to compact rows at once (`RowKind.toRow`,
// at most `MAX_KEPT_ROWS`); the objects are not kept. A watch that fails is retried by the problems store.
//
//   const rows = useClusterRows(["c1", "c2"], POD_ROWS); // Map<clusterId, RowsState<PodRow>>
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ClusterId } from "../../api";
import { sourceKey, type SourceDef } from "../problems/sources";
import {
  acquireRows,
  epochOf,
  getRows,
  sourcesVersion,
  subscribeSources,
  type RowsState,
  type RowTap,
} from "../problems/store";
import { MAX_KEPT_ROWS } from "./constants";
import type { RowKind } from "./rows";

export type { RowsState } from "../problems/store";

const LOADING: RowsState<never> = Object.freeze({
  status: "loading",
  rows: new Map<string, never>(),
  truncated: false,
}) as RowsState<never>;

const sources = new WeakMap<RowKind<unknown>, { def: SourceDef; tap: RowTap }>();

/** The problem source the rows ride on and the tap that makes them; the same objects for the same row kind. */
function sourceOf(kind: RowKind<unknown>): { def: SourceDef; tap: RowTap } {
  let found = sources.get(kind);
  if (!found) {
    found = {
      def: { category: kind.category, kind: kind.kind, fieldSelector: null, discovered: false },
      tap: { id: `fleet:${kind.id}`, toRow: kind.toRow, max: MAX_KEPT_ROWS },
    };
    sources.set(kind, found);
  }
  return found;
}

/**
 * Keeps rows of `def` in each of `clusterIds` while mounted (nothing for `null`) and returns them by cluster. Pass
 * only connected clusters: a watch of a cluster that is not connected would only fail.
 */
export function useClusterRows<R>(clusterIds: readonly ClusterId[], def: RowKind<R> | null): Map<ClusterId, RowsState<R>> {
  const version = useSyncExternalStore(subscribeSources, sourcesVersion, sourcesVersion);
  const ids = JSON.stringify(clusterIds);
  // A new connection (or its loss) dropped the cluster's sources: hold them again.
  const epochs = clusterIds.map((id) => epochOf(id)).join(",");

  useEffect(() => {
    if (!def) return;
    const { def: source, tap } = sourceOf(def as RowKind<unknown>);
    const releases = (JSON.parse(ids) as ClusterId[]).map((id) => acquireRows(id, source, tap));
    return () => {
      for (const release of releases) release();
    };
  }, [ids, def, epochs]);

  return useMemo(() => {
    void version;
    const result = new Map<ClusterId, RowsState<R>>();
    if (!def) return result;
    const { def: source, tap } = sourceOf(def as RowKind<unknown>);
    for (const id of JSON.parse(ids) as ClusterId[]) {
      result.set(id, (getRows(sourceKey(id, source), tap.id) as RowsState<R> | undefined) ?? LOADING);
    }
    return result;
  }, [ids, def, version, epochs]);
}
