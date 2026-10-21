// The patches of the Rollout actions, exactly as `kubectl argo rollouts` sends them (ADR-0097; the constants and
// `getPatches` of pkg/kubectl-argo-rollouts/cmd/promote/promote.go, abort/abort.go, retry/retry.go):
//
//   promote       spec  {"spec":{"paused":false}}                                  when spec.paused
//                 status, the first that applies:
//                   an inconclusive canary step analysis, paused by the controller:
//                        {"status":{"pauseConditions":null,"controllerPause":false,"currentStepIndex":i+1}}
//                   pause conditions:  {"status":{"pauseConditions":null}}
//                   a canary with steps: {"status":{"pauseConditions":null,"currentStepIndex":i+1}}
//                 (i+1 stays i at the end of the steps)
//   promote --full spec {"spec":{"paused":false}} when spec.paused; status {"status":{"promoteFull":true}} when the
//                 current template is not the stable one
//   abort         status {"status":{"abort":true}}
//   retry         status {"status":{"abort":false}}
//   pause         spec  {"spec":{"paused":true}}                                   (cmd/pause/pause.go, the object only)
//   resume        spec  {"spec":{"paused":false}} when spec.paused; status {"status":{"pauseConditions":null}} when
//                 pause conditions are set — the plugin's own `resume` before `promote` replaced it (argo-rollouts#277:
//                 `{"spec":{"paused":false},"status":{"pauseConditions":null}}`, sent whole), split as `promote` splits
//                 it and with the conditions of Argo CD's Rollout `resume` action; it never moves `currentStepIndex`
//
// A status patch goes to the status subresource first (`api.resources.patchStatus`); an API server that answers
// `notFound` there has no status subresource (Argo Rollouts v0.9), and the plugin then sends the "unified" patch
// (spec and status together) to the object itself — so does Sextant. All are JSON merge patches, sent once.
import { api, toApiError, type ClusterId, type KubeObject, type ObjectRef } from "../../api";
import { status } from "../../resources";
import { canarySteps, currentStepIndex, currentHash, pauseConditions, specPaused, stableHash, strategyOf } from "./model";

const { get } = status;

export type RolloutAction = "promote" | "promoteFull" | "abort" | "retry" | "pause" | "resume";

export interface PatchPlan {
  /** To the status subresource. */
  status?: Record<string, unknown>;
  /** To the object (spec). */
  spec?: Record<string, unknown>;
  /** To the object when the status subresource does not exist (v0.9): replaces `spec`. */
  unified?: Record<string, unknown>;
}

const UNPAUSE = { spec: { paused: false } };

/** `index + 1`, kept at the end of the steps (the plugin's `if *index < len(steps) { *index++ }`). */
function nextStep(ro: KubeObject): number | undefined {
  const index = currentStepIndex(ro);
  if (index === undefined) return undefined;
  return index < canarySteps(ro).length ? index + 1 : index;
}

function inconclusive(ro: KubeObject): boolean {
  return strategyOf(ro) === "canary" && get(ro, "status", "canary", "currentStepAnalysisRunStatus", "status") === "Inconclusive";
}

/** The patches of `action` for the Rollout as it is now (the plugin reads it right before patching too). */
export function planFor(action: RolloutAction, ro: KubeObject): PatchPlan {
  switch (action) {
    case "abort":
      return { status: { status: { abort: true } }, unified: { status: { abort: true } } };
    case "retry":
      return { status: { status: { abort: false } }, unified: { status: { abort: false } } };
    case "promoteFull":
      return {
        ...(specPaused(ro) ? { spec: UNPAUSE } : {}),
        ...(currentHash(ro) !== stableHash(ro) ? { status: { status: { promoteFull: true } } } : {}),
        unified: { spec: { paused: false }, status: { promoteFull: true } },
      };
    case "promote":
      return promotePlan(ro);
    case "pause":
      return specPaused(ro) ? {} : { spec: { spec: { paused: true } } };
    case "resume":
      return resumePlan(ro);
  }
}

function promotePlan(ro: KubeObject): PatchPlan {
  const plan: PatchPlan = { unified: { spec: { paused: false }, status: { pauseConditions: null } } };
  if (specPaused(ro)) plan.spec = UNPAUSE;
  const paused = pauseConditions(ro).length > 0;
  const next = nextStep(ro);
  if (inconclusive(ro) && paused && get(ro, "status", "controllerPause") === true) {
    if (next !== undefined) plan.status = { status: { pauseConditions: null, controllerPause: false, currentStepIndex: next } };
  } else if (paused) {
    plan.status = { status: { pauseConditions: null } };
  } else if (strategyOf(ro) === "canary" && next !== undefined) {
    plan.status = { status: { pauseConditions: null, currentStepIndex: next } };
    plan.unified = { spec: { paused: false }, status: { pauseConditions: null, currentStepIndex: next } };
  }
  return plan;
}

/** The plugin's former `resume`: unpause the spec and clear the pause conditions, each only where it is set. */
function resumePlan(ro: KubeObject): PatchPlan {
  const plan: PatchPlan = {};
  if (specPaused(ro)) plan.spec = UNPAUSE;
  if (pauseConditions(ro).length > 0) {
    plan.status = { status: { pauseConditions: null } };
    plan.unified = { spec: { paused: false }, status: { pauseConditions: null } };
  }
  return plan;
}

/** Whether the plan changes anything (a full promotion of a promoted, running Rollout does not). */
export const changesSomething = (plan: PatchPlan): boolean => Boolean(plan.status || plan.spec);

/** Sends `plan` as the plugin does: the status first, then the spec (the unified patch when status is not served). */
export async function sendPlan(clusterId: ClusterId, ref: ObjectRef, plan: PatchPlan): Promise<void> {
  let spec = plan.spec;
  if (plan.status) {
    try {
      await api.resources.patchStatus(clusterId, ref, plan.status, "merge");
    } catch (err) {
      if (toApiError(err).code !== "notFound" || !plan.unified) throw err;
      spec = plan.unified;
    }
  }
  if (spec) await api.resources.patch(clusterId, ref, spec, "merge");
}
