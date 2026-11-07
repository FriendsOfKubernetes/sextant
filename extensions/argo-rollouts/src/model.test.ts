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
  analysisFailure,
  canaryAvailable,
  metricResults,
  ownerRollout,
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
  numberOf(value: unknown): number | undefined;
  fillTemplate(template: string, obj: KubeObject): string | null;
  detectRule(rule: unknown, obj: KubeObject): { reason: string; group: string; message?: string; graceMs?: number; notify: boolean }[];
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

interface Column {
  id: string;
  paths: string[];
  format?: string;
  totalPaths?: string[];
  tones?: Record<string, string>;
  tooltipPaths?: string[];
  cases?: { when: unknown; text: string; tone?: string; tooltip?: string }[];
}
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;

/** What a computed column shows and its tone (as src/extensions/columns.tsx draws text, number and ratio cells). */
function shown(id: string, obj: KubeObject): { text?: string; tone?: string } {
  const column = columnOf(id);
  for (const c of column.cases ?? []) if (holdsNow(c.when, obj)) return { text: c.text, tone: c.tone ?? column.tones?.[c.text] };
  const first = (paths: string[] | undefined) =>
    (paths ?? []).map((p) => engine.valueAt(obj, p)).find((v) => v !== undefined && v !== null);
  const value = first(column.paths);
  if (column.format === "ratio") {
    // With the whole there, a missing part is 0 (Kubernetes leaves zero counts out).
    const whole = engine.numberOf(first(column.totalPaths));
    const part = value === undefined && whole !== undefined ? 0 : engine.numberOf(value);
    return part === undefined || whole === undefined ? {} : { text: `${part}/${whole}` };
  }
  const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
  return { text: scalar, tone: scalar === undefined ? undefined : column.tones?.[scalar] };
}
const cell = (id: string, obj: KubeObject) => shown(id, obj).text;

/** A computed column's hover: the holding case's tooltip (placeholders filled), else the column's own `tooltipPaths`. */
function hover(id: string, obj: KubeObject): string | undefined {
  const column = columnOf(id);
  const own = () => (column.tooltipPaths ?? []).map((p) => engine.valueAt(obj, p)).find((v) => typeof v === "string" && v !== "") as string | undefined;
  const holding = (column.cases ?? []).find((c) => holdsNow(c.when, obj));
  if (holding?.tooltip === undefined) return own();
  return engine.fillTemplate(holding.tooltip, obj) ?? own();
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
  // Promoted, but scaling: Progressing with nothing to promote.
  const scaling = copy(promoted);
  st(scaling).phase = "Progressing";
  // A new Rollout the controller has not reconciled: no hashes yet.
  const fresh = copy(canary);
  delete st(fresh).currentPodHash;
  delete st(fresh).stableRS;
  st(fresh).pauseConditions = null;
  st(fresh).controllerPause = false;
  st(fresh).phase = "Progressing";
  const bgPromoted = copy(blueGreen);
  st(bgPromoted).currentPodHash = st(bgPromoted).stableRS;
  st(bgPromoted).pauseConditions = null;
  st(bgPromoted).phase = "Healthy";
  return { canary, aborted, blueGreen, promoted, byHand, running, old, scaling, fresh, bgPromoted };
}

/** The actions whose `when` is exactly the built-in condition; Promote and Promote fully are a little wider. */
const EXACT: RolloutAction[] = ["abort", "retry", "pause", "resume"];

