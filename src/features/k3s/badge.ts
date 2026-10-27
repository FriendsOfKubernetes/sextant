// The counters of the two sections, from the shared problem sources of the category `k3s`: "Helm controller" counts
// its HelmCharts that failed or keep failing, "k3s / RKE2" its bundled components that are not available.
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";
import { HELM_CHART, isKind } from "./model";

const CATEGORIES: readonly ProblemCategory[] = ["k3s"];

function useCount(clusterId: ClusterId, charts: boolean): number {
  const active = useClusterProblems(clusterId, CATEGORIES).active.filter((p) => isKind(p.object.kind, HELM_CHART) === charts);
  return new Set(active.map((p) => p.uid)).size;
}

export const useHelmControllerProblemCount = (clusterId: ClusterId): number => useCount(clusterId, true);
export const useK3sProblemCount = (clusterId: ClusterId): number => useCount(clusterId, false);
