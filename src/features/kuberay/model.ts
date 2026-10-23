// What the KubeRay section reads from ray.io/v1 objects, as the operator writes them (ray-operator/apis/ray/v1 in
// github.com/ray-project/kuberay): a RayCluster's head and worker groups, its deprecated `status.state` (ready /
// suspended / failed, the last one only from operators before 1.2) and the conditions that replace it
// (`RayClusterProvisioned`, `HeadPodReady`, `ReplicaFailure`, `RayClusterSuspending`, `RayClusterSuspended`); a
// RayJob's `jobStatus` (Ray's own: PENDING … FAILED) and `jobDeploymentStatus` (KubeRay's: Initializing … Failed); a
// RayService's `Ready` and `UpgradeInProgress` conditions (the deprecated `serviceStatus` "Running" before 1.3) and
// the Serve applications of its active and pending clusters. Pure functions, no React.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";

const { arr, get, num, record, str } = status;

export const RAY_GROUP = "ray.io";
const k = (kind: string): KindRef => ({ group: RAY_GROUP, version: "v1", kind });

export const RAY_CLUSTER = k("RayCluster");
export const RAY_JOB = k("RayJob");
export const RAY_SERVICE = k("RayService");

export interface RayKind {
  kind: KindRef;
  order: number;
  /** Key under `kuberay:sidebar`. */
  label: string;
}

