// The Contour section's counter: the HTTPProxies the problems screen counts as needing attention (invalid or
// orphaned), from the shared problem watches (src/features/problems/store.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["contour"];

export function useContourProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.filter((p) => p.notify).map((p) => p.uid)).size;
}
