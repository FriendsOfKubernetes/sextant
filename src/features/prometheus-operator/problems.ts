// The Prometheus Operator section's counter: the objects with problems the screen notifies of (a monitor that selects
// nothing, a Prometheus or Alertmanager not available), from the shared problem sources (src/features/problems/store.ts);
// "not picked up by any Prometheus" is a warning on the screen only, not counted.
import type { ClusterId } from "../../api";
import { useCategoriesOn, useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["prometheusOperator"];

/** Only while the opt-in category is on. */
export function usePrometheusOperatorProblemCount(clusterId: ClusterId): number {
  const on = useCategoriesOn(CATEGORIES);
  return new Set(
    useClusterProblems(on.length > 0 ? clusterId : null, on)
      .active.filter((p) => p.notify)
      .map((p) => p.uid),
  ).size;
}
