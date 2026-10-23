// The GPU Operator section's counter: the objects the problems screen counts (a ClusterPolicy or NVIDIADriver not
// ready or with a component not rolled out, a node whose MIG configuration failed), from the shared problem sources.
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["gpuOperator"];

export function useGpuOperatorProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
