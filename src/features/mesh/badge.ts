// The counter on the Istio section header: how many Istio configuration mistakes the cluster has (`meshProblems`).
// It holds the shared configuration only where the cluster serves VirtualServices: the same condition as the problems
// source of the category (problems/sources.ts), so the counter and the Problems screen agree.
import type { ClusterId } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { VIRTUAL_SERVICE } from "./kinds";
import { useMeshConfig } from "./store";

export function useMeshProblemCount(clusterId: ClusterId): number {
  const { kinds } = useClusterKinds(clusterId);
  const served = !!kinds && !!findKind(kinds, VIRTUAL_SERVICE);
  return useMeshConfig(clusterId, served).problems.length;
}
