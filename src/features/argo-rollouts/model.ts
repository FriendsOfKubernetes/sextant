// What Argo Rollouts objects say, read the way `kubectl argo rollouts get rollout` reads them (ADR-0097): the phase
// of a Rollout (`GetRolloutPhase` / `CalculateRolloutPhase` of utils/rollout/rolloututil.go), its canary steps and
// weights (`GetCurrentCanaryStep`, `GetCurrentSetWeight` of utils/replicaset/canary.go; the actual weight as
// pkg/kubectl-argo-rollouts/info/rollout_info.go computes it), its ReplicaSets by `rollouts-pod-template-hash`, its
// AnalysisRuns and their failing measurements. No React here; the patches of the actions are in ./patches.ts.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, record, str } = status;

export const ROLLOUTS_GROUP = "argoproj.io";
const v1alpha1 = (kind: string): KindRef => ({ group: ROLLOUTS_GROUP, version: "v1alpha1", kind });

export const ROLLOUT = v1alpha1("Rollout");
export const ANALYSIS_RUN = v1alpha1("AnalysisRun");
export const ANALYSIS_TEMPLATE = v1alpha1("AnalysisTemplate");
export const CLUSTER_ANALYSIS_TEMPLATE = v1alpha1("ClusterAnalysisTemplate");
export const EXPERIMENT = v1alpha1("Experiment");

/** The kinds of the sidebar section, in its order. Argo CD's kinds share the group and are not among them. */
export const ROLLOUTS_KINDS = [
  { kind: ROLLOUT, label: "rollouts", order: 10, namespaced: true },
  { kind: ANALYSIS_RUN, label: "analysisRuns", order: 20, namespaced: true },
  { kind: ANALYSIS_TEMPLATE, label: "analysisTemplates", order: 30, namespaced: true },
  { kind: CLUSTER_ANALYSIS_TEMPLATE, label: "clusterAnalysisTemplates", order: 40, namespaced: false },
  { kind: EXPERIMENT, label: "experiments", order: 50, namespaced: true },
] as const;

export const isKind = (kind: Pick<KindRef, "group" | "kind">, ...of: KindRef[]): boolean =>
  of.some((k) => k.group === kind.group && k.kind === kind.kind);

/** One of the section's kinds (never an Argo CD kind of the same group). */
export const isRolloutsKind = (kind: Pick<KindRef, "group" | "kind">): boolean =>
  ROLLOUTS_KINDS.some((d) => isKind(kind, d.kind));

/** The label the controller puts on a Rollout's ReplicaSets and pods: the hash of the pod template. */
export const POD_TEMPLATE_HASH_LABEL = "rollouts-pod-template-hash";
/** The revision of a ReplicaSet the controller keeps (as Deployments' `deployment.kubernetes.io/revision`). */
export const REVISION_ANNOTATION = "rollout.argoproj.io/revision";
const WORKLOAD_GENERATION_ANNOTATION = "rollout.argoproj.io/workload-generation";

// ---------- Phase ----------

export type RolloutPhase = "Healthy" | "Progressing" | "Paused" | "Degraded";

export interface PhaseOf {
  phase: RolloutPhase;
  /** The controller's message (text from the cluster). */
  message?: string;
  /** Sextant's explanation when the phase is computed here: a key under `argorollouts:phaseReason`. */
  reasonKey?: string;
}

const PHASES = new Set<string>(["Healthy", "Progressing", "Paused", "Degraded"]);

export const PHASE_TONE: Record<RolloutPhase, Tone> = {
  Healthy: "success",
  Progressing: "neutral",
  Paused: "warning",
  Degraded: "danger",
};

/** `status.observedGeneration` is a string; an old (v0.9) one is a hash, which counts as observed. */
function generationObserved(ro: KubeObject): boolean {
  const observed = str(get(ro, "status", "observedGeneration"));
  if (!observed || !/^\d+$/.test(observed)) return true;
  const generation = ro.metadata?.generation;
  if (typeof generation !== "number") return true;
  return Number(observed) >= generation;
}

export const pauseConditions = (ro: KubeObject): unknown[] => arr(get(ro, "status", "pauseConditions"));
export const isAborted = (ro: KubeObject): boolean => get(ro, "status", "abort") === true;
export const specPaused = (ro: KubeObject): boolean => get(ro, "spec", "paused") === true;
const controllerPause = (ro: KubeObject): boolean => get(ro, "status", "controllerPause") === true;

