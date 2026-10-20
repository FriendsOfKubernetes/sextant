// The CloudNativePG section's counter: the objects the problems screen counts (an unhealthy Cluster, failing archiving
// or backups, a failed Backup), from the shared problem watches (src/features/problems/store.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["cnpg"];

export function useCnpgProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
