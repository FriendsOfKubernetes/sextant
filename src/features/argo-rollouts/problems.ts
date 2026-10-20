// The Argo Rollouts section's counter: the Rollouts the problems screen counts (Degraded, aborted, a failed analysis),
// from the shared problem watches (src/features/problems/store.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["rollouts"];

export function useRolloutProblemCount(clusterId: ClusterId): number {
  // Rollouts, not problems: an aborted one usually has a failed analysis too.
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
