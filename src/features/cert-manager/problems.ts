// The cert-manager section's counter: the Certificates the problems screen counts as needing attention (not ready
// for a real failure, expiring, expired), from the shared problem watches (src/features/problems/store.ts).
import type { ClusterId } from "../../api";
import { useClusterProblems } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";

const CATEGORIES: readonly ProblemCategory[] = ["certificates"];

export function useCertificateProblemCount(clusterId: ClusterId): number {
  // Certificates, not problems: one can be expiring and failing to renew at once.
  return new Set(useClusterProblems(clusterId, CATEGORIES).active.filter((p) => p.notify).map((p) => p.uid)).size;
}