/** The phase as the plugin shows it: the controller's `status.phase` unless the spec or an unpause is not seen yet. */
export function rolloutPhase(ro: KubeObject): PhaseOf {
  if (!generationObserved(ro)) return { phase: "Progressing", reasonKey: "specNotObserved" };
  if (controllerPause(ro) && pauseConditions(ro).length === 0) return { phase: "Progressing", reasonKey: "unpausing" };
  if (get(ro, "spec", "templateResolvedFromRef") === true) {
    const wanted = str(record(ro.metadata?.annotations)[WORKLOAD_GENERATION_ANNOTATION]);
    const seen = str(get(ro, "status", "workloadObservedGeneration"));
    if (wanted && seen && /^\d+$/.test(seen) && wanted !== seen) return { phase: "Progressing", reasonKey: "workloadNotObserved" };
  }
  const phase = str(get(ro, "status", "phase"));
  if (phase && PHASES.has(phase)) return { phase: phase as RolloutPhase, message: str(get(ro, "status", "message")) || undefined };
  return calculatePhase(ro);
}

/** `CalculateRolloutPhase`: for a controller older than v1.0, which writes no `status.phase`. */
function calculatePhase(ro: KubeObject): PhaseOf {
  for (const c of arr(get(ro, "status", "conditions"))) {
    const message = str(get(c, "message"));
    if (get(c, "type") === "InvalidSpec") return { phase: "Degraded", message: `InvalidSpec: ${message ?? ""}` };
    const reason = str(get(c, "reason"));
    if (reason === "RolloutAborted" || reason === "ProgressDeadlineExceeded") {
      return { phase: "Degraded", message: `${reason}: ${message ?? ""}` };
    }
  }
  if (specPaused(ro)) return { phase: "Paused", reasonKey: "manuallyPaused" };
  const pause = pauseConditions(ro)[0];
  if (pause) return { phase: "Paused", message: str(get(pause, "reason")) };
  const restartAt = str(get(ro, "spec", "restartAt"));
  if (restartAt && restartAt !== str(get(ro, "status", "restartedAt"))) return { phase: "Progressing", reasonKey: "restarting" };
  const s = (field: string) => num(get(ro, "status", field)) ?? 0;
  const desired = num(get(ro, "spec", "replicas")) ?? 1;
  if (s("updatedReplicas") < desired) return { phase: "Progressing", reasonKey: "updating" };
  if (s("availableReplicas") < s("updatedReplicas")) return { phase: "Progressing", reasonKey: "becomingAvailable" };
  const stable = stableHash(ro);
  if (strategyOf(ro) === "blueGreen") {
    const active = str(get(ro, "status", "blueGreen", "activeSelector"));
    if (!active || active !== currentHash(ro)) return { phase: "Progressing", reasonKey: "cutoverPending" };
    if (!stable || !fullyPromoted(ro)) return { phase: "Progressing", reasonKey: "postPromotion" };
  } else if (strategyOf(ro) === "canary") {
    if (!get(ro, "spec", "strategy", "canary", "trafficRouting") && s("replicas") > s("updatedReplicas")) {
      return { phase: "Progressing", reasonKey: "oldReplicas" };
    }
    if (!stable || !fullyPromoted(ro)) return { phase: "Progressing", reasonKey: "steps" };
  }
  return { phase: "Healthy" };
}

// ---------- Strategy, steps, weights ----------

export type Strategy = "canary" | "blueGreen";

export function strategyOf(ro: KubeObject): Strategy | undefined {
  if (get(ro, "spec", "strategy", "canary")) return "canary";
  if (get(ro, "spec", "strategy", "blueGreen")) return "blueGreen";
  return undefined;
}

export const stableHash = (ro: KubeObject): string | undefined => str(get(ro, "status", "stableRS"));
export const currentHash = (ro: KubeObject): string | undefined => str(get(ro, "status", "currentPodHash"));
/** The new template is the stable one: nothing is being rolled out. */
export const fullyPromoted = (ro: KubeObject): boolean => Boolean(stableHash(ro)) && stableHash(ro) === currentHash(ro);

export const canarySteps = (ro: KubeObject): Record<string, unknown>[] =>
  arr(get(ro, "spec", "strategy", "canary", "steps")).map(record);

