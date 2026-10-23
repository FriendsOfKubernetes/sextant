// The KServe section's counter: the InferenceServices the problems screen counts (not ready after a grace, a model
// that failed to load), from the shared problem watches.
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["kserve"];

export function useKServeProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
