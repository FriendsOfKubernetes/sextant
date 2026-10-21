// The Sealed Secrets section's counter: the SealedSecrets the problems screen counts (a failed unseal, a synced one
// whose Secret is missing), from the category's provider (provider.ts) through the shared problem sources.
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["sealedSecrets"];

export function useSealedSecretsProblemCount(clusterId: ClusterId): number {
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.map((p) => p.uid)).size;
}
