// The Cluster API section's counter: the objects the problems screen counts (a failed or unavailable Cluster or
// control plane, a Machine failed or stuck provisioning, a MachineHealthCheck that stopped remediating), from the
// shared problem watches (src/features/problems/store.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["clusterApi"];

export function useClusterApiProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
