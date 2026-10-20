// The Crossplane section's counter: the claims and composites the problems screen counts as needing attention, from
// the problems category `crossplane` (its provider holds the store, provider.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["crossplane"];

export function useCrossplaneProblemCount(clusterId: ClusterId): number {
  return useClusterProblems(clusterId, CATEGORIES).active.length;
}
