// Machines and KubeadmControlPlanes of a paused Cluster (#243, ADR-0113 amendment). Pausing a Cluster (`spec.paused`
// or the `cluster.x-k8s.io/paused` annotation on the Cluster) stops every controller from reconciling its objects
// (cluster-api `util/annotations/helpers.go`: `IsPaused(cluster, o)` is true when the Cluster is paused, whatever the
// object says). Since Cluster API 1.9 the controllers also write a Paused condition on each object, which `isPaused`
// reads; an older Cluster API (old-only status) says nothing on the Machine itself, so its stale "provisioning" or
// "not available" would be a false problem. The Machine and control plane sources are therefore judged across the
// Cluster source's rows (`AcrossDef.from`): a problem whose `belongsTo` Cluster is paused is left out. While those
// rows cannot be read in full (forbidden, loading, capped), every problem stays — as the details then say.
import type { KubeObject } from "../../api";
import type { Problem } from "../problems/model";
import type { AcrossDef } from "../problems/sources";
import { isPaused } from "./model";

/** Clusters kept at most in the rows (a management cluster holds tens, rarely hundreds). */
export const MAX_CLUSTER_ROWS = 5000;

export interface ClusterRow {
  namespace: string;
  name: string;
  paused: boolean;
}

export const clusterRow = (obj: KubeObject): ClusterRow => ({
  namespace: obj.metadata?.namespace ?? "",
  name: obj.metadata?.name ?? "",
  paused: isPaused(obj),
});

export const CLUSTER_TAP = { id: "clusterApi:clusters", toRow: clusterRow, max: MAX_CLUSTER_ROWS };

/** The problems less those of objects whose Cluster is paused. */
export function withoutPausedClusters(problems: readonly Problem[], rows: ReadonlyMap<string, ClusterRow>): Problem[] {
  const paused = new Set<string>();
  for (const row of rows.values()) if (row.paused) paused.add(`${row.namespace}/${row.name}`);
  if (paused.size === 0) return [...problems];
  return problems.filter((p) => !p.belongsTo || !paused.has(`${p.object.namespace ?? ""}/${p.belongsTo}`));
}

/** `from` (the Cluster source) is set where the sources are defined (problems/sources.ts). */
export const CAPI_PAUSED_ACROSS: Omit<AcrossDef, "from"> = {
  tap: CLUSTER_TAP,
  keep: (problems, rows) => withoutPausedClusters(problems, rows as ReadonlyMap<string, ClusterRow>),
};
