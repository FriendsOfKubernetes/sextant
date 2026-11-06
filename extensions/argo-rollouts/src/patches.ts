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
//                 it and with the conditions of Argo CD's Rollout `resume` action; it never writes `currentStepIndex`,
//                 but on a canary pause step the controller counts the step completed once no pause condition is
//                 left (pause.go `CompletedCanaryPauseStep`) and moves on, as after `promote`
//
// A status patch goes to the status subresource first (`resources.patch` with `subresource: "status"`, granted by
// `permissions.statusPatches`, ADR-0155); an API server that answers `notFound` there has no status subresource (Argo
// Rollouts v0.9), and the plugin then sends the "unified" patch (spec and status together) to the object itself — so
// does the extension. All are JSON merge patches, each sent once. Restart (`spec.restartAt`) is Sextant's own generic
// action and not here.
import { isSextantError, type JsonValue, type KubeObject, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
import {
  canarySteps,
  currentHash,
  currentStepIndex,
  fullyPromoted,
  get,
  isAborted,
  pauseConditions,
  rolloutPhase,
  specPaused,
  stableHash,
  strategyOf,
  updating,
} from "./model";

export type RolloutAction = "promote" | "promoteFull" | "abort" | "retry" | "pause" | "resume";

/** The manifest's action ids, by action. */
export const ACTION_IDS: Record<RolloutAction, string> = {
  promote: "promote",
  promoteFull: "promote-full",
  abort: "abort",
  retry: "retry",
  pause: "pause",
  resume: "resume",
};

/** The action of a manifest action id. */
export function actionOf(id: string): RolloutAction | undefined {
  return (Object.keys(ACTION_IDS) as RolloutAction[]).find((a) => ACTION_IDS[a] === id);
}

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

/** The patch shown when the status subresource is missing: only when there is a status patch to replace. */
export const fallbackOf = (plan: PatchPlan): Record<string, unknown> | undefined =>
  plan.status && plan.unified ? plan.unified : undefined;

// ---------- When each action applies ----------

/** Offered when the plugin's promote would move the Rollout on: paused, or a canary between its steps. */
export function canPromote(ro: KubeObject): boolean {
  if (isAborted(ro)) return false;
  return specPaused(ro) || pauseConditions(ro).length > 0 || rolloutPhase(ro).phase === "Paused" || updating(ro);
}

/** Resume is offered while the Rollout is paused by hand or by the controller (as Argo CD's `resume` action). */
export const canResume = (ro: KubeObject): boolean => specPaused(ro) || pauseConditions(ro).length > 0;

/**
 * Exactly when each action applies, as the built-in view decided it. The manifest's `when` (judged by Sextant without
 * extension code) cannot compare two fields, so for Promote, Promote fully and Abort it is a little wider; the
 * action's window checks this on a fresh read and says `whyNot` instead of offering the patches.
 */
export const APPLIES: Record<RolloutAction, (ro: KubeObject) => boolean> = {
  promote: canPromote,
  promoteFull: (ro) => !isAborted(ro) && (!fullyPromoted(ro) || specPaused(ro)),
  abort: (ro) => !isAborted(ro) && updating(ro),
  retry: isAborted,
  // The plugin pauses any Rollout; offered while it is not paused by hand already.
  pause: (ro) => !specPaused(ro),
  resume: canResume,
};

/** Sends `plan` as the plugin does: the status first, then the spec (the unified patch when status is not served). */
export async function sendPlan(sextant: Sextant, ref: ObjectRef, plan: PatchPlan): Promise<void> {
  let spec = plan.spec;
  if (plan.status) {
    try {
      await sextant.resources.patch({ ref, patch: plan.status as JsonValue, patchType: "merge", subresource: "status" });
    } catch (err) {
      if (!isSextantError(err, "notFound") || !plan.unified) throw err;
      spec = plan.unified;
    }
  }
  if (spec) await sextant.resources.patch({ ref, patch: spec as JsonValue, patchType: "merge" });
}
