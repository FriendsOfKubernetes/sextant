import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, kindFromApiVersion, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../actions";
import { getAction, getActionsFor, runAction, type ActionId } from "../actions/registry";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { detect } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import "../argocd";
import abortedJson from "./fixtures/rollout-aborted.json";
import analysisRunJson from "./fixtures/analysisrun-failed.json";
import blueGreenJson from "./fixtures/rollout-bluegreen.json";
import canaryJson from "./fixtures/rollout-canary-paused.json";
import replicaSetsJson from "./fixtures/replicasets.json";
import "./index";
import {
  actualWeight,
  ANALYSIS_RUN,
  ANALYSIS_TEMPLATE,
  CLUSTER_ANALYSIS_TEMPLATE,
  EXPERIMENT,
  metricResults,
  replicaSetsOf,
  ROLLOUT,
  rolloutPhase,
  rolloutProblems,
  setWeight,
  stepProgress,
  stepText,
} from "./model";
import { planFor } from "./patches";

const canary = canaryJson as unknown as KubeObject;
const aborted = abortedJson as unknown as KubeObject;
const blueGreen = blueGreenJson as unknown as KubeObject;
const analysisRun = analysisRunJson as unknown as KubeObject;
const replicaSets = replicaSetsJson as unknown as KubeObject[];

const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
const refTo = (obj: KubeObject): ObjectRef => ({ kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" });
const st = (obj: KubeObject) => obj.status as Record<string, unknown>;

describe("the Rollout model", () => {
  it("reads the phase as the plugin does: the controller's, unless the spec or an unpause is not observed yet", () => {
    expect(rolloutPhase(canary)).toEqual({ phase: "Paused", message: "CanaryPauseStep" });
    expect(rolloutPhase(aborted).phase).toBe("Degraded");
    const stale = copy(canary);
    stale.metadata!.generation = 3;
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
    expect(setWeight(canary)).toBe(20);
    // Without traffic routing: the canary ReplicaSet's share of the available pods (1 of 5).
    expect(actualWeight(canary, 1)).toBe(20);
    expect(setWeight(aborted)).toBe(0);
    const done = copy(canary);
    st(done).currentStepIndex = 8;
    expect(setWeight(done)).toBe(100);
    expect(actualWeight(done, undefined)).toBe(100);
    expect(actualWeight(blueGreen, 1)).toBeUndefined();
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
    const found = detect(ROLLOUT, aborted);
    expect(found.map((p) => [p.reason, p.group])).toEqual([
      ["Aborted", "rollout"],
      ["AnalysisFailed", "rollout"],
    ]);
    expect(found[1]?.message).toMatch(/assessed Failed/);
  });
});

describe("the patches, as kubectl argo rollouts builds them", () => {
  it("promote a canary paused at a pause step: clears the pause conditions (status)", () => {
    expect(planFor("promote", canary)).toEqual({
      status: { status: { pauseConditions: null } },
      unified: { spec: { paused: false }, status: { pauseConditions: null } },
    });
  });

  it("promote a rollout paused by hand: unpauses the spec too", () => {
    const paused = copy(canary);
    (paused.spec as Record<string, unknown>).paused = true;
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
    (paused.spec as Record<string, unknown>).paused = true;
    expect(planFor("pause", paused)).toEqual({});
  });

  it("resume: the plugin's former resume, each part only where it applies, never writing currentStepIndex", () => {
    // Paused at a pause step: the conditions go (status), the v0.9 fallback is the old command's whole patch.
    expect(planFor("resume", canary)).toEqual({
      status: { status: { pauseConditions: null } },
      unified: { spec: { paused: false }, status: { pauseConditions: null } },
    });
    // Paused by hand only: the spec alone.
    const byHand = copy(canary);
    (byHand.spec as Record<string, unknown>).paused = true;
    st(byHand).pauseConditions = null;
    expect(planFor("resume", byHand)).toEqual({ spec: { spec: { paused: false } } });
    // Not paused: nothing.
    expect(planFor("resume", aborted)).toEqual({});
  });
});

// ---------- In the app ----------

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch", "patch"],
  printerColumns: [],
});

