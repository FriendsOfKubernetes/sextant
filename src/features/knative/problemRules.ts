// The problems of the Knative category (#213), for the problems screen, the counters and the notifications
// (`detect` in src/features/problems/model.ts calls these). Watched: Services and Configurations. A Service that is
// not ready is a problem; so is a Configuration of its own (one a Service made is told through that Service). A
// Revision is not watched: an old revision that failed is history, and the failure of the latest one is what makes
// its Configuration and Service not ready (ConfigurationsReady), so the latest revision's failure counts once, there.
import type { KindRef, KubeObject } from "../../api";
import type { Detected } from "../problems/model";
import { CONFIGURATION, failingCondition, KSERVICE, ownedByService, readyStatus, sameKind } from "./model";

/** A rollout the next reconcile fixes passes quietly (as `SHORT_GRACE_MS` of the problems model). */
export const KNATIVE_GRACE_MS = 2 * 60_000;

export function knativeProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  if (!sameKind(kind, KSERVICE) && !sameKind(kind, CONFIGURATION)) return [];
  if (sameKind(kind, CONFIGURATION) && ownedByService(obj)) return [];
  if (readyStatus(obj) !== "False") return [];
  const failing = failingCondition(obj);
  return [
    {
      reason: failing?.reason ?? "NotReady",
      group: "notReady",
      // Knative's message names the revision that failed ("Revision \"hello-00002\" failed with message: …").
      message: failing?.message,
      since: failing?.lastTransitionTime,
      graceMs: KNATIVE_GRACE_MS,
      notify: true,
    },
  ];
}
