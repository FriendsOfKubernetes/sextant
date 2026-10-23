// What the JobSet section reads from jobset.x-k8s.io/v1alpha2 JobSets, as the JobSet controller writes them
// (kubernetes-sigs/jobset, api/jobset/v1alpha2/jobset_types.go and pkg/controllers): the state from its conditions and
// `terminalState`, the replicated jobs with their counts, the restarts against `failurePolicy.maxRestarts`, the
// success and failure policies, and the first failed Job the Failed condition names. Its Jobs carry the label
// `jobset.sigs.k8s.io/jobset-name`. Pure functions, no React.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";

const { arr, get, num, record, str } = status;

export const JOBSET_GROUP = "jobset.x-k8s.io";
export const JOBSET: KindRef = { group: JOBSET_GROUP, version: "v1alpha2", kind: "JobSet" };

export const isJobSet = (kind: Pick<KindRef, "group" | "kind">): boolean => kind.group === JOBSET_GROUP && kind.kind === "JobSet";

/** Labels the controller puts on a JobSet's Jobs (and, through their templates, on the pods). */
export const JOBSET_NAME_LABEL = "jobset.sigs.k8s.io/jobset-name";
export const REPLICATED_JOB_LABEL = "jobset.sigs.k8s.io/replicatedjob-name";
export const JOB_INDEX_LABEL = "jobset.sigs.k8s.io/job-index";
export const RESTART_ATTEMPT_LABEL = "jobset.sigs.k8s.io/restart-attempt";

export interface Condition {
  status: string;
  reason?: string;
  message?: string;
  since?: string;
}

export function conditionOf(obj: KubeObject, type: string): Condition | undefined {
  const c = arr(get(obj, "status", "conditions")).find((x) => get(x, "type") === type);
  if (!c) return undefined;
  return {
    status: str(get(c, "status")) ?? "Unknown",
    reason: str(get(c, "reason")),
    message: str(get(c, "message")),
    since: str(get(c, "lastTransitionTime")),
  };
}

const isTrue = (obj: KubeObject, type: string) => conditionOf(obj, type)?.status === "True";

export type JobSetState = "completed" | "failed" | "suspended" | "restarting" | "starting" | "running" | "pending";

export const JOBSET_TONE: Record<JobSetState, Tone> = {
  completed: "success",
  failed: "danger",
  suspended: "muted",
  restarting: "warning",
  starting: "warning",
  running: "success",
  pending: "neutral",
};

export interface ReplicatedJobRow {
  name: string;
  replicas: number;
  completions?: number;
  parallelism?: number;
  ready: number;
  active: number;
  succeeded: number;
  failed: number;
  suspended: number;
  dependsOn: string[];
}

export function replicatedJobs(js: KubeObject): ReplicatedJobRow[] {
  const statuses = new Map(arr(get(js, "status", "replicatedJobsStatus")).map((s) => [str(get(s, "name")) ?? "", s]));
  return arr(get(js, "spec", "replicatedJobs")).map((r) => {
    const name = str(get(r, "name")) ?? "";
    const s = statuses.get(name);
    const count = (field: string) => num(get(s, field)) ?? 0;
    return {
      name,
      replicas: num(get(r, "replicas")) ?? 1,
      completions: num(get(r, "template", "spec", "completions")),
      parallelism: num(get(r, "template", "spec", "parallelism")),
      ready: count("ready"),
      active: count("active"),
      succeeded: count("succeeded"),
      failed: count("failed"),
      suspended: count("suspended"),
      dependsOn: arr(get(r, "dependsOn")).map((d) => `${str(get(d, "name")) ?? ""} (${str(get(d, "status")) ?? ""})`),
    };
  });
}

export function jobSetState(js: KubeObject): JobSetState {
  const terminal = str(get(js, "status", "terminalState"));
  if (terminal === "Completed" || isTrue(js, "Completed")) return "completed";
  if (terminal === "Failed" || isTrue(js, "Failed")) return "failed";
  if (isTrue(js, "Suspended") || get(js, "spec", "suspend") === true) return "suspended";
  if (isTrue(js, "RestartingJobSet")) return "restarting";
  if (isTrue(js, "StartupPolicyInProgress")) return "starting";
  if (replicatedJobs(js).some((r) => r.active > 0 || r.ready > 0)) return "running";
  return "pending";
}

export interface Restarts {
  /** Restarts of the whole JobSet (`status.restarts`). */
  total: number;
  /** Restarts that count toward `maxRestarts`: the JobSet's and, with RestartJob, its Jobs' (`totalRestartsCountTowardsMax`). */
  counted: number;
  /** `failurePolicy.maxRestarts`; `undefined` without a failure policy (the first failed Job fails the JobSet). */
  max?: number;
}