const BUILT_IN: KindRef[] = [
  { group: "", version: "v1", kind: "Pod" },
  { group: "apps", version: "v1", kind: "ReplicaSet" },
];
const ARGO_CD: KindRef = { group: "argoproj.io", version: "v1alpha1", kind: "Application" };
const ROLLOUTS: KindRef[] = [ROLLOUT, ANALYSIS_RUN, ANALYSIS_TEMPLATE, CLUSTER_ANALYSIS_TEMPLATE, EXPERIMENT];

let wb: WatchBackend;
let discovery: KindRef[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
  discovery = [...BUILT_IN, ...ROLLOUTS, ARGO_CD];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map((k) => served(k, k.kind !== "ClusterAnalysisTemplate")));
  wb.backend.on("settings_get", () => defaultAppSettings());
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
});

const sectionNames = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the Argo Rollouts section", () => {
  it("is there beside Argo CD when the kinds are served, and not without them", async () => {
    const { unmount } = render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sectionNames()).toContain("Argo Rollouts"));
    expect(sectionNames()).toContain("Argo CD");
    fireEvent.click(screen.getByRole("button", { name: /Argo Rollouts/ }));
    const section = within(screen.getByRole("button", { name: /Argo Rollouts/ }).closest("li")!);
    for (const label of ["Rollouts", "Analysis Runs", "Analysis Templates", "Cluster Analysis Templates", "Experiments"]) {
      expect(section.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // Argo CD keeps its own kinds only.
    expect(getResourceDef(ROLLOUT).sidebar?.section).toBe("argoRollouts");
    expect(getResourceDef(ARGO_CD).sidebar?.section).toBe("argocd");
    unmount();
    resetClusterKinds();
    discovery = [...BUILT_IN, ARGO_CD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sectionNames()).toContain("Argo CD"));
    expect(sectionNames()).not.toContain("Argo Rollouts");
  });

  it("counts the rollouts that need attention on its header", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sectionNames()).toContain("Argo Rollouts"));
    emitSnapshot(wb, await watchOf(wb, "Rollout"), [canary, aborted]);
    await waitFor(() => expect(screen.getByTitle("1 rollout needs attention")).toHaveTextContent("1"));
  });

  it("the Rollouts table shows status, strategy, step and weight", () => {
    const def = getResourceDef(ROLLOUT);
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "status", "strategy", "step", "weight", "ready", "age"]);
    const col = (id: string) => def.columns.find((c) => c.id === id)!;
    expect(col("status").value(canary)).toBe("Paused");
    expect(col("strategy").value(blueGreen)).toBe("BlueGreen");
    expect(col("weight").value(canary)).toBe(20);
    expect(col("ready").value(canary)).toBe("5/5");
  });
});

// ---------- Details ----------

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

const listWatch = (kind: string) => watchOf(wb, kind, (s) => s.fieldSelector === null && s.labelSelector === null);

