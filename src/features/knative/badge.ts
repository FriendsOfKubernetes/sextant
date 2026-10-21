// The Knative sections' counters: the objects the problems screen counts as needing attention, from the shared problem
// watches (src/features/problems/store.ts) — Serving's Services and Configurations on the "Knative Serving" header,
// the Eventing objects (#234) on the "Knative Eventing" header; one problem category (`knative`) feeds both.
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";
import { EVENTING_GROUPS } from "./eventing";

const CATEGORIES: readonly ProblemCategory[] = ["knative"];

function useCount(clusterId: ClusterId, eventing: boolean): number {
  const active = useClusterProblems(clusterId, CATEGORIES).active;
  return new Set(active.filter((p) => p.notify && EVENTING_GROUPS.has(p.object.kind.group) === eventing).map((p) => p.uid)).size;
}

export const useKnativeProblemCount = (clusterId: ClusterId) => useCount(clusterId, false);
export const useKnativeEventingProblemCount = (clusterId: ClusterId) => useCount(clusterId, true);
