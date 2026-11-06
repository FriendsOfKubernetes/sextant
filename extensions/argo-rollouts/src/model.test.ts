// The model, the patches and the manifest's declarative parts. The manifest's problem rules, action conditions and
// column cases are judged here by Sextant's own window engine (src/extensions/problemRules.ts, loaded at run time so
// the type check stays inside the extension) and compared with the model they replace.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import abortedJson from "../fixtures/rollout-aborted.json";
import analysisRunJson from "../fixtures/analysisrun-failed.json";
import blueGreenJson from "../fixtures/rollout-bluegreen.json";
import canaryJson from "../fixtures/rollout-canary-paused.json";
import replicaSetsJson from "../fixtures/replicasets.json";
import {
  actualWeight,
  canaryAvailable,
  metricResults,
  replicaSetsOf,
  rolloutPhase,
  rolloutProblems,
  setWeight,
  stepProgress,
  stepText,
  STRATEGY_TEXT,
  strategyOf,
} from "./model";
import { ACTION_IDS, APPLIES, planFor, type RolloutAction } from "./patches";

const canary = canaryJson as unknown as KubeObject;
const aborted = abortedJson as unknown as KubeObject;
const blueGreen = blueGreenJson as unknown as KubeObject;
const analysisRun = analysisRunJson as unknown as KubeObject;
const replicaSets = replicaSetsJson as unknown as KubeObject[];

const copy = <T>(value: T): T => structuredClone(value);
const st = (obj: KubeObject) => obj.status as Record<string, unknown>;
const spec = (obj: KubeObject) => obj.spec as Record<string, unknown>;

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  valueAt(obj: unknown, path: string): unknown;
  detectRule(rule: unknown, obj: KubeObject): { reason: string; message?: string; graceMs?: number; notify: boolean }[];
}
let engine: Engine;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  const path = join(here, "../../../src/extensions/problemRules.ts");
  engine = (await import(/* @vite-ignore */ path)) as Engine;
});

const holdsNow = (condition: unknown, obj: KubeObject, now = Date.now()) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && (v.activeFrom === undefined || v.activeFrom <= now) && (v.until === undefined || v.until > now);
};

/** What a computed column shows (as src/extensions/columns.tsx draws text, number and ratio cells). */
function cell(id: string, obj: KubeObject): string | undefined {
  const column = manifest.contributes.columns.find((c) => c.id === id)!;
  for (const c of (column as { cases?: { when: unknown; text: string }[] }).cases ?? []) if (holdsNow(c.when, obj)) return c.text;
  const first = (paths: string[] | undefined) =>
    (paths ?? []).map((p) => engine.valueAt(obj, p)).find((v) => v !== undefined && v !== null);
  const value = first(column.paths);
  const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
  if ((column as { format?: string }).format === "ratio") {
    const whole = first((column as { totalPaths?: string[] }).totalPaths);
    return scalar === undefined || whole === undefined ? undefined : `${scalar}/${String(whole)}`;
  }
  return scalar;
}

const rules = manifest.contributes.problems;
/** The reasons the manifest's rules find, as Sextant judges them (grace not applied). */
const detected = (obj: KubeObject) => rules.flatMap((rule) => engine.detectRule({ notify: true, toldThroughOwner: false, graceMinutes: 0, ...rule }, obj));

const ACTIONS = Object.keys(ACTION_IDS) as RolloutAction[];
const actionOf = (action: RolloutAction) => manifest.contributes.actions.find((a) => a.id === ACTION_IDS[action])!;

// ---------- The model ----------