describe("details", () => {
  it("of a canary Rollout: status, steps with the current one, weights and its ReplicaSets by role", async () => {
    await openDetails(canary);
    const view = within(section("argoRollouts"));
    expect(view.getByText("Paused")).toHaveClass("rt-status--warning");
    expect(view.getAllByText("CanaryPauseStep")).toHaveLength(2);
    const current = document.querySelector("[aria-current='step']");
    expect(current).toHaveTextContent("pause");
    expect(view.getAllByRole("listitem")).toHaveLength(8);
    const rsWatch = await listWatch("ReplicaSet");
    expect(wb.specs.get(rsWatch)?.namespaces).toEqual(["shop"]);
    emitSnapshot(wb, rsWatch, replicaSets);
    emitSnapshot(wb, await listWatch("AnalysisRun"), []);
    await waitFor(() => expect(view.getByRole("button", { name: "Open ReplicaSet rollout-canary-7d8c6f9b5" })).toBeInTheDocument());
    expect(view.queryByRole("button", { name: "Open ReplicaSet other-5c5c5c5c5" })).toBeNull();
    expect(view.getByText("canary")).toBeInTheDocument();
    expect(view.getByText("stable")).toBeInTheDocument();
    // Set weight 20 %, actual 1 of 5 available pods.
    expect(view.getAllByText("20%")).toHaveLength(2);
    expect(await axeViolations(section("argoRollouts"))).toEqual([]);
  });

  it("of an aborted Rollout: says so and lists its failed analysis run with the reason", async () => {
    await openDetails(aborted);
    const view = within(section("argoRollouts"));
    expect(view.getByText(/The update was aborted/)).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open Service rollout-analysis-canary" })).toBeInTheDocument();
    emitSnapshot(wb, await listWatch("ReplicaSet"), []);
    emitSnapshot(wb, await listWatch("AnalysisRun"), [analysisRun]);
    await waitFor(() => expect(view.getByRole("button", { name: "Open AnalysisRun rollout-analysis-84c5f9d7b-3-1" })).toBeInTheDocument());
    expect(view.getAllByText(/failureLimit \(2\)/).length).toBeGreaterThan(0);
  });

  it("of a blue-green Rollout: the active and preview Services with what they select", async () => {
    await openDetails(blueGreen);
    const view = within(section("argoRollouts"));
    expect(view.getByRole("button", { name: "Open Service rollout-bluegreen-active" })).toHaveTextContent("rollout-bluegreen-active → 7b9f6c4d8");
    expect(view.getByRole("button", { name: "Open Service rollout-bluegreen-preview" })).toHaveTextContent("rollout-bluegreen-preview → 55d6b9f8c");
  });

  it("of an AnalysisRun: its Rollout and each metric with the failing measurement", async () => {
    await openDetails(analysisRun);
    const view = within(section("argoRollouts"));
    expect(view.getByRole("button", { name: "Open Rollout rollout-analysis" })).toBeInTheDocument();
    expect(view.getByText("success-rate")).toBeInTheDocument();
    expect(view.getByText("[0.62]")).toBeInTheDocument();
    expect(view.getByText("result[0] >= 0.95 is false")).toBeInTheDocument();
    expect(await axeViolations(section("argoRollouts"))).toEqual([]);
  });
});

// ---------- Actions ----------

const ACTIONS: ActionId[] = ["rolloutPromote", "rolloutPromoteFull", "rolloutAbort", "rolloutRetry"];
const offered = (obj: KubeObject) => getActionsFor([obj], kindOf(obj), ACTIONS).map((a) => a.id);
const calls = (cmd: string) => wb.backend.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

async function run(id: ActionId, obj: KubeObject) {
  await act(async () => {
    await runAction(getAction(id)!, "c1", kindOf(obj), [obj]);
  });
}