/** `GetCurrentCanaryStep`'s index: `status.currentStepIndex`, 0 when unset; `undefined` without canary steps. */
export function currentStepIndex(ro: KubeObject): number | undefined {
  if (strategyOf(ro) !== "canary" || canarySteps(ro).length === 0) return undefined;
  return num(get(ro, "status", "currentStepIndex")) ?? 0;
}

/** Whether the current step index points past the last step (all steps done). */
function stepsDone(ro: KubeObject): boolean {
  const index = currentStepIndex(ro);
  return index === undefined || index >= canarySteps(ro).length;
}

/** `weightutil.MaxTrafficWeight`: `trafficRouting.maxTrafficWeight`, else 100. */
export function maxWeight(ro: KubeObject): number {
  return num(get(ro, "spec", "strategy", "canary", "trafficRouting", "maxTrafficWeight")) ?? 100;
}

/** `GetCurrentSetWeight`: the desired canary weight (0 after an abort; the maximum once every step is done). */
export function setWeight(ro: KubeObject): number {
  if (isAborted(ro)) return 0;
  if (stepsDone(ro)) return maxWeight(ro);
  const steps = canarySteps(ro);
  for (let i = currentStepIndex(ro) ?? 0; i >= 0; i--) {
    const weight = num(steps[i]?.setWeight);
    if (weight !== undefined) return weight;
  }
  return 0;
}

/** A step as the plugin prints it (`CanaryStepString`): the API's own words, never translated. */
export function stepText(step: Record<string, unknown>): string {
  const weight = num(step.setWeight);
  if (weight !== undefined) return `setWeight: ${weight}`;
  if (step.pause !== undefined) {
    const duration = get(step.pause, "duration");
    return duration === undefined ? "pause" : `pause: ${String(duration)}`;
  }
  if (step.experiment !== undefined) return "experiment";
  if (step.analysis !== undefined) return "analysis";
  const scale = record(step.setCanaryScale);
  if (step.setCanaryScale !== undefined) {
    if (num(scale.weight) !== undefined) return `setCanaryScale{weight: ${num(scale.weight)}}`;
    if (scale.matchTrafficWeight === true) return "setCanaryScale{matchTrafficWeight: true}";
    if (num(scale.replicas) !== undefined) return `setCanaryScale{replicas: ${num(scale.replicas)}}`;
  }
  if (step.plugin !== undefined) return `plugin: ${str(get(step.plugin, "name")) ?? ""}`;
  if (step.setHeaderRoute !== undefined) return `setHeaderRoute: ${str(get(step.setHeaderRoute, "name")) ?? ""}`;
  if (step.setMirrorRoute !== undefined) return `setMirrorRoute: ${str(get(step.setMirrorRoute, "name")) ?? ""}`;
  return "invalid";
}

/** "3/8" as the plugin's Step column: the current step index of the number of steps; `undefined` without steps. */
export function stepProgress(ro: KubeObject): string | undefined {
  const index = currentStepIndex(ro);
  return index === undefined ? undefined : `${index}/${canarySteps(ro).length}`;
}

/**
 * The weight the canary really has, as `kubectl argo rollouts get` shows it: the maximum when all steps are done;
 * with traffic routing the router's reported `status.canary.weights.canary.weight` (else the set weight); without
 * it the canary ReplicaSet's share of the available pods (`canaryAvailable`, `undefined` while not known). 0 while
 * nothing is available.
 */
export function actualWeight(ro: KubeObject, canaryAvailable: number | undefined): number | undefined {
  if (strategyOf(ro) !== "canary") return undefined;
  if (stepsDone(ro)) return maxWeight(ro);
  const available = num(get(ro, "status", "availableReplicas")) ?? 0;
  if (available <= 0) return 0;
  if (!get(ro, "spec", "strategy", "canary", "trafficRouting")) {
    return canaryAvailable === undefined ? undefined : Math.floor((canaryAvailable * maxWeight(ro)) / available);
  }
  return num(get(ro, "status", "canary", "weights", "canary", "weight")) ?? setWeight(ro);
}

export interface BlueGreenServices {
  active?: string;
  preview?: string;
  /** The template hashes the Services select now. */
  activeSelector?: string;
  previewSelector?: string;
}

