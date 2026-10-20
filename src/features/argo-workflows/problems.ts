// The Argo Workflows section's counter: the Workflows that failed recently, as the problems screen counts them (the
// provider in ./provider.ts, one metadata-only watch of failed Workflows).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["workflows"];

export function useWorkflowProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