export function restartsOf(js: KubeObject): Restarts {
  const total = num(get(js, "status", "restarts")) ?? 0;
  // Before v0.6 there is no restartsCountTowardsMax: every restart counted.
  const own = num(get(js, "status", "restartsCountTowardsMax")) ?? total;
  const jobs = arr(get(js, "status", "replicatedJobsStatus"))
    .flatMap((s) => arr(get(s, "jobRestartsCountTowardsMax")))
    .reduce<number>((sum, n) => sum + (num(n) ?? 0), 0);
  const policy = get(js, "spec", "failurePolicy");
  return { total, counted: own + jobs, max: policy === undefined ? undefined : (num(get(policy, "maxRestarts")) ?? 0) };
}

/** The first failed Job the Failed condition names (`messageWithFirstFailedJob`: "… (first failed job: <name>)"). */
export function firstFailedJob(message: string | undefined): string | undefined {
  return message ? /\(first failed job: ([^)\s]+)\)\s*$/.exec(message)?.[1] : undefined;
}

export interface FailureRule {
  name: string;
  action: string;
  reasons: string[];
  patterns: string[];
  targets: string[];
}

export function failureRules(js: KubeObject): FailureRule[] {
  const strings = (v: unknown) => arr(v).map(str).filter((s): s is string => Boolean(s));
  return arr(get(js, "spec", "failurePolicy", "rules")).map((r) => ({
    name: str(get(r, "name")) ?? "",
    action: str(get(r, "action")) ?? "",
    reasons: strings(get(r, "onJobFailureReasons")),
    patterns: strings(get(r, "onJobFailureMessagePatterns")),
    targets: strings(get(r, "targetReplicatedJobs")),
  }));
}

export const successPolicyOf = (js: KubeObject) => ({
  operator: str(get(js, "spec", "successPolicy", "operator")) ?? "All",
  targets: arr(get(js, "spec", "successPolicy", "targetReplicatedJobs")).map(str).filter((s): s is string => Boolean(s)),
});

export const labelOf = (obj: KubeObject, key: string): string | undefined => str(record(obj.metadata?.labels)[key]);

// ---------- Jobs of a JobSet ----------

export type JobState = "complete" | "failed" | "suspended" | "active" | "pending";

export const JOB_TONE: Record<JobState, Tone> = {
  complete: "success",
  failed: "danger",
  suspended: "muted",
  active: "success",
  pending: "neutral",
};

/** A child Job's state and, when it failed, the reason and message of its Failed condition. */
export function jobState(job: KubeObject): { state: JobState; reason?: string; message?: string } {
  const failed = conditionOf(job, "Failed");
  if (failed?.status === "True") return { state: "failed", reason: failed.reason, message: failed.message };
  if (isTrue(job, "Complete")) return { state: "complete" };
  if (isTrue(job, "Suspended") || get(job, "spec", "suspend") === true) return { state: "suspended" };
  return { state: (num(get(job, "status", "active")) ?? 0) > 0 ? "active" : "pending" };
}

// ---------- Problems ----------

/** A failed JobSet is a problem for this long after it failed, as a failed Argo Workflow (#247). */
export const RECENT_FAILURE_MS = 24 * 3600_000;

/**
 * The problems of a JobSet (category `jobset`): failed — with the controller's reason (`FailedJobs`,
 * `ReachedMaxRestarts`, `FailJobSetFailurePolicyAction`, `DeadlineExceeded`, …) and message — for `RECENT_FAILURE_MS`
 * after the Failed condition's time; and, while it runs, restarts that leave at most one before `maxRestarts`.
 * `now` only for the table filter (the store applies `until` itself).
 */
export function jobSetProblems(js: KubeObject, now?: number): Detected[] {
  if (js.metadata?.deletionTimestamp) return [];
  const state = jobSetState(js);
  if (state === "failed") {
    const failed = conditionOf(js, "Failed");
    const since = failed?.since ?? str(js.metadata?.creationTimestamp);
    const at = since ? Date.parse(since) : NaN;
    const until = Number.isNaN(at) ? undefined : at + RECENT_FAILURE_MS;
    if (until !== undefined && now !== undefined && now >= until) return [];
    return [{ reason: failed?.reason || "Failed", group: "failed", message: failed?.message, since, until, notify: true }];
  }
  if (state === "completed" || state === "suspended") return [];
  const restarts = restartsOf(js);
  if (restarts.max !== undefined && restarts.max > 0 && restarts.counted > 0 && restarts.counted >= restarts.max - 1)
    return [
      {
        reason: "RestartsNearLimit",
        messageKey: "messages.jobsetRestarts",
        messageParams: { used: restarts.counted, max: restarts.max },
        stamp: String(restarts.counted),
        notify: true,
      },
    ];
  return [];
}

export const isProblem = (js: KubeObject): boolean => jobSetProblems(js, Date.now()).length > 0;