export const RAY_KINDS: RayKind[] = [
  { kind: RAY_CLUSTER, order: 10, label: "rayClusters" },
  { kind: RAY_JOB, order: 20, label: "rayJobs" },
  { kind: RAY_SERVICE, order: 30, label: "rayServices" },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

export const rayKind = (kind: Pick<KindRef, "group" | "kind">): RayKind | undefined => RAY_KINDS.find((d) => isKind(kind, d.kind));

/** Labels KubeRay puts on the pods it creates (controllers/ray/utils/constant.go). */
export const CLUSTER_LABEL = "ray.io/cluster";
export const NODE_TYPE_LABEL = "ray.io/node-type";
export const GROUP_LABEL = "ray.io/group";

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

const isTrue = (c: Condition | undefined) => c?.status === "True";
const isFalse = (c: Condition | undefined) => c?.status === "False";

// ---------- RayCluster ----------

export type ClusterState = "ready" | "provisioning" | "headNotReady" | "suspending" | "suspended" | "failed";

export const CLUSTER_TONE: Record<ClusterState, Tone> = {
  ready: "success",
  provisioning: "warning",
  headNotReady: "danger",
  suspending: "muted",
  suspended: "muted",
  failed: "danger",
};

/**
 * A RayCluster's state. Conditions first (KubeRay 1.2+; `RayClusterStatusConditions` is on by default since 1.3):
 * suspension, a pod KubeRay could not create or delete (`ReplicaFailure`), the head pod not ready, all pods ready once
 * (`RayClusterProvisioned`, which never turns back). Without conditions the deprecated `status.state`: `ready`,
 * `suspended`, or `failed` (written only by operators before 1.2).
 */
export function clusterState(obj: KubeObject): ClusterState {
  const state = str(get(obj, "status", "state"));
  if (isTrue(conditionOf(obj, "RayClusterSuspending"))) return "suspending";
  if (isTrue(conditionOf(obj, "RayClusterSuspended")) || state === "suspended") return "suspended";
  if (isTrue(conditionOf(obj, "ReplicaFailure")) || state === "failed") return "failed";
  const head = conditionOf(obj, "HeadPodReady");
  const provisioned = conditionOf(obj, "RayClusterProvisioned");
  if (head || provisioned) {
    if (isFalse(head) && isTrue(provisioned)) return "headNotReady";
    if (isTrue(head) && isTrue(provisioned)) return "ready";
    return "provisioning";
  }
  return state === "ready" ? "ready" : "provisioning";
}

export interface WorkerGroup {
  name: string;
  /** Desired replicas (`replicas`; the autoscaler changes it); `undefined` when not set. */
  replicas?: number;
  min?: number;
  max?: number;
  /** Pods per replica (multi-host groups, `numOfHosts`; 1 by default). */
  hosts: number;
  suspended: boolean;
}

export function workerGroups(obj: KubeObject): WorkerGroup[] {
  return arr(get(obj, "spec", "workerGroupSpecs")).map((g) => ({
    name: str(get(g, "groupName")) ?? "",
    replicas: num(get(g, "replicas")),
    min: num(get(g, "minReplicas")),
    max: num(get(g, "maxReplicas")),
    hosts: num(get(g, "numOfHosts")) || 1,
    suspended: get(g, "suspend") === true,
  }));
}

export interface HeadInfo {
  podName?: string;
  podIP?: string;
  serviceName?: string;
  serviceIP?: string;
}

export const headOf = (obj: KubeObject): HeadInfo => {
  const h = get(obj, "status", "head");
  return { podName: str(get(h, "podName")), podIP: str(get(h, "podIP")), serviceName: str(get(h, "serviceName")), serviceIP: str(get(h, "serviceIP")) };
};

export interface Workers {
  ready: number;
  available: number;
  desired: number;
  min?: number;
  max?: number;
}

/** Worker pod counts from the status (`readyWorkerReplicas` etc. count pods, despite their names). */
export function workersOf(obj: KubeObject): Workers {
  const s = get(obj, "status");
  const desired =
    num(get(s, "desiredWorkerReplicas")) ?? workerGroups(obj).reduce((sum, g) => sum + (g.suspended ? 0 : (g.replicas ?? g.min ?? 0) * g.hosts), 0);
  return {
    ready: num(get(s, "readyWorkerReplicas")) ?? 0,
    available: num(get(s, "availableWorkerReplicas")) ?? 0,
    desired,
    min: num(get(s, "minWorkerReplicas")),
    max: num(get(s, "maxWorkerReplicas")),
  };
}

/** `name: port` of `status.endpoints` (dashboard, client, gcs-server, serve, …), sorted. */
export const endpointsOf = (obj: KubeObject): string[] =>
  Object.entries(record(get(obj, "status", "endpoints")))
    .map(([name, port]) => `${name}: ${String(port)}`)
    .sort();

/** Why a cluster failed or waits, in the operator's words: a failing condition's message, else `status.reason`. */
export function clusterReason(obj: KubeObject): string | undefined {
  for (const type of ["ReplicaFailure", "HeadPodReady"]) {
    const c = conditionOf(obj, type);
    const bad = type === "ReplicaFailure" ? isTrue(c) : isFalse(c);
    if (bad && (c?.message || c?.reason)) return c.message || c.reason;
  }
  return str(get(obj, "status", "reason"));
}

// ---------- RayJob ----------

export type JobState = "succeeded" | "running" | "pending" | "retrying" | "stopped" | "suspended" | "failed";

export const JOB_TONE: Record<JobState, Tone> = {
  succeeded: "success",
  running: "warning",
  pending: "muted",
  retrying: "warning",
  stopped: "muted",
  suspended: "muted",
  failed: "danger",
};

/** Ray's job status (`PENDING`, `RUNNING`, `STOPPED`, `SUCCEEDED`, `FAILED`); empty before the job is submitted. */
export const jobStatusOf = (obj: KubeObject): string | undefined => str(get(obj, "status", "jobStatus")) || undefined;
/** KubeRay's own status (`Initializing`, `Running`, `Complete`, `Failed`, `ValidationFailed`, `Suspended`, …). */
export const deploymentStatusOf = (obj: KubeObject): string | undefined => str(get(obj, "status", "jobDeploymentStatus")) || undefined;

/**
 * A RayJob's state. `Retrying` (a new attempt within `backoffLimit`) comes before a failure: the last attempt's
 * `FAILED` is not final then. Operators before 1.3 ended a failed job as `Complete` with `jobStatus: FAILED`.
 */
export function jobState(obj: KubeObject): JobState {
  const job = jobStatusOf(obj);
  const deployment = deploymentStatusOf(obj);
  if (deployment === "Retrying") return "retrying";
  if (deployment === "Failed" || deployment === "ValidationFailed" || job === "FAILED") return "failed";
  if (job === "SUCCEEDED") return "succeeded";
  if (job === "STOPPED") return "stopped";
  if (deployment === "Suspended" || deployment === "Suspending") return "suspended";
  if (job === "RUNNING") return "running";
  return "pending";
}

/** How the job is submitted; `K8sJobMode` (a submitter Kubernetes Job) when not set. */
export const submissionModeOf = (obj: KubeObject): string => str(get(obj, "spec", "submissionMode")) || "K8sJobMode";

/**
 * The submitter Job: in `K8sJobMode` KubeRay creates a batch Job of the RayJob's own name and namespace
 * (`createNewK8sJob` in controllers/ray/rayjob_controller.go); other modes have none.
 */
export const submitterJobOf = (obj: KubeObject): string | undefined =>
  submissionModeOf(obj) === "K8sJobMode" ? obj.metadata?.name : undefined;

// ---------- RayService ----------

export type ServiceState = "ready" | "upgrading" | "notReady" | "suspended" | "failed";

export const SERVICE_TONE: Record<ServiceState, Tone> = {
  ready: "success",
  upgrading: "warning",
  notReady: "warning",
  suspended: "muted",
  failed: "danger",
};

export interface ServeApp {
  name: string;
  /** Ray Serve's application status: NOT_STARTED, DEPLOYING, RUNNING, DEPLOY_FAILED, DELETING, UNHEALTHY. */
  status?: string;
  message?: string;
  deployments: { name: string; status?: string; message?: string }[];
}

export const FAILED_APP = new Set(["DEPLOY_FAILED", "UNHEALTHY"]);
export const appTone = (s: string | undefined): Tone =>
  s === "RUNNING" || s === "HEALTHY" ? "success" : s && FAILED_APP.has(s) ? "danger" : "warning";

export interface ServeCluster {
  rayClusterName?: string;
  apps: ServeApp[];
  /** Incremental upgrades: the share of traffic routed to this cluster and its target capacity, in percent. */
  trafficPercent?: number;
  targetCapacity?: number;
}

function serveCluster(value: unknown): ServeCluster {
  const apps = Object.entries(record(get(value, "applicationStatuses")))
    .map(([name, a]) => ({
      name,
      status: str(get(a, "status")),
      message: str(get(a, "message")),
      deployments: Object.entries(record(get(a, "serveDeploymentStatuses")))
        .map(([d, s]) => ({ name: d, status: str(get(s, "status")), message: str(get(s, "message")) }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    }))
    .sort((x, y) => x.name.localeCompare(y.name));
  return {
    rayClusterName: str(get(value, "rayClusterName")) || undefined,
    apps,
    trafficPercent: num(get(value, "trafficRoutedPercent")),
    targetCapacity: num(get(value, "targetCapacity")),
  };
}

export const activeOf = (obj: KubeObject): ServeCluster => serveCluster(get(obj, "status", "activeServiceStatus"));
export const pendingOf = (obj: KubeObject): ServeCluster => serveCluster(get(obj, "status", "pendingServiceStatus"));

/** Reasons of a `Ready=False` condition that need someone (an invalid spec, a cluster that never came up in time). */
const FAILED_REASONS = new Set(["ValidationFailed", "InitializingTimeout"]);

/**
 * A RayService's state: the `Ready` condition (KubeRay 1.3+; `serviceStatus` "Running" before), suspension, a
 * zero-downtime upgrade in progress, and a failure when the condition says so or a Serve application of the active
 * cluster failed to deploy or is unhealthy.
 */
export function serviceState(obj: KubeObject): ServiceState {
  if (isTrue(conditionOf(obj, "Suspended")) || isTrue(conditionOf(obj, "Suspending"))) return "suspended";
  const ready = conditionOf(obj, "Ready");
  const failedApp = failedAppOf(obj) !== undefined;
  if (ready && isFalse(ready) && FAILED_REASONS.has(ready.reason ?? "")) return "failed";
  if (failedApp) return "failed";
  if (isTrue(conditionOf(obj, "UpgradeInProgress"))) return "upgrading";
  if (ready) return isTrue(ready) ? "ready" : "notReady";
  return str(get(obj, "status", "serviceStatus")) === "Running" ? "ready" : "notReady";
}

/** The serve Service: `spec.serveService.metadata.name`, else `<name>-serve-svc` (`RayServiceServeServiceNamespacedName`). */
export const serveServiceOf = (obj: KubeObject): string | undefined =>
  str(get(obj, "spec", "serveService", "metadata", "name")) || (obj.metadata?.name ? `${obj.metadata.name}-serve-svc` : undefined);

/**
 * The first Serve application that failed to deploy or is unhealthy: of the active cluster, or of the pending one
 * while there is no active cluster yet (the first start; during an upgrade the active cluster still serves).
 */
export function failedAppOf(obj: KubeObject): ServeApp | undefined {
  const active = activeOf(obj);
  const failed = (c: ServeCluster) => c.apps.find((a) => a.status && FAILED_APP.has(a.status));
  return failed(active) ?? (active.rayClusterName ? undefined : failed(pendingOf(obj)));
}

/** Why a RayService is not ready: the first failing application's message, else the `Ready` condition's message. */
export function serviceReason(obj: KubeObject): string | undefined {
  const ready = conditionOf(obj, "Ready");
  const app = failedAppOf(obj);
  if (app?.message) return app.message;
  if (isFalse(ready)) return ready?.message || ready?.reason;
  return undefined;
}

// ---------- Problems ----------

/** A head pod not ready, a pod KubeRay cannot create, a RayService not ready count after this long. */
export const RAY_GRACE_MS = 5 * 60_000;
/** A RayService serves only once every application is up (models load, images pull): a longer grace. */
export const SERVICE_GRACE_MS = 10 * 60_000;
/** A failed RayJob is a problem for a day after it ended. */
export const FAILED_JOB_MS = 24 * 3600_000;

function time(value: string | undefined): number | undefined {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? undefined : t;
}

/** When a failed RayJob ended: `endTime`, else its start, else its creation. */
export function jobEndedAt(obj: KubeObject): string | undefined {
  for (const value of [str(get(obj, "status", "endTime")), str(get(obj, "status", "startTime")), str(obj.metadata?.creationTimestamp)])
    if (time(value) !== undefined) return value;
  return undefined;
}

/**
 * The problems of a KubeRay object: a failed RayCluster (at once) or one whose head pod is not ready or that cannot
 * create its pods (after a grace); a failed RayJob (for a day after it ended); a RayService not ready (after a grace)
 * or with a failed application. A suspended object is never a problem. `now` only for the table filter, which has
 * no grace (the problems store applies `graceMs`).
 */
export function rayProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject, now?: number): Detected[] {
  if (obj.metadata?.deletionTimestamp) return [];
  if (isKind(kind, RAY_CLUSTER)) {
    const state = clusterState(obj);
    if (state === "failed") {
      const replica = conditionOf(obj, "ReplicaFailure");
      const legacy = !isTrue(replica);
      return [
        {
          reason: legacy ? "RayClusterFailed" : replica?.reason || "ReplicaFailure",
          group: "failed",
          message: clusterReason(obj),
          since: legacy ? undefined : replica?.since,
          graceMs: legacy ? undefined : RAY_GRACE_MS,
          notify: true,
        },
      ];
    }
    const head = conditionOf(obj, "HeadPodReady");
    if ((state === "headNotReady" || state === "provisioning") && isFalse(head)) {
      return [{ reason: head?.reason || "HeadPodNotReady", group: "headNotReady", message: head?.message, since: head?.since, graceMs: RAY_GRACE_MS, notify: true }];
    }
    return [];
  }
  if (isKind(kind, RAY_JOB)) {
    if (jobState(obj) !== "failed") return [];
    const ended = jobEndedAt(obj);
    const at = time(ended);
    const until = at === undefined ? undefined : at + FAILED_JOB_MS;
    if (until !== undefined && now !== undefined && Number.isFinite(now) && now >= until) return [];
    return [
      {
        reason: str(get(obj, "status", "reason")) || (deploymentStatusOf(obj) === "ValidationFailed" ? "ValidationFailed" : "RayJobFailed"),
        message: str(get(obj, "status", "message")),
        since: ended,
        until,
        notify: true,
      },
    ];
  }
  if (isKind(kind, RAY_SERVICE)) {
    const state = serviceState(obj);
    if (state === "ready" || state === "upgrading" || state === "suspended") return [];
    const ready = conditionOf(obj, "Ready");
    return [
      {
        reason: (isFalse(ready) && ready?.reason) || (state === "failed" ? "ServeApplicationFailed" : "RayServiceNotReady"),
        group: "notReady",
        message: serviceReason(obj),
        since: ready?.since,
        graceMs: state === "failed" && FAILED_REASONS.has(ready?.reason ?? "") ? undefined : SERVICE_GRACE_MS,
        notify: true,
      },
    ];
  }
  return [];
}

/** Whether the table's "Only problems" filter shows the object (no grace; a failed RayJob however long ago). */
export const isProblem = (obj: KubeObject, kind: Pick<KindRef, "group" | "kind">): boolean =>
  isKind(kind, RAY_JOB) ? jobState(obj) === "failed" : rayProblems(kind, obj).length > 0;
