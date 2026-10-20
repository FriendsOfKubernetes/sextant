// The problems of the Argo Rollouts category (#213), for the problems screen, the counters and the notifications
// (`detect` in src/features/problems/model.ts calls this). Watched: Rollouts only (`status` tells the analysis runs of
// the current step, the background analysis and the blue-green pre/post-promotion analysis, so AnalysisRuns are never
// watched in the background). A Degraded or aborted Rollout is a problem; so is an analysis run it reports as Failed or
// Error. All share the group `rollout`: an analysis that fails and aborts the update notifies once.
import type { KindRef, KubeObject } from "../../api";
import type { Detected } from "../problems/model";
import { isKind, ROLLOUT, rolloutProblems } from "./model";

/** A Degraded phase the next reconcile clears (a progress deadline being re-checked) passes quietly. */
export const ROLLOUT_GRACE_MS = 60_000;

export function rolloutProblemsDetected(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  if (!isKind(kind, ROLLOUT)) return [];
  return rolloutProblems(obj).map((p) => ({
    reason: p.reason,
    group: "rollout",
    message: p.message,
    ...(p.reason === "AnalysisFailed" ? { messageKey: "messages.analysisRun", messageParams: { name: p.messageParams?.name ?? "" } } : {}),
    graceMs: p.reason === "Degraded" ? ROLLOUT_GRACE_MS : undefined,
    notify: true,
  }));
}
