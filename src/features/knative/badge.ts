// The Knative section's counter: the Services and Configurations the problems screen counts as needing attention,
// from the shared problem watches (src/features/problems/store.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["knative"];

export function useKnativeProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.filter((p) => p.notify).map((p) => p.uid)).size;
}