export function blueGreenServices(ro: KubeObject): BlueGreenServices {
  const spec = get(ro, "spec", "strategy", "blueGreen");
  const st = get(ro, "status", "blueGreen");
  return {
    active: str(get(spec, "activeService")),
    preview: str(get(spec, "previewService")),
    activeSelector: str(get(st, "activeSelector")),
    previewSelector: str(get(st, "previewSelector")),
  };
}

/** The canary's stable and canary Services, when the strategy names them. */
export function canaryServices(ro: KubeObject): { stable?: string; canary?: string } {
  const canary = get(ro, "spec", "strategy", "canary");
  return { stable: str(get(canary, "stableService")), canary: str(get(canary, "canaryService")) };
}

// ---------- ReplicaSets ----------

export type ReplicaSetRole = "stable" | "canary" | "active" | "preview" | "old";

export interface RolloutReplicaSet {
  obj: KubeObject;
  name: string;
  hash: string | undefined;
  revision: number | undefined;
  role: ReplicaSetRole;
  desired: number;
  available: number;
}

const ownedBy = (obj: KubeObject, uid: string | undefined): boolean =>
  Boolean(uid) && arr(obj.metadata?.ownerReferences).some((o) => get(o, "uid") === uid);

const createdAt = (obj: KubeObject): number => Date.parse(str(obj.metadata?.creationTimestamp) ?? "") || 0;

/** The role of the ReplicaSet with template hash `hash`, as the plugin marks them (stable, canary, active, preview). */
export function roleOf(ro: KubeObject, hash: string | undefined): ReplicaSetRole {
  if (!hash) return "old";
  if (strategyOf(ro) === "blueGreen") {
    const services = blueGreenServices(ro);
    if (hash === services.activeSelector) return "active";
    if (hash === services.previewSelector) return "preview";
  }
  if (hash === stableHash(ro)) return "stable";
  if (hash === currentHash(ro)) return strategyOf(ro) === "blueGreen" ? "preview" : "canary";
  return "old";
}

/** The Rollout's ReplicaSets (owned by its uid), newest revision first. */
export function replicaSetsOf(ro: KubeObject, replicaSets: Iterable<KubeObject>): RolloutReplicaSet[] {
  const out: RolloutReplicaSet[] = [];
  for (const rs of replicaSets) {
    if (!ownedBy(rs, ro.metadata?.uid)) continue;
    const hash = str(record(rs.metadata?.labels)[POD_TEMPLATE_HASH_LABEL]);
    const revision = Number(str(record(rs.metadata?.annotations)[REVISION_ANNOTATION]));
    out.push({
      obj: rs,
      name: rs.metadata?.name ?? "",
      hash,
      revision: Number.isFinite(revision) ? revision : undefined,
      role: roleOf(ro, hash),
      desired: num(get(rs, "spec", "replicas")) ?? 0,
      available: num(get(rs, "status", "availableReplicas")) ?? 0,
    });
  }
  return out.sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0) || createdAt(b.obj) - createdAt(a.obj));
}

/** Available pods of the canary ReplicaSet (`currentPodHash`, not the stable one); `undefined` when there is none. */
export function canaryAvailable(ro: KubeObject, sets: readonly RolloutReplicaSet[]): number | undefined {
  if (fullyPromoted(ro)) return undefined;
  return sets.find((s) => s.hash && s.hash === currentHash(ro))?.available;
}

// ---------- AnalysisRuns and Experiments ----------

/** Phases of an AnalysisRun, a measurement and an Experiment (`AnalysisPhase`). */
export const ANALYSIS_TONE: Record<string, Tone> = {
  Pending: "neutral",
  Running: "neutral",
  Successful: "success",
  Failed: "danger",
  Error: "danger",
  Inconclusive: "warning",
};

export const analysisTone = (phase: string | undefined): Tone => (phase ? (ANALYSIS_TONE[phase] ?? "neutral") : "neutral");
export const analysisPhase = (obj: KubeObject): string | undefined => str(get(obj, "status", "phase"));

const FAILING = new Set(["Failed", "Error", "Inconclusive"]);

/** Newest AnalysisRuns shown in a Rollout's details. */
export const MAX_ANALYSIS_RUNS = 20;
/** Measurements kept per metric in an AnalysisRun's details (the controller keeps 10 by default). */
export const MAX_MEASUREMENTS = 10;

