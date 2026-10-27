// The OLM section's counter: the objects the problems screen counts in the category `olm` (failed CSVs, failed or
// stuck InstallPlans of Subscriptions, failed resolutions, catalogs not READY), from the shared problem sources
// (src/features/problems/store.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["olm"];

export function useOlmProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
