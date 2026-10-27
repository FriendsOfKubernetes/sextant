// The OpenShift section's counter: the objects the problems screen counts (a Route no router admitted, a failed
// rollout of a DeploymentConfig, a recent failed Build, an ImageStream whose tag import fails), from the shared
// problem watches.
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["openshift"];

export function useOpenShiftProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
