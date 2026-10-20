// The Kyverno section's counter: the objects that fail policy rules, from the problems category `policies` — only
// while the user has turned that opt-in category on (then the shared problem watches of the reports are held anyway).
import type { ClusterId } from "../../api";
import { useCategoriesOn, useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["policies"];

export function useKyvernoProblemCount(clusterId: ClusterId): number {
  const on = useCategoriesOn(CATEGORIES);
  return useClusterProblems(on.length > 0 ? clusterId : null, on).active.length;
}