describe("the Rollout model", () => {
  it("reads the phase as the plugin does: the controller's, unless the spec or an unpause is not observed yet", () => {
    expect(rolloutPhase(canary)).toEqual({ phase: "Paused", message: "CanaryPauseStep" });
    expect(rolloutPhase(aborted).phase).toBe("Degraded");
    const stale = copy(canary);
    stale.metadata.generation = 3;
    expect(rolloutPhase(stale)).toEqual({ phase: "Progressing", reasonKey: "specNotObserved" });
    const unpausing = copy(canary);
    st(unpausing).pauseConditions = null;
    expect(rolloutPhase(unpausing)).toEqual({ phase: "Progressing", reasonKey: "unpausing" });
    // An old controller writes no phase: computed from the conditions and the counts.
    const old = copy(aborted);
    delete st(old).phase;
    expect(rolloutPhase(old).phase).toBe("Degraded");
    expect(rolloutPhase(old).message).toMatch(/^RolloutAborted: /);
  });

  it("steps, set weight and actual weight", () => {
    expect(stepProgress(canary)).toBe("1/8");
    expect(stepText({ setWeight: 20 })).toBe("setWeight: 20");
    expect(stepText({ pause: {} })).toBe("pause");
    expect(stepText({ pause: { duration: "40s" } })).toBe("pause: 40s");
    expect(stepText({ setCanaryScale: { matchTrafficWeight: true } })).toBe("setCanaryScale{matchTrafficWeight: true}");
    expect(setWeight(canary)).toBe(20);
    // Without traffic routing: the canary ReplicaSet's share of the available pods (1 of 5).
    const sets = replicaSetsOf(canary, replicaSets);
    expect(canaryAvailable(canary, sets)).toBe(1);
    expect(actualWeight(canary, 1)).toBe(20);
    expect(setWeight(aborted)).toBe(0);
    const done = copy(canary);
    st(done).currentStepIndex = 8;
    expect(setWeight(done)).toBe(100);
    expect(actualWeight(done, undefined)).toBe(100);
    expect(actualWeight(blueGreen, 1)).toBeUndefined();
    // With traffic routing: the router's reported weight.
    const routed = copy(canary);
    (spec(routed).strategy as { canary: Record<string, unknown> }).canary.trafficRouting = { nginx: {} };
    st(routed).canary = { weights: { canary: { weight: 15 } } };
    expect(actualWeight(routed, undefined)).toBe(15);
  });

  it("finds its ReplicaSets by owner and marks them by template hash", () => {
    const sets = replicaSetsOf(canary, replicaSets);
    expect(sets.map((s) => [s.name, s.role, s.revision])).toEqual([
      ["rollout-canary-7d8c6f9b5", "canary", 2],
      ["rollout-canary-6c9f8b5d4", "stable", 1],
    ]);
  });

  it("an AnalysisRun's metrics name the failing measurement", () => {
    const [metric] = metricResults(analysisRun);
    expect(metric).toMatchObject({ name: "success-rate", phase: "Failed", failed: 3, successful: 1 });
    expect(metric?.failing).toMatchObject({ value: "[0.62]", message: "result[0] >= 0.95 is false" });
    expect(metric?.measurements[0]?.value).toBe("[0.62]");
  });

  it("problems: an aborted rollout and its failed analysis; none for a paused one", () => {
    expect(rolloutProblems(canary)).toEqual([]);
    expect(rolloutProblems(aborted).map((p) => p.reason)).toEqual(["Aborted", "AnalysisFailed"]);
  });
});

// ---------- The patches ----------

