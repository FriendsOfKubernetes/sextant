// The Kueue section's counter: the queues that admit nothing (category `kueue`) and, while the opt-in category
// `kueueWorkloads` is on, the Workloads waiting too long, not queueable or evicted repeatedly — from the shared problem
// sources (src/features/problems/store.ts). Off, nothing of the Workloads is watched for it.
import { useMemo } from "react";
import type { ClusterId } from "../../api";
import { useCategoriesOn, useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const OPT_IN: readonly ProblemCategory[] = ["kueueWorkloads"];

export function useKueueProblemCount(clusterId: ClusterId): number {
  const on = useCategoriesOn(OPT_IN);
  const categories = useMemo<ProblemCategory[]>(() => ["kueue", ...on], [on]);
  return new Set(useClusterProblems(clusterId, categories).active.map((p) => p.uid)).size;
}
