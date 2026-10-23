// The Vertical Pod Autoscaler section's counter: the VPAs the problems screen counts (a configuration the recommender
// cannot use, no pods matched, a fight with an HPA), from the category's provider (provider.ts) through the shared
// problem sources.
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["vpa"];

export function useVpaProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