describe("the patches, as kubectl argo rollouts builds them", () => {
  it("promote a canary paused at a pause step: clears the pause conditions (status)", () => {
    expect(planFor("promote", canary)).toEqual({
      status: { status: { pauseConditions: null } },
      unified: { spec: { paused: false }, status: { pauseConditions: null } },
    });
  });

  it("promote a rollout paused by hand: unpauses the spec too", () => {
    const paused = copy(canary);
    spec(paused).paused = true;
    expect(planFor("promote", paused)).toEqual({
      spec: { spec: { paused: false } },
      status: { status: { pauseConditions: null } },
      unified: { spec: { paused: false }, status: { pauseConditions: null } },
    });
  });

  it("promote a canary between steps (running an analysis): goes to the next step", () => {
    const running = copy(canary);
    st(running).pauseConditions = [];
    st(running).controllerPause = false;
    expect(planFor("promote", running)).toEqual({
      status: { status: { pauseConditions: null, currentStepIndex: 2 } },
      unified: { spec: { paused: false }, status: { pauseConditions: null, currentStepIndex: 2 } },
    });
    // At the end of the steps the index stays.
    st(running).currentStepIndex = 8;
    expect(planFor("promote", running).status).toEqual({ status: { pauseConditions: null, currentStepIndex: 8 } });
  });

  it("promote after an inconclusive step analysis the controller paused: also lifts the controller's pause", () => {
    const inconclusive = copy(canary);
    st(inconclusive).canary = { currentStepAnalysisRunStatus: { name: "r", status: "Inconclusive" } };
    expect(planFor("promote", inconclusive).status).toEqual({
      status: { pauseConditions: null, controllerPause: false, currentStepIndex: 2 },
    });
  });

  it("promote a blue-green rollout waiting before promotion: clears the pause conditions", () => {
    expect(planFor("promote", blueGreen).status).toEqual({ status: { pauseConditions: null } });
  });

  it("promote --full, abort and retry", () => {
    expect(planFor("promoteFull", canary)).toEqual({
      status: { status: { promoteFull: true } },
      unified: { spec: { paused: false }, status: { promoteFull: true } },
    });
    const promoted = copy(canary);
    st(promoted).currentPodHash = st(promoted).stableRS;
    expect(planFor("promoteFull", promoted).status).toBeUndefined();
    expect(planFor("abort", canary)).toEqual({ status: { status: { abort: true } }, unified: { status: { abort: true } } });
    expect(planFor("retry", aborted)).toEqual({ status: { status: { abort: false } }, unified: { status: { abort: false } } });
  });

  it("pause: the plugin's spec patch to the object, nothing when it is paused by hand already", () => {
    expect(planFor("pause", canary)).toEqual({ spec: { spec: { paused: true } } });
    const paused = copy(canary);
    spec(paused).paused = true;
    expect(planFor("pause", paused)).toEqual({});
  });

  it("resume: the plugin's former resume, each part only where it applies, never writing currentStepIndex", () => {
    expect(planFor("resume", canary)).toEqual({
      status: { status: { pauseConditions: null } },
      unified: { spec: { paused: false }, status: { pauseConditions: null } },
    });
    const byHand = copy(canary);
    spec(byHand).paused = true;
    st(byHand).pauseConditions = null;
    expect(planFor("resume", byHand)).toEqual({ spec: { spec: { paused: false } } });
    expect(planFor("resume", aborted)).toEqual({});
  });
});

// ---------- The manifest, as Sextant judges it ----------

/** Rollouts in every state the actions tell apart. */
function states(): Record<string, KubeObject> {
  const promoted = copy(canary);
  st(promoted).currentPodHash = st(promoted).stableRS;
  st(promoted).phase = "Healthy";
  delete st(promoted).message;
  st(promoted).pauseConditions = null;
  st(promoted).controllerPause = false;
  const byHand = copy(promoted);
  spec(byHand).paused = true;
  st(byHand).phase = "Paused";
  const running = copy(canary);
  st(running).pauseConditions = [];
  st(running).controllerPause = false;
  st(running).phase = "Progressing";
  const old = copy(canary);
  delete st(old).phase;
  return { canary, aborted, blueGreen, promoted, byHand, running, old };
}

describe("the manifest's action conditions", () => {
  it("offer each action wherever it applies, and Retry, Pause and Resume exactly there", () => {
    for (const [name, ro] of Object.entries(states())) {
      for (const action of ACTIONS) {
        const offered = holdsNow(actionOf(action).when, ro);
        if (APPLIES[action](ro)) expect(offered, `${action} on ${name}`).toBe(true);
        if (action === "retry" || action === "pause" || action === "resume") expect(offered, `${action} on ${name}`).toBe(APPLIES[action](ro));
      }
    }
  });

  it("offer what the built-in view offered on the fixtures", () => {
    const offered = (ro: KubeObject) => ACTIONS.filter((a) => holdsNow(actionOf(a).when, ro));
    expect(offered(canary)).toEqual(["promote", "promoteFull", "abort", "pause", "resume"]);
    expect(offered(aborted)).toEqual(["retry", "pause"]);
    // A promoted, running Rollout: only Pause.
    expect(offered(states().promoted!)).toEqual(["pause"]);
  });

  it("are primary as the built-in buttons were, and Abort is dangerous", () => {
    const placement = Object.fromEntries(manifest.contributes.actions.map((a) => [a.id, a.placement]));
    expect(placement).toEqual({ promote: "primary", "promote-full": "more", abort: "primary", retry: "more", pause: "primary", resume: "primary" });
    expect(manifest.contributes.actions.filter((a) => (a as { danger?: boolean }).danger).map((a) => a.id)).toEqual(["abort"]);
  });
});

