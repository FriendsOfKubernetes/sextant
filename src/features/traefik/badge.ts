// The Traefik section's counter: the objects the problems screen counts as broken (a reference to an object that does
// not exist, a route Traefik skips), from the shared problem sources (src/features/problems/store.ts). The category is
// opt-in: off, the counter holds nothing (and nothing of Traefik is watched for it).
import type { ClusterId } from "../../api";
import { useCategoriesOn, useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["traefik"];

/** Only while the opt-in category is on. */
export function useTraefikProblemCount(clusterId: ClusterId): number {
  const on = useCategoriesOn(CATEGORIES);
  return new Set(
    useClusterProblems(on.length > 0 ? clusterId : null, on)
      .active.filter((p) => p.notify)
      .map((p) => p.uid),
  ).size;
}
