// The Strimzi section's counter: the objects the problems screen counts (not ready past the grace), from the shared
// problem watches (src/features/problems/store.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["strimzi"];

export function useStrimziProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