describe("the manifest's problem rules", () => {
  it("find what the built-in category `rollouts` found", () => {
    expect(detected(canary)).toEqual([]);
    expect(detected(blueGreen)).toEqual([]);
    const found = detected(aborted);
    expect(found.map((p) => p.reason)).toEqual(["Aborted", "Step analysis failed"]);
    expect(found[0]?.message).toMatch(/^The update was aborted: RolloutAborted: /);
    expect(found[1]?.message).toBe(
      'AnalysisRun rollout-analysis-84c5f9d7b-3-1 ended Failed: Metric "success-rate" assessed Failed due to failed (3) > failureLimit (2)',
    );
    expect(found.every((p) => p.notify)).toBe(true);
  });

  it("tell a Degraded rollout after a minute, also from an older controller's conditions", () => {
    const degraded = copy(canary);
    st(degraded).phase = "Degraded";
    st(degraded).message = "ProgressDeadlineExceeded: ReplicaSet has timed out progressing.";
    const [found] = detected(degraded);
    expect(found).toMatchObject({ reason: "Degraded", graceMs: 60_000 });
    expect(found?.message).toBe("The rollout is Degraded: ProgressDeadlineExceeded: ReplicaSet has timed out progressing.");
    const old = copy(canary);
    delete st(old).phase;
    st(old).conditions = [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }];
    expect(rolloutPhase(old).phase).toBe("Degraded");
    expect(detected(old).map((p) => p.reason)).toEqual(["Degraded"]);
  });

  it("tell each failed or errored analysis the Rollout reports", () => {
    const bg = copy(blueGreen);
    st(bg).blueGreen = { ...(st(bg).blueGreen as object), prePromotionAnalysisRunStatus: { name: "pre", status: "Error", message: "no data" } };
    expect(detected(bg).map((p) => p.reason)).toEqual(["Pre-promotion analysis failed"]);
    expect(rolloutProblems(bg).map((p) => p.run)).toEqual(["pre"]);
  });

  it("are counted on the section", () => {
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "argoRollouts" }]);
  });
});

describe("the manifest's columns", () => {
  it("show the status, strategy, step and readiness", () => {
    for (const ro of [canary, aborted, blueGreen]) {
      expect(cell("rollout-status", ro)).toBe(rolloutPhase(ro).phase);
      expect(cell("rollout-strategy", ro)).toBe(STRATEGY_TEXT[strategyOf(ro)!]);
    }
    expect(cell("rollout-step", canary)).toBe("1");
    expect(cell("rollout-ready", canary)).toBe("5/5");
    expect(cell("rollout-weight", aborted)).toBe("0");
    const unpausing = copy(canary);
    st(unpausing).pauseConditions = null;
    expect(cell("rollout-status", unpausing)).toBe(rolloutPhase(unpausing).phase);
    // An older controller: the phase where the fields tell it.
    const old = copy(aborted);
    delete st(old).phase;
    expect(cell("rollout-status", old)).toBe("Degraded");
    const oldPaused = copy(canary);
    delete st(oldPaused).phase;
    expect(cell("rollout-status", oldPaused)).toBe("Paused");
  });

  it("show an AnalysisRun's phase, Rollout and why it failed", () => {
    expect(cell("run-phase", analysisRun)).toBe("Failed");
    expect(cell("run-rollout", analysisRun)).toBe("rollout-analysis");
    expect(cell("run-message", analysisRun)).toMatch(/assessed Failed/);
  });
});