describe("the manifest's action conditions", () => {
  it("offer each action wherever it applies, and Abort, Retry, Pause and Resume exactly there", () => {
    for (const [name, ro] of Object.entries(states())) {
      for (const action of ACTIONS) {
        const offered = holdsNow(actionOf(action).when, ro);
        if (APPLIES[action](ro)) expect(offered, `${action} on ${name}`).toBe(true);
        if (EXACT.includes(action)) expect(offered, `${action} on ${name}`).toBe(APPLIES[action](ro));
      }
    }
  });

  it("compare the current template with the stable one: Abort only while an update is under way", () => {
    const { promoted, scaling, fresh, running } = states();
    const abort = actionOf("abort").when;
    expect(holdsNow(abort, running!)).toBe(true);
    // The phase says Progressing, but the templates are the same: nothing to abort.
    expect(holdsNow(abort, scaling!)).toBe(false);
    expect(holdsNow(abort, promoted!)).toBe(false);
    expect(holdsNow(abort, fresh!)).toBe(false);
  });

  it("offer what the built-in view offered on the fixtures", () => {
    const offered = (ro: KubeObject) => ACTIONS.filter((a) => holdsNow(actionOf(a).when, ro));
    expect(offered(canary)).toEqual(["promote", "promoteFull", "abort", "pause", "resume"]);
    expect(offered(aborted)).toEqual(["retry", "pause"]);
    // A promoted, running Rollout: only Pause.
    expect(offered(states().promoted!)).toEqual(["pause"]);
    expect(offered(states().bgPromoted!)).toEqual(["pause"]);
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

  it("share the group `rollout`, so an analysis that fails and aborts the update notifies once", () => {
    expect(new Set(rules.map((r) => (r as { group?: string }).group))).toEqual(new Set(["rollout"]));
    expect(detected(aborted).map((p) => p.group)).toEqual(["rollout", "rollout"]);
  });

  it("tell a Degraded rollout after a minute, also from an older controller's conditions, by one rule", () => {
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
    // One rule, `degraded`, for every controller (#385): its title is the reason, as the built-in's.
    expect(detected(old).map((p) => p.reason)).toEqual(["Degraded"]);
    expect(rules.filter((r) => r.title.startsWith("Degraded")).map((r) => r.id)).toEqual(["degraded"]);
    // Argo Rollouts v0.9 writes a hash as `observedGeneration`: observed, so still Degraded.
    st(old).observedGeneration = "5b6c7d8f9";
    expect(rolloutPhase(old).phase).toBe("Degraded");
    expect(detected(old).map((p) => p.reason)).toEqual(["Degraded"]);
  });

  it("tell Degraded exactly where the phase reading says so", () => {
    const variants: Record<string, (ro: KubeObject) => void> = {
      degraded: (ro) => void (st(ro).phase = "Degraded"),
      // A stale condition of a controller that writes a phase: the phase decides.
      healthyWithOldCondition: (ro) => {
        st(ro).phase = "Healthy";
        st(ro).conditions = [{ type: "InvalidSpec", status: "False" }];
      },
      oldInvalidSpec: (ro) => {
        delete st(ro).phase;
        st(ro).conditions = [{ type: "InvalidSpec", status: "True", message: "bad" }];
      },
      // The controller lifted its pause and has not reconciled yet: Progressing.
      unpausing: (ro) => {
        st(ro).phase = "Degraded";
        st(ro).pauseConditions = null;
        st(ro).controllerPause = true;
      },
      // The workload the template comes from is not observed yet: Progressing.
      workloadNotObserved: (ro) => {
        st(ro).phase = "Degraded";
        spec(ro).templateResolvedFromRef = true;
        ro.metadata.annotations = { "rollout.argoproj.io/workload-generation": "4" };
        st(ro).workloadObservedGeneration = "3";
      },
      workloadObserved: (ro) => {
        st(ro).phase = "Degraded";
        spec(ro).templateResolvedFromRef = true;
        ro.metadata.annotations = { "rollout.argoproj.io/workload-generation": "4" };
        st(ro).workloadObservedGeneration = "4";
      },
      // The newest spec is not observed yet: Progressing, not Degraded (#377).
      specNotObserved: (ro) => {
        st(ro).phase = "Degraded";
        ro.metadata.generation = 5;
      },
      // v0.9 writes no phase and a hash as `observedGeneration`, which counts as observed.
      hashedGeneration: (ro) => {
        delete st(ro).phase;
        st(ro).conditions = [{ type: "InvalidSpec", status: "True", message: "bad" }];
        st(ro).observedGeneration = "5b6c7d8f9";
        ro.metadata.generation = 5;
      },
      // A phase Sextant does not know, from an older controller's conditions.
      unknownPhase: (ro) => {
        st(ro).phase = "Unknown";
        st(ro).conditions = [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }];
      },
      observedAsNumber: (ro) => {
        st(ro).phase = "Degraded";
        st(ro).observedGeneration = 2;
      },
      // v1.0+ with v0.9's hash left in `observedGeneration`: observed, so the phase decides.
      hashedWithPhase: (ro) => {
        st(ro).phase = "Degraded";
        st(ro).observedGeneration = "5b6c7d8f9";
        ro.metadata.generation = 5;
      },
      // An older controller that has not seen the newest spec: Progressing, not Degraded (#385).
      olderSpecNotObserved: (ro) => {
        delete st(ro).phase;
        st(ro).conditions = [{ type: "InvalidSpec", status: "True", message: "bad" }];
        ro.metadata.generation = 5;
      },
      olderUnpausing: (ro) => {
        delete st(ro).phase;
        st(ro).conditions = [{ type: "Progressing", status: "False", reason: "RolloutAborted" }];
        st(ro).pauseConditions = null;
        st(ro).controllerPause = true;
      },
      olderWorkloadNotObserved: (ro) => {
        delete st(ro).phase;
        st(ro).conditions = [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }];
        spec(ro).templateResolvedFromRef = true;
        ro.metadata.annotations = { "rollout.argoproj.io/workload-generation": "4" };
        st(ro).workloadObservedGeneration = "3";
      },
      // Neither generation written: observed.
      noGenerations: (ro) => {
        st(ro).phase = "Degraded";
        delete st(ro).observedGeneration;
        delete (ro.metadata as { generation?: number }).generation;
      },
      // An empty or hashed workload generation is not compared, as the built-in did not.
      workloadHashed: (ro) => {
        st(ro).phase = "Degraded";
        spec(ro).templateResolvedFromRef = true;
        ro.metadata.annotations = { "rollout.argoproj.io/workload-generation": "4" };
        st(ro).workloadObservedGeneration = "abc";
      },
      workloadWantedEmpty: (ro) => {
        st(ro).phase = "Degraded";
        spec(ro).templateResolvedFromRef = true;
        ro.metadata.annotations = { "rollout.argoproj.io/workload-generation": "" };
        st(ro).workloadObservedGeneration = "3";
      },
      // A paused controller with its pause conditions still there is no unpause.
      pausedWithConditions: (ro) => {
        st(ro).phase = "Degraded";
        st(ro).controllerPause = true;
      },
      // A known phase other than Degraded wins over an older controller's condition.
      progressingWithOldCondition: (ro) => {
        st(ro).phase = "Progressing";
        st(ro).conditions = [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }];
      },
      // An older controller with nothing wrong.
      olderHealthy: (ro) => {
        delete st(ro).phase;
        st(ro).conditions = [{ type: "Available", status: "True" }];
      },
      // Aborted: told as Aborted, never Degraded.
      abortedDegraded: (ro) => {
        st(ro).phase = "Degraded";
        st(ro).abort = true;
      },
    };
    for (const [name, change] of Object.entries(variants)) {
      for (const base of [canary, blueGreen, aborted]) {
        const ro = copy(base);
        change(ro);
        const builtIn = rolloutProblems(ro).filter((p) => p.reason === "Degraded").length;
        expect(detected(ro).filter((p) => p.reason === "Degraded").length, `${name} of ${ro.metadata.name}`).toBe(builtIn);
      }
    }
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

describe("the manifest's section", () => {
  it("has the built-in section's title and icon, in its old place (after Velero, ADR-0162), and leaves the CRDs' printer columns out", () => {
    expect(manifest.contributes.sections).toEqual([{ section: "argoRollouts", title: "Argo Rollouts", icon: "argoRollouts", after: "velero" }]);
    expect(manifest.contributes.kinds.every((k) => k.section === "argoRollouts" && k.printerColumns === false)).toBe(true);
  });
});

describe("the manifest's columns", () => {
  it("show the status, strategy, step and readiness", () => {
    for (const ro of [canary, aborted, blueGreen]) {
      expect(cell("rollout-status", ro)).toBe(rolloutPhase(ro).phase);
      expect(cell("rollout-strategy", ro)).toBe(STRATEGY_TEXT[strategyOf(ro)!]);
    }
    expect(cell("rollout-step", canary)).toBe(stepProgress(canary));
    expect(cell("rollout-step", canary)).toBe("1/8");
    expect(cell("rollout-step", blueGreen)).toBeUndefined();
    expect(cell("rollout-ready", canary)).toBe("5/5");
    expect(cell("rollout-weight", aborted)).toBe("0");
  });

  it("show step 0 of n before the controller writes the step index, as `GetCurrentCanaryStep`", () => {
    const fresh = copy(canary);
    delete st(fresh).currentStepIndex;
    expect(stepProgress(fresh)).toBe("0/8");
    expect(cell("rollout-step", fresh)).toBe(stepProgress(fresh));
    // No canary steps: no step, in both.
    const noSteps = copy(fresh);
    delete (spec(noSteps).strategy as { canary: Record<string, unknown> }).canary.steps;
    expect(stepProgress(noSteps)).toBeUndefined();
    expect(cell("rollout-step", noSteps)).toBeUndefined();
  });

  it("show the phase the plugin shows, in its tone, also where it is computed", () => {
    const tone = { Healthy: "ok", Progressing: "neutral", Paused: "warning", Degraded: "error" } as const;
    const unpausing = copy(canary);
    st(unpausing).pauseConditions = null;
    const workload = copy(canary);
    spec(workload).templateResolvedFromRef = true;
    workload.metadata.annotations = { "rollout.argoproj.io/workload-generation": "4" };
    st(workload).workloadObservedGeneration = "3";
    const old = copy(aborted);
    delete st(old).phase;
    const oldPaused = copy(canary);
    delete st(oldPaused).phase;
    const oldUpdating = copy(canary);
    delete st(oldUpdating).phase;
    st(oldUpdating).pauseConditions = null;
    st(oldUpdating).controllerPause = false;
    // The controller has not observed the newest spec: Progressing, whatever its phase says (#377).
    const specNotObserved = copy(aborted);
    specNotObserved.metadata.generation = 4;
    const specNotObservedPaused = copy(canary);
    st(specNotObservedPaused).observedGeneration = "1";
    // v0.9's hash in `observedGeneration` counts as observed, as does an object without a generation.
    const hashed = copy(aborted);
    st(hashed).observedGeneration = "5b6c7d8f9";
    const noGeneration = copy(canary);
    delete (noGeneration.metadata as { generation?: number }).generation;
    st(noGeneration).observedGeneration = "7";
    const states = { canary, aborted, blueGreen, unpausing, workload, old, oldPaused, oldUpdating, specNotObserved, specNotObservedPaused, hashed, noGeneration };
    expect(rolloutPhase(specNotObserved).reasonKey).toBe("specNotObserved");
    expect(rolloutPhase(specNotObservedPaused).reasonKey).toBe("specNotObserved");
    expect(rolloutPhase(hashed).phase).toBe("Degraded");
    expect(rolloutPhase(noGeneration).phase).toBe("Paused");
    for (const [name, ro] of Object.entries(states)) {
      const { phase } = rolloutPhase(ro);
      expect(shown("rollout-status", ro), name).toEqual({ text: phase, tone: tone[phase] });
    }
  });

  it("explain on hover that the controller has not seen the newest spec, as the built-in Status did", () => {
    const stale = copy(aborted);
    stale.metadata.generation = 4;
    expect(rolloutPhase(stale).reasonKey).toBe("specNotObserved");
    expect(hover("rollout-status", stale)).toBe("The controller has not seen the latest spec yet.");
    // Elsewhere the controller's own message, as before.
    expect(hover("rollout-status", aborted)).toBe(st(aborted).message);
    const hashed = copy(aborted);
    st(hashed).observedGeneration = "5b6c7d8f9";
    expect(hover("rollout-status", hashed)).toBe(st(aborted).message);
    // The one case with a tooltip, translated (the built-in's sentences) and never left in English.
    const status = columnOf("rollout-status");
    expect((status.cases ?? []).map((c) => c.tooltip !== undefined)).toEqual([true, false, false, false, false, false, false]);
    const translations = manifest.translations as Record<string, Record<string, string>>;
    for (const [language, texts] of Object.entries(translations)) {
      const text = texts["columns.rollout-status.cases.0.tooltip"];
      expect(text, language).toBeTruthy();
      expect(text, language).not.toBe(status.cases![0]!.tooltip);
    }
    expect(translations.de!["columns.rollout-status.cases.0.tooltip"]).toBe("Der Controller hat die neueste spec noch nicht gesehen.");
    expect(translations.ru!["columns.rollout-status.cases.0.tooltip"]).toBe("Контроллер ещё не увидел последнюю spec.");
  });

  it("keep the case texts the API's own words in every language", () => {
    const translations = manifest.translations as Record<string, Record<string, string>>;
    for (const column of manifest.contributes.columns as Column[]) {
      (column.cases ?? []).forEach((c, i) => {
        expect(c.tone, `${column.id} case ${i}`).toBeDefined();
        for (const texts of Object.values(translations)) expect(texts[`columns.${column.id}.cases.${i}.text`]).toBe(c.text);
      });
    }
  });

  it("show an AnalysisRun's phase, Rollout and why it failed", () => {
    expect(cell("run-phase", analysisRun)).toBe("Failed");
    expect(cell("run-rollout", analysisRun)).toBe("rollout-analysis");
    expect(cell("run-message", analysisRun)).toMatch(/assessed Failed/);
    expect(cell("run-message", analysisRun)).toBe(analysisFailure(analysisRun));
  });

  it("name the owning Rollout among other owners, and a failing metric's message, as the built-in view", () => {
    const run = copy(analysisRun);
    const owners = run.metadata.ownerReferences as unknown[] | undefined;
    run.metadata.ownerReferences = [{ apiVersion: "v1", kind: "ConfigMap", name: "other", uid: "1" }, ...(owners ?? [])] as never;
    expect(cell("run-rollout", run)).toBe(ownerRollout(run));
    delete st(run).message;
    st(run).metricResults = [
      { name: "ok", phase: "Successful", message: "fine" },
      { name: "bad", phase: "Error", measurements: [{ phase: "Error", message: "no data" }] },
    ];
    expect(cell("run-message", run)).toBe("no data");
    expect(analysisFailure(run)).toBe("no data");
    st(run).metricResults = [{ name: "ok", phase: "Successful", message: "fine" }];
    expect(cell("run-message", run)).toBeUndefined();
    expect(analysisFailure(run)).toBeUndefined();
  });
});
