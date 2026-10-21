// The Traefik section's counter: the objects the problems screen counts as broken (a reference to an object that does
// not exist, a route Traefik skips), from the shared problem sources (src/features/problems/store.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["traefik"];

export function useTraefikProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.filter((p) => p.notify).map((p) => p.uid)).size;
}
