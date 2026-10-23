// The KubeRay section's counter: the objects the problems screen counts (a failed RayCluster or one whose head is not
// ready, a recently failed RayJob, a RayService not ready), from the shared problem watches.
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["kuberay"];

export function useKubeRayProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
