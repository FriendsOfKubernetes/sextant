// Live data of the best-practice views, bounded and shared:
// - the page watches the workload kinds, HPAs, PodDisruptionBudgets, LimitRanges and Pods only in the chosen
//   namespaces (the specs of the Security page, so the same lists are shared) and only while it is open;
// - the details section reads its namespace's HPAs, PodDisruptionBudgets and LimitRanges through the resource map's
//   shared watches (shared with the "Related" tab) and the workload's pods through the watch the right-sizing and cost
//   sections share;
// - which nodes take pods comes from a tap on the problems store's cluster-wide Node watch (the same tap the
//   problems category uses), never a watch of its own;
// - the right-sizing recommendation comes from the right-sizing feature's Prometheus history (polled every five
//   minutes, shared with its page and section), only when Prometheus answers; without history that check is skipped.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { type ClusterId, type HistoryScope, type KindRef, type KubeObject, type UsageHistory, type WatchState } from "../../api";
import { useMetricsStatus } from "../metrics/hooks";
import { sourceKey } from "../problems/sources";
import { acquireRows, epochOf, getRows, sourcesVersion, subscribeSources, type RowTap } from "../problems/store";
import { buildRows } from "../rightsizing/group";
import { useUsageHistory } from "../rightsizing/hooks";
import type { Recommendation } from "../rightsizing/recommend";
import { indexLimits, indexPlacements, type Context } from "./checks";
import { hpaInfo, limitDefaults, pdbInfo, placementOf, workloadKey } from "./model";
import { NODE_SOURCE, NODE_TAP_DEF, type SchedulingNode } from "./taps";

export const HPA: KindRef = { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" };
export const PDB: KindRef = { group: "policy", version: "v1", kind: "PodDisruptionBudget" };
export const LIMIT_RANGE: KindRef = { group: "", version: "v1", kind: "LimitRange" };

/** The objects of a watch once listed; `undefined` while loading, after an error, or with namespaces left out. */
export function listed(watch: WatchState | undefined): KubeObject[] | undefined {
  if (!watch || watch.status === "loading" || watch.status === "error" || (watch.forbidden?.length ?? 0) > 0) return undefined;
  return [...watch.items.values()];
}

/** The nodes that take pods (not cordoned); `undefined` until known. */
export function useSchedulableNodes(clusterId: ClusterId): SchedulingNode[] | undefined {
  const version = useSyncExternalStore(subscribeSources, sourcesVersion, sourcesVersion);
  const epoch = epochOf(clusterId);
  useEffect(() => acquireRows(clusterId, NODE_SOURCE, NODE_TAP_DEF as RowTap), [clusterId, epoch]);
  return useMemo(() => {
    void version;
    const state = getRows(sourceKey(clusterId, NODE_SOURCE), NODE_TAP_DEF.id);
    if (!state || state.status === "loading" || state.status === "error" || state.truncated) return undefined;
    return [...state.rows.values()].filter((n): n is SchedulingNode => n !== null);
  }, [clusterId, version, epoch]);
}

/** Recommendations from Prometheus history for `scope`, by workload key and container; `undefined` without history. */
export function useRecommendations(
  clusterId: ClusterId,
  scope: HistoryScope | null,
  pods: readonly KubeObject[] | undefined,
): ReadonlyMap<string, ReadonlyMap<string, Recommendation>> | undefined {
  const status = useMetricsStatus(clusterId);
  const history = useUsageHistory(clusterId, scope, "week", !!status.data?.prometheus);
  return useMemo(() => (history.data && pods ? recommendationsOf(pods, history.data) : undefined), [history.data, pods]);
}

export function recommendationsOf(pods: readonly KubeObject[], history: UsageHistory): Map<string, Map<string, Recommendation>> {
  const out = new Map<string, Map<string, Recommendation>>();
  for (const row of buildRows(pods, { kind: "history", history }, Date.now())) {
    const rec = row.assessment.recommendation;
    if (!rec) continue;
    const key = workloadKey(row.workload.namespace, row.workload.kind, row.workload.name);
    const byContainer = out.get(key) ?? new Map<string, Recommendation>();
    byContainer.set(row.container, rec);
    out.set(key, byContainer);
  }
  return out;
}

/** The context of the checks from the lists that were read (an unread list leaves its checks out). */
export function contextFrom(input: {
  hpas?: readonly KubeObject[];
  pdbs?: readonly KubeObject[];
  limitRanges?: readonly KubeObject[];
  pods?: readonly KubeObject[];
  schedulableNodes?: readonly SchedulingNode[];
  recommendations?: ReadonlyMap<string, ReadonlyMap<string, Recommendation>>;
}): Context {
  return {
    hpas: input.hpas?.map(hpaInfo),
    pdbs: input.pdbs?.map(pdbInfo),
    limits: input.limitRanges && indexLimits(input.limitRanges.map(limitDefaults)),
    nodes: input.pods && indexPlacements(input.pods.map(placementOf)),
    schedulableNodes: input.schedulableNodes,
    recommendations: input.recommendations,
  };
}
