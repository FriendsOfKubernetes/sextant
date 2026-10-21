// The Sealed Secrets section's counter: the SealedSecrets the problems screen counts (a failed unseal, a synced one
// whose Secret is missing), from the category's provider (provider.ts) through the shared problem sources. The category
// is opt-in (ADR-0109, amended): off, the counter holds nothing (and nothing of Sealed Secrets is watched for it).
import type { ClusterId } from "../../api";
import { useCategoriesOn, useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["sealedSecrets"];

/** Only while the opt-in category is on. */
export function useSealedSecretsProblemCount(clusterId: ClusterId): number {
  const on = useCategoriesOn(CATEGORIES);
  return new Set(useClusterProblems(on.length > 0 ? clusterId : null, on).active.map((p) => p.uid)).size;
}