/** The Rollout's AnalysisRuns (owned by its uid), newest first, at most `MAX_ANALYSIS_RUNS`. */
export function analysisRunsOf(ro: KubeObject, runs: Iterable<KubeObject>): KubeObject[] {
  return [...runs]
    .filter((r) => ownedBy(r, ro.metadata?.uid))
    .sort((a, b) => createdAt(b) - createdAt(a))
    .slice(0, MAX_ANALYSIS_RUNS);
}

export interface Measurement {
  phase?: string;
  value?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface MetricResult {
  name: string;
  phase?: string;
  message?: string;
  count: number;
  successful: number;
  failed: number;
  inconclusive: number;
  error: number;
  /** The newest measurements, newest first. */
  measurements: Measurement[];
  /** The newest failed, errored or inconclusive measurement: what made the metric fail. */
  failing?: Measurement;
}

function measurement(m: unknown): Measurement {
  return {
    phase: str(get(m, "phase")),
    value: str(get(m, "value")),
    message: str(get(m, "message")),
    startedAt: str(get(m, "startedAt")),
    finishedAt: str(get(m, "finishedAt")),
  };
}

/** `status.metricResults` of an AnalysisRun with their counts and the failing measurement. */
export function metricResults(run: KubeObject): MetricResult[] {
  return arr(get(run, "status", "metricResults")).map((r) => {
    const all = arr(get(r, "measurements")).map(measurement).reverse();
    return {
      name: str(get(r, "name")) ?? "",
      phase: str(get(r, "phase")),
      message: str(get(r, "message")),
      count: num(get(r, "count")) ?? 0,
      successful: num(get(r, "successful")) ?? 0,
      failed: num(get(r, "failed")) ?? 0,
      inconclusive: num(get(r, "inconclusive")) ?? 0,
      error: num(get(r, "error")) ?? 0,
      measurements: all.slice(0, MAX_MEASUREMENTS),
      failing: all.find((m) => m.phase && FAILING.has(m.phase)),
    };
  });
}

/** Why an AnalysisRun did not succeed: its own message, else the first failing metric's. */
export function analysisFailure(run: KubeObject): string | undefined {
  const own = str(get(run, "status", "message"));
  if (own) return own;
  const metric = metricResults(run).find((m) => m.phase && FAILING.has(m.phase));
  if (!metric) return undefined;
  return metric.message ?? metric.failing?.message ?? undefined;
}

/** The metrics an AnalysisTemplate defines, with their provider (`prometheus`, `web`, `job`, …). */
export function templateMetrics(obj: KubeObject): { name: string; provider?: string }[] {
  return arr(get(obj, "spec", "metrics")).map((m) => ({
    name: str(get(m, "name")) ?? "",
    provider: Object.keys(record(get(m, "provider")))[0],
  }));
}

// ---------- Problems ----------

/** The analysis runs a Rollout reports in its status, with where they run. */
export function reportedAnalyses(ro: KubeObject): { name: string; phase: string; message?: string }[] {
  const places = [
    get(ro, "status", "canary", "currentStepAnalysisRunStatus"),
    get(ro, "status", "canary", "currentBackgroundAnalysisRunStatus"),
    get(ro, "status", "blueGreen", "prePromotionAnalysisRunStatus"),
    get(ro, "status", "blueGreen", "postPromotionAnalysisRunStatus"),
  ];
  return places.flatMap((p) => {
    const name = str(get(p, "name"));
    const phase = str(get(p, "status"));
    return name && phase ? [{ name, phase, message: str(get(p, "message")) }] : [];
  });
}

export interface RolloutProblem {
  reason: "Degraded" | "Aborted" | "AnalysisFailed";
  message?: string;
  /** The analysis run a failed analysis is about. */
  messageParams?: Record<string, string>;
}

/** What needs attention on a Rollout: Degraded or aborted, and analysis runs that failed or errored. */
export function rolloutProblems(ro: KubeObject): RolloutProblem[] {
  const found: RolloutProblem[] = [];
  const { phase, message } = rolloutPhase(ro);
  if (isAborted(ro)) found.push({ reason: "Aborted", message: message ?? str(get(ro, "status", "message")) });
  else if (phase === "Degraded") found.push({ reason: "Degraded", message });
  for (const run of reportedAnalyses(ro)) {
    if (run.phase !== "Failed" && run.phase !== "Error") continue;
    found.push({
      reason: "AnalysisFailed",
      message: run.message,
      messageParams: { name: run.name, phase: run.phase },
    });
  }
  return found;
}
