// Live lists of a Rollout's details: the ReplicaSets and AnalysisRuns of its namespace (shared with every other view
// of the same lists, `useWatch`), watched only while the details are open, only for kinds the cluster serves, never
// before discovery. A Rollout's own objects are picked from them by owner uid (model.ts).
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { ANALYSIS_RUN } from "./model";

const REPLICA_SET: KindRef = { group: "apps", version: "v1", kind: "ReplicaSet" };

/** The version of `kind` the cluster serves; `null` when it does not; `undefined` while discovery is coming. */
function useServed(clusterId: ClusterId, kind: KindRef): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

function inNamespace(kind: KindRef | null | undefined, namespace: string | null): WatchSpec | null {
  return kind && namespace ? { kind, namespaces: [namespace], labelSelector: null, fieldSelector: null } : null;
}

export interface RolloutLists {
  replicaSets: KubeObject[];
  analysisRuns: KubeObject[];
  /** The ReplicaSets have come (or cannot). */
  replicaSetsKnown: boolean;
  analysisRunsKnown: boolean;
}

export function useRolloutLists(clusterId: ClusterId, namespace: string | null, enabled = { replicaSets: true, analysisRuns: true }): RolloutLists {
  const runKind = useServed(clusterId, ANALYSIS_RUN);
  const replicaSets = useWatch(clusterId, enabled.replicaSets ? inNamespace(REPLICA_SET, namespace) : null);
  const runs = useWatch(clusterId, enabled.analysisRuns ? inNamespace(runKind, namespace) : null);
  return {
    replicaSets: [...replicaSets.items.values()],
    analysisRuns: [...runs.items.values()],
    replicaSetsKnown: replicaSets.status !== "loading",
    analysisRunsKnown: runKind === null || (runKind !== undefined && runs.status !== "loading"),
  };
}