describe("the Rollout actions", () => {
  let live: KubeObject;
  beforeEach(() => {
    live = copy(canary);
    wb.backend.on("resource_get", () => copy(live));
    wb.backend.on("resource_patch_status", () => copy(live));
    wb.backend.on("resource_patch", () => copy(live));
    render(<ActionDialogHost />);
  });

  it("are offered as they apply", () => {
    expect(offered(canary)).toEqual(["rolloutPromote", "rolloutPromoteFull", "rolloutAbort"]);
    expect(offered(aborted)).toEqual(["rolloutRetry"]);
    expect(getResourceDef(ROLLOUT).actions).toEqual(expect.arrayContaining(ACTIONS));
    expect(getResourceDef(ANALYSIS_RUN).actions).toEqual(["edit", "delete"]);
  });

  it("Promote lists the exact patch, then sends it to the status subresource once", async () => {
    await run("rolloutPromote", canary);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText('{"status":{"pauseConditions":null}}')).toBeInTheDocument());
    expect(await axeViolations(dialog)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("resource_patch_status")).toEqual([
      { clusterId: "c1", ref: refTo(canary), patch: { status: { pauseConditions: null } }, patchType: "merge" },
    ]);
    expect(calls("resource_patch")).toEqual([]);
  });

  it("without a status subresource (v0.9) sends the unified patch to the rollout, as the plugin does", async () => {
    wb.backend.on("resource_patch_status", () => {
      throw { code: "notFound", message: "the server could not find the requested resource" };
    });
    await run("rolloutAbort", canary);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByText('{"status":{"abort":true}}')).toHaveLength(2));
    fireEvent.click(within(dialog).getByRole("button", { name: "Abort" }));
    await waitFor(() => expect(calls("resource_patch")).toHaveLength(1));
    expect(calls("resource_patch")[0]).toMatchObject({ patch: { status: { abort: true } }, patchType: "merge" });
  });

  it("Pause and Resume are offered as they apply; Pause sends the plugin's spec patch to the rollout once", async () => {
    const pauseResume: ActionId[] = ["rolloutPause", "rolloutResume"];
    const byHand = copy(aborted);
    (byHand.spec as Record<string, unknown>).paused = true;
    expect(getActionsFor([canary], ROLLOUT, pauseResume).map((a) => a.id)).toEqual(pauseResume);
    expect(getActionsFor([aborted], ROLLOUT, pauseResume).map((a) => a.id)).toEqual(["rolloutPause"]);
    expect(getActionsFor([byHand], ROLLOUT, pauseResume).map((a) => a.id)).toEqual(["rolloutResume"]);
    expect(getResourceDef(ROLLOUT).actions).toEqual(expect.arrayContaining(pauseResume));

    await run("rolloutPause", canary);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText('{"spec":{"paused":true}}')).toBeInTheDocument());
    expect(await axeViolations(dialog)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("resource_patch")).toEqual([{ clusterId: "c1", ref: refTo(canary), patch: { spec: { paused: true } }, patchType: "merge" }]);
    expect(calls("resource_patch_status")).toEqual([]);
  });

  it("Resume lists the status patch and its v0.9 fallback, then sends the status patch once", async () => {
    await run("rolloutResume", canary);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText('{"status":{"pauseConditions":null}}')).toBeInTheDocument());
    expect(within(dialog).getByText('{"spec":{"paused":false},"status":{"pauseConditions":null}}')).toBeInTheDocument();
    // pause.go `CompletedCanaryPauseStep`: a controller pause with no pause condition left completes the canary pause
    // step, so the rollout moves on as with Promote — the dialog must not say otherwise.
    expect(within(dialog).getByText(/counts that step as completed and goes on to the next step, as with Promote/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/does not move the rollout/)).toBeNull();
    expect(await axeViolations(dialog)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("resource_patch_status")).toEqual([
      { clusterId: "c1", ref: refTo(canary), patch: { status: { pauseConditions: null } }, patchType: "merge" },
    ]);
    expect(calls("resource_patch")).toEqual([]);
  });

  it("Pause of a rollout someone paused meanwhile says so and sends nothing", async () => {
    await run("rolloutPause", canary);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText('{"spec":{"paused":true}}')).toBeInTheDocument());
    (live.spec as Record<string, unknown>).paused = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(within(dialog).getByText(/already paused/)).toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(calls("resource_patch")).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sends nothing when the rollout changed since the dialog showed the patches", async () => {
    await run("rolloutPromote", canary);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText('{"status":{"pauseConditions":null}}')).toBeInTheDocument());
    (live.spec as Record<string, unknown>).paused = true;
    fireEvent.click(within(dialog).getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(within(dialog).getByText(/changed while this dialog was open/)).toBeInTheDocument());
    expect(within(dialog).getByText('{"spec":{"paused":false}}')).toBeInTheDocument();
    expect(calls("resource_patch_status")).toEqual([]);
    expect(calls("resource_patch")).toEqual([]);
  });
});
