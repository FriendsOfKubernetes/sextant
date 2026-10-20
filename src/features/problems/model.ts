// What counts as a problem in a cluster: the rules shared by the problems screen (#136) and the background
// notifications (#135). Pure functions over watched objects, no React and no clock: a rule says when a problem
// starts to count (`since` + `graceMs`, or `activeFrom`) and, for one that passes by itself, until when (`until`);
// `isActive(problem, now)` reads it. Flux, Argo CD and Gateway API objects are judged by their sections' own helpers.
//
//   detect(kind, obj)          // the problems of one object of `kind` (an empty list: none)
//   resolve(detected, before)  // with keys and the time each was first seen (kept across updates of the object)
//   isActive(problem, now)
import type { KindRef, KubeObject, ObjectRef } from "../../api";
import { status } from "../../resources";
import { kindFromApiVersion } from "../../resources/refs";
import { APPLICATION, healthStatus, operationPhase } from "../argocd/model";
import { eventTimestamp, involvedObject } from "../events/model";
import { isSuspended, readyMessage, readyReason, readyStatus } from "../flux/model";
import {
  BACKEND_TLS_POLICY,
  GATEWAY,
  GATEWAY_CLASS,
  gatewayClassHealth,
  gatewayHealth,
  isProblem as isGatewayProblem,
  isRouteKind,
  policyHealth,
  routeHealth,
} from "../gateway-api/model";
import { evaluateObject, fieldName, judgedOnItsOwn } from "../security/pss";

const { arr, get, num, str } = status;

/** Kinds of problems, in the order the screen lists them; also the notification toggles (all but `events`). */
export const PROBLEM_CATEGORIES = [
  "nodes",
  "pods",
  "workloads",
  "jobs",
  "volumes",
  "certificates",
  "flux",
  "argocd",
  "gateway",
  "mesh",
  "security",
  "practices",
  "credentials",
  "disk",
  "events",
] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

/** The categories that notify: Warning events are shown on the screen only. */
export const NOTIFY_CATEGORIES: readonly ProblemCategory[] = PROBLEM_CATEGORIES.filter((c) => c !== "events");

/**
 * Categories that are off until the user turns them on (`notifications.enabledCategories`, one setting for the
 * problems screen, the sidebar counter and the notifications): security findings (#143) are lasting states of a
 * workload's spec, not incidents, and a cluster usually has privileged system pods, so they would only add noise unless
 * asked for. Their sources are their own (`sourceKey`), so nothing of them is computed or kept while they are off.
 * Best-practice findings (#207) are lasting states too, and most clusters have many.
 */
export const OPT_IN_CATEGORIES: readonly ProblemCategory[] = ["security", "credentials", "disk", "practices"];

/** How long a container restart or an OOM kill counts after it happened. */
export const RECENT_RESTART_MS = 15 * 60_000;
/** Days before its `notAfter` a certificate is "expiring" by default (`notifications.certExpiryDays`). */
export const DEFAULT_CERT_EXPIRY_DAYS = 14;
export const MIN_CERT_EXPIRY_DAYS = 1;
export const MAX_CERT_EXPIRY_DAYS = 365;
const DAY_MS = 24 * 3600_000;
/** A certificate is "expiring" this long before its `notAfter` by default. */
export const CERT_EXPIRY_WARNING_MS = DEFAULT_CERT_EXPIRY_DAYS * DAY_MS;

/** The setting within its bounds; anything unreadable is the default. */
export function clampExpiryDays(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return DEFAULT_CERT_EXPIRY_DAYS;
  return Math.min(MAX_CERT_EXPIRY_DAYS, Math.max(MIN_CERT_EXPIRY_DAYS, Math.round(n)));
}

let certExpiryWarningMs = CERT_EXPIRY_WARNING_MS;

/** How long before its `notAfter` a certificate counts as expiring now (the setting the store applied last). */
export function currentCertExpiryWarningMs(): number {
  return certExpiryWarningMs;
}

/**
 * Sets the expiry warning (`notifications.certExpiryDays`, clamped); whether it changed. Only new detections use it:
 * the store moves the problems it already holds (`applyCertExpiryDays` in store.ts).
 */
export function setCertExpiryDays(days: unknown): boolean {
  const ms = clampExpiryDays(days) * DAY_MS;
  if (ms === certExpiryWarningMs) return false;
  certExpiryWarningMs = ms;
  return true;
}
/** Grace before a slow state counts: a pod pending or not ready, unavailable replicas, a pending volume claim. */
export const SHORT_GRACE_MS = 2 * 60_000;
export const LONG_GRACE_MS = 5 * 60_000;

/** One problem of one object, as a rule found it. */
export interface Detected {
  /** Machine-readable reason, e.g. `CrashLoopBackOff`, `NotReady`; shown as is. */
  reason: string;
  /**
   * What a notification is about: two reasons of the same group are one state for notifications (a crash-looping pod
   * goes `CrashLoopBackOff` → `Restarting` → `CrashLoopBackOff`). Defaults to the reason.
   */
  group?: string;
  /** Text from the cluster (a condition or container message). */
  message?: string;
  /** A message Sextant writes: an i18n key under `problems:` and its values. */
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  /**
   * Values of `messageKey` that are lists (field names): kept raw and joined when the text is shown
   * (`messageText`), so the list separator follows the UI language at that time.
   */
  messageLists?: Record<string, string[]>;
  /** When the state began (RFC 3339), if the object says. */
  since?: string;
  /** The problem counts only this long after it began (or was first seen). */
  graceMs?: number;
  /** Counts from this time (ms) on, whatever `since` says (a certificate expiring soon). */
  activeFrom?: number;
  /** Stops counting at this time (ms): a past restart. */
  until?: number;
  /**
   * A certificate's `notAfter` (ms) for an "Expiring" problem: it counts from the expiry warning setting before it, so
   * a change of the setting moves `activeFrom` without the object.
   */
  expiresAt?: number;
  /** Worth a desktop notification when it starts. */
  notify: boolean;
  /** The object the problem is about when it is not the watched one (a Warning event's involved object). */
  object?: ObjectRef;
  /**
   * Progress of the state (a rollout's ready/updated counts): when it changes, the problem counts as first seen now,
   * so its grace measures the time without progress.
   */
  stamp?: string;
}

/** A problem as the screen and the notifications see it. */
export interface Problem extends Omit<Detected, "object"> {
  /** `uid|reason`: unique within the watched kind. */
  key: string;
  /**
   * `<identity>|group`: what notifications follow. The identity is the object's owner where runs or replicas come and
   * go (a CronJob for its Jobs, a Deployment, StatefulSet, DaemonSet or Job for its pods), else the object itself, so a
   * failing CronJob or a crashing replica set notifies once per state, not once per run or pod.
   */
  notifyKey: string;
  category: ProblemCategory;
  uid: string;
  object: ObjectRef;
  /** When Sextant first saw it (ms). */
  firstSeen: number;
  /** When it starts to count (ms). */
  activeAt: number;
}

const same = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) =>
  a.group === b.group && a.kind === b.kind;
const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const POD = k("", "v1", "Pod");
export const NODE = k("", "v1", "Node");
export const PVC = k("", "v1", "PersistentVolumeClaim");
export const EVENT = k("", "v1", "Event");
export const DEPLOYMENT = k("apps", "v1", "Deployment");
export const STATEFULSET = k("apps", "v1", "StatefulSet");
export const DAEMONSET = k("apps", "v1", "DaemonSet");
export const JOB = k("batch", "v1", "Job");
export const CRONJOB = k("batch", "v1", "CronJob");
export const REPLICASET = k("apps", "v1", "ReplicaSet");
/** cert-manager's Certificate. */
export const CERTIFICATE = k("cert-manager.io", "v1", "Certificate");

const FLUX_GROUPS = new Set([
  "source.toolkit.fluxcd.io",
  "kustomize.toolkit.fluxcd.io",
  "helm.toolkit.fluxcd.io",
  "image.toolkit.fluxcd.io",
]);

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

function condition(obj: KubeObject, type: string): Record<string, unknown> | undefined {
  return arr(get(obj, "status", "conditions")).find((c) => get(c, "type") === type) as Record<string, unknown> | undefined;
}

const transition = (c: unknown) => str(get(c, "lastTransitionTime"));

/** The category of a watched kind (Events, pods, …). */
export function categoryOf(kind: Pick<KindRef, "group" | "kind">): ProblemCategory | undefined {
  if (same(kind, POD)) return "pods";
  if (same(kind, NODE)) return "nodes";
  if (same(kind, DEPLOYMENT) || same(kind, STATEFULSET) || same(kind, DAEMONSET)) return "workloads";
  if (same(kind, JOB)) return "jobs";
  if (same(kind, PVC)) return "volumes";
  if (same(kind, EVENT)) return "events";
  if (same(kind, CERTIFICATE)) return "certificates";
  if (same(kind, APPLICATION)) return "argocd";
  if (FLUX_GROUPS.has(kind.group)) return "flux";
  if (kind.group === "gateway.networking.k8s.io") return "gateway";
  return undefined;
}

// ---------- Pods ----------

const IMAGE_REASONS = new Set(["ImagePullBackOff", "ErrImagePull", "InvalidImageName", "ErrImageNeverPull"]);
const CONFIG_REASONS = new Set(["CreateContainerConfigError", "CreateContainerError", "RunContainerError"]);

/** One container's problem, if any. */
function containerProblem(cs: unknown): Detected | undefined {
  const name = str(get(cs, "name")) ?? "";
  const waiting = get(cs, "state", "waiting");
  const terminated = get(cs, "state", "terminated");
  const last = get(cs, "lastState", "terminated");
  const lastReason = str(get(last, "reason"));
  const lastFinished = str(get(last, "finishedAt"));
  const waitingReason = str(get(waiting, "reason"));
  const params = { container: name };
  if (waitingReason === "CrashLoopBackOff") {
    const oom = lastReason === "OOMKilled";
    return {
      reason: oom ? "OOMKilled" : "CrashLoopBackOff",
      group: oom ? "OOMKilled" : "crash",
      message: str(get(waiting, "message")),
      messageKey: "messages.container",
      messageParams: params,
      since: lastFinished,
      notify: true,
    };
  }
  if (waitingReason && IMAGE_REASONS.has(waitingReason)) {
    // ErrImagePull and ImagePullBackOff take turns: one state.
    return {
      reason: "ImagePullBackOff",
      message: str(get(waiting, "message")),
      messageKey: "messages.container",
      messageParams: params,
      notify: true,
    };
  }
  if (waitingReason && CONFIG_REASONS.has(waitingReason)) {
    return { reason: waitingReason, message: str(get(waiting, "message")), messageKey: "messages.container", messageParams: params, notify: true };
  }
  if (str(get(terminated, "reason")) === "OOMKilled") {
    return { reason: "OOMKilled", since: str(get(terminated, "finishedAt")), messageKey: "messages.container", messageParams: params, notify: true };
  }
  const finished = time(lastFinished);
  if (get(cs, "state", "running") && finished !== undefined) {
    const oom = lastReason === "OOMKilled";
    return {
      reason: oom ? "OOMKilled" : "Restarting",
      group: oom ? "OOMKilled" : "crash",
      since: lastFinished,
      until: finished + RECENT_RESTART_MS,
      messageKey: "messages.restarts",
      messageParams: { container: name, count: num(get(cs, "restartCount")) ?? 0 },
      // A container that restarted once is shown; an OOM kill is worth telling.
      notify: oom,
    };
  }
  return undefined;
}

/** How bad a container's problem is: what notifies first, then crash loops and OOM kills over image and config errors. */
function severity(d: Detected): number {
  const base = d.reason === "CrashLoopBackOff" || d.reason === "OOMKilled" ? 3 : d.reason === "Restarting" ? 1 : 2;
  return (d.notify ? 10 : 0) + base;
}

function podProblems(pod: KubeObject): Detected[] {
  if (pod.metadata?.deletionTimestamp) return [];
  const phase = str(get(pod, "status", "phase"));
  if (phase === "Succeeded") return [];
  const statuses = [...arr(get(pod, "status", "initContainerStatuses")), ...arr(get(pod, "status", "containerStatuses"))];
  // The worst container speaks for the pod: a sidecar that restarted once never hides another one crash-looping.
  let worst: Detected | undefined;
  for (const cs of statuses) {
    const found = containerProblem(cs);
    if (found && (!worst || severity(found) > severity(worst))) worst = found;
  }
  if (worst) return [worst];
  if (phase === "Failed") {
    return [{ reason: str(get(pod, "status", "reason")) ?? "Failed", message: str(get(pod, "status", "message")), notify: false }];
  }
  if (phase === "Pending") {
    const scheduled = condition(pod, "PodScheduled");
    if (str(get(scheduled, "status")) === "False") {
      // FailedScheduling: the scheduler's message says why (no node fits, a volume, a taint).
      return [
        {
          reason: str(get(scheduled, "reason")) ?? "Unschedulable",
          group: "pending",
          message: str(get(scheduled, "message")),
          since: transition(scheduled) ?? str(pod.metadata?.creationTimestamp),
          graceMs: SHORT_GRACE_MS,
          notify: false,
        },
      ];
    }
    return [{ reason: "Pending", group: "pending", since: str(pod.metadata?.creationTimestamp), graceMs: LONG_GRACE_MS, notify: false }];
  }
  if (phase === "Running") {
    const ready = condition(pod, "Ready");
    if (ready && str(get(ready, "status")) !== "True") {
      return [
        {
          reason: "NotReady",
          message: str(get(ready, "message")),
          since: transition(ready),
          graceMs: SHORT_GRACE_MS,
          notify: false,
        },
      ];
    }
  }
  return [];
}

// ---------- Nodes ----------

const PRESSURES = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"];

function nodeProblems(node: KubeObject): Detected[] {
  const found: Detected[] = [];
  const ready = condition(node, "Ready");
  if (str(get(ready, "status")) !== "True") {
    found.push({
      reason: "NotReady",
      message: str(get(ready, "message")),
      since: transition(ready),
      notify: true,
    });
  }
  for (const type of PRESSURES) {
    const c = condition(node, type);
    if (str(get(c, "status")) === "True") {
      found.push({ reason: type, message: str(get(c, "message")), since: transition(c), notify: true });
    }
  }
  return found;
}

// ---------- Workloads, Jobs, volume claims ----------

/** Progressing reasons of a Deployment in the middle of a rollout (its unavailable replicas are expected). */
const ROLLING_OUT = new Set(["NewReplicaSetCreated", "FoundNewReplicaSet", "ReplicaSetUpdated"]);

/** A rollout (StatefulSet, DaemonSet) without progress this long, with pods not ready, is a problem. */
export const ROLLOUT_STALL_MS = 10 * 60_000;

function stalledRollout(ready: number, desired: number, updated: number | undefined): Detected {
  return {
    reason: "RolloutNotProgressing",
    group: "unavailable",
    messageKey: "messages.replicas",
    messageParams: { ready, desired },
    graceMs: ROLLOUT_STALL_MS,
    // Any progress (more pods updated or ready) starts the wait again.
    stamp: `${updated ?? ""}/${ready}`,
    notify: true,
  };
}

function unavailable(ready: number, desired: number, since: string | undefined): Detected {
  return {
    reason: "UnavailableReplicas",
    group: "unavailable",
    messageKey: "messages.replicas",
    messageParams: { ready, desired },
    since,
    graceMs: LONG_GRACE_MS,
    notify: true,
  };
}

function deploymentProblems(obj: KubeObject): Detected[] {
  const desired = num(get(obj, "spec", "replicas")) ?? 1;
  if (desired === 0 || get(obj, "spec", "paused") === true) return [];
  const progressing = condition(obj, "Progressing");
  if (str(get(progressing, "status")) === "False" && str(get(progressing, "reason")) === "ProgressDeadlineExceeded") {
    return [
      {
        reason: "ProgressDeadlineExceeded",
        group: "unavailable",
        message: str(get(progressing, "message")),
        since: transition(progressing),
        notify: true,
      },
    ];
  }
  const ready = num(get(obj, "status", "readyReplicas")) ?? 0;
  if (ready >= desired) return [];
  if (str(get(progressing, "status")) === "True" && ROLLING_OUT.has(str(get(progressing, "reason")) ?? "")) return [];
  const available = condition(obj, "Available");
  return [unavailable(ready, desired, str(get(available, "status")) === "False" ? transition(available) : undefined)];
}

function statefulSetProblems(obj: KubeObject): Detected[] {
  const desired = num(get(obj, "spec", "replicas")) ?? 1;
  if (desired === 0) return [];
  const ready = num(get(obj, "status", "readyReplicas")) ?? 0;
  if (ready >= desired) return [];
  const current = str(get(obj, "status", "currentRevision"));
  const update = str(get(obj, "status", "updateRevision"));
  if (current && update && current !== update) {
    return [stalledRollout(ready, desired, num(get(obj, "status", "updatedReplicas")))];
  }
  return [unavailable(ready, desired, undefined)];
}

function daemonSetProblems(obj: KubeObject): Detected[] {
  const desired = num(get(obj, "status", "desiredNumberScheduled")) ?? 0;
  if (desired === 0) return [];
  const ready = num(get(obj, "status", "numberReady")) ?? 0;
  if (ready >= desired) return [];
  const updated = num(get(obj, "status", "updatedNumberScheduled"));
  if (updated !== undefined && updated < desired) return [stalledRollout(ready, desired, updated)];
  return [unavailable(ready, desired, undefined)];
}

function jobProblems(job: KubeObject): Detected[] {
  const failed = condition(job, "Failed");
  if (str(get(failed, "status")) !== "True") return [];
  return [
    {
      reason: str(get(failed, "reason")) ?? "Failed",
      group: "failed",
      message: str(get(failed, "message")),
      since: transition(failed),
      notify: true,
    },
  ];
}

/** Set on a claim once a pod using it was scheduled (a WaitForFirstConsumer volume is provisioned then). */
const SELECTED_NODE = "volume.kubernetes.io/selected-node";

function claimProblems(claim: KubeObject): Detected[] {
  const phase = str(get(claim, "status", "phase"));
  if (phase === "Lost") return [{ reason: "Lost", notify: true }];
  // A claim of a WaitForFirstConsumer class stays Pending until a pod uses it; that is normal. Only a claim a
  // scheduled pod waits for counts (provisioning failures of other claims show as Warning events).
  if (phase === "Pending" && get(claim, "metadata", "annotations", SELECTED_NODE) !== undefined) {
    return [{ reason: "Pending", since: str(claim.metadata?.creationTimestamp), graceMs: SHORT_GRACE_MS, notify: false }];
  }
  return [];
}

// ---------- Events ----------

function eventProblems(event: KubeObject): Detected[] {
  if (str(get(event, "type")) !== "Warning") return [];
  const target = involvedObject(event);
  return [
    {
      reason: str(get(event, "reason")) ?? "Warning",
      message: str(get(event, "message")),
      since: eventTimestamp(event),
      notify: false,
      object: target
        ? { kind: kindFromApiVersion(target.apiVersion, target.kind), namespace: target.namespace, name: target.name }
        : undefined,
    },
  ];
}

// ---------- Certificates, Flux, Argo CD, Gateway API ----------

/** Ready=False reasons of a certificate being issued (a new or renewed one), not of a failure. */
const CERT_IN_PROGRESS = new Set(["DoesNotExist", "Issuing", "InProgress", "Pending", "MissingData"]);

/** cert-manager gave up the current issuance attempt (it retries later with a growing delay). */
export function issuanceFailed(cert: KubeObject): boolean {
  const issuing = condition(cert, "Issuing");
  return str(get(issuing, "status")) === "False" && str(get(issuing, "reason")) === "Failed";
}

function certificateProblems(cert: KubeObject): Detected[] {
  const found: Detected[] = [];
  const ready = condition(cert, "Ready");
  const readyReasonText = str(get(ready, "reason"));
  if (str(get(ready, "status")) === "False" && !CERT_IN_PROGRESS.has(readyReasonText ?? "")) {
    found.push({
      reason: readyReasonText ?? "NotReady",
      group: "notReady",
      message: str(get(ready, "message")),
      since: transition(ready),
      graceMs: SHORT_GRACE_MS,
      notify: true,
    });
  } else if (issuanceFailed(cert)) {
    // A first issuance that keeps failing stays Ready=False/DoesNotExist, a failing renewal Ready=True: the Issuing
    // condition (False, reason Failed) is what says so.
    const issuing = condition(cert, "Issuing");
    found.push({
      reason: "IssuanceFailed",
      group: "notReady",
      message: str(get(issuing, "message")),
      since: transition(issuing),
      graceMs: SHORT_GRACE_MS,
      notify: true,
    });
  }
  const notAfterText = str(get(cert, "status", "notAfter"));
  const notAfter = time(notAfterText);
  if (notAfter !== undefined && notAfterText) {
    const params = { date: notAfterText };
    found.push({
      reason: "Expiring",
      messageKey: "messages.expires",
      messageParams: params,
      activeFrom: notAfter - certExpiryWarningMs,
      expiresAt: notAfter,
      until: notAfter,
      notify: true,
    });
    found.push({ reason: "Expired", messageKey: "messages.expired", messageParams: params, activeFrom: notAfter, notify: true });
  }
  return found;
}

/** Ready=False reasons of a Flux object still working (waiting for a dependency, reconciling), not of a failure. */
const FLUX_IN_PROGRESS = new Set(["DependencyNotReady", "Progressing", "ProgressingWithRetry", "ReconciliationInProgress"]);

function fluxProblems(obj: KubeObject): Detected[] {
  if (isSuspended(obj) || readyStatus(obj) !== "False") return [];
  const reason = readyReason(obj);
  if (FLUX_IN_PROGRESS.has(reason ?? "")) return [];
  return [
    {
      reason: reason ?? "NotReady",
      group: "notReady",
      message: readyMessage(obj),
      since: transition(condition(obj, "Ready")),
      // A failure the next retry fixes (a source briefly unreachable) passes quietly.
      graceMs: SHORT_GRACE_MS,
      notify: true,
    },
  ];
}

function argoProblems(app: KubeObject): Detected[] {
  const found: Detected[] = [];
  if (healthStatus(app) === "Degraded") {
    found.push({ reason: "Degraded", message: str(get(app, "status", "health", "message")), notify: true });
  }
  const phase = operationPhase(app);
  if (phase === "Failed" || phase === "Error") {
    found.push({
      reason: "SyncFailed",
      message: str(get(app, "status", "operationState", "message")),
      since: str(get(app, "status", "operationState", "finishedAt")),
      notify: true,
    });
  }
  return found;
}

function gatewayProblems(obj: KubeObject, kind: KindRef): Detected[] {
  if (!isGatewayProblem(obj, kind)) return [];
  const judged = same(kind, GATEWAY_CLASS)
    ? gatewayClassHealth(obj)
    : same(kind, GATEWAY)
      ? gatewayHealth(obj)
      : isRouteKind(kind)
        ? routeHealth(obj)
        : same(kind, BACKEND_TLS_POLICY)
          ? policyHealth(obj)
          : undefined;
  const problem = judged?.problem;
  return [
    {
      reason: problem?.reason ?? (problem ? `${problem.type}=${problem.status}` : "Problem"),
      group: "problem",
      message: problem?.message,
      notify: true,
    },
  ];
}

// ---------- Security (Pod Security Standards) ----------

/**
 * Kinds judged for security findings: workloads by their pod template; Pods, ReplicaSets and Jobs unless a judged
 * controller holds their template (`judgedOnItsOwn`: a Pod of an Argo Rollout's ReplicaSet is judged through that
 * ReplicaSet, a static Pod itself).
 */
const SECURITY_KINDS = [DEPLOYMENT, STATEFULSET, DAEMONSET, REPLICASET, JOB, CRONJOB, POD];

/**
 * A workload or a bare pod that violates the Baseline Pod Security Standard (src/features/security/pss.ts): privileged
 * containers, host namespaces, hostPath volumes and the like. Restricted findings and hardening hints are shown on the
 * Security page, not here: most workloads have some, and the problems screen is for what needs attention.
 */
export function securityProblems(kind: KindRef, obj: KubeObject): Detected[] {
  if (!SECURITY_KINDS.some((s) => same(kind, s))) return [];
  if (!judgedOnItsOwn(kind.kind, status.controllerOf(obj)?.kind)) return [];
  if (same(kind, POD) && obj.metadata?.deletionTimestamp) return [];
  const baseline = evaluateObject(kind.kind, obj).filter((f) => f.level === "baseline");
  if (baseline.length === 0) return [];
  const fields = [...new Set(baseline.map(fieldName))];
  return [
    {
      reason: "PodSecurityBaseline",
      group: "security",
      messageKey: "messages.securityBaseline",
      messageParams: { count: baseline.length },
      messageLists: { fields },
      notify: true,
    },
  ];
}

/** The problems of one object of `kind` (the kind it was watched as). */
export function detect(kind: KindRef, obj: KubeObject): Detected[] {
  switch (categoryOf(kind)) {
    case "pods":
      return podProblems(obj);
    case "nodes":
      return nodeProblems(obj);
    case "workloads":
      if (same(kind, DEPLOYMENT)) return deploymentProblems(obj);
      if (same(kind, STATEFULSET)) return statefulSetProblems(obj);
      return daemonSetProblems(obj);
    case "jobs":
      return jobProblems(obj);
    case "volumes":
      return claimProblems(obj);
    case "events":
      return eventProblems(obj);
    case "certificates":
      return certificateProblems(obj);
    case "flux":
      return fluxProblems(obj);
    case "argocd":
      return argoProblems(obj);
    case "gateway":
      return gatewayProblems(obj, kind);
    case "security":
      return securityProblems(kind, obj);
    // Kubeconfig credentials are no kind of the cluster (features/clusters/kubeconfig); volume fill levels come from
    // the kubelets or Prometheus, not from the claim (features/storage).
    case "credentials":
    case "practices": // Best-practice findings (#207) span several objects: the provider of features/practices finds them.
    case "disk":
    case "mesh": // Istio mistakes span several objects: the provider of features/mesh finds them.
    case undefined:
      return [];
  }
}

/** `metadata.uid`, or `namespace/name` (as the watch keys objects). */
export function uidOfObject(obj: KubeObject): string {
  return obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
}

/**
 * The problems of `obj` with their keys and times. `before` — the object's problems from the previous update — keeps
 * when each was first seen, so a grace period runs from the first sighting, not from the last update.
 */
export function resolve(
  kind: KindRef,
  obj: KubeObject,
  now: number,
  before: readonly Problem[] = [],
  /** The category of the source (`security` sources watch the same kinds as others); defaults to the kind's own. */
  category: ProblemCategory | undefined = categoryOf(kind),
): Problem[] {
  if (!category) return [];
  // The practices sources only carry the rows of features/practices (`external` or tapped): nothing is judged here.
  if (category === "practices") return [];
  const uid = uidOfObject(obj);
  const self: ObjectRef = { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
  const identity = ownerIdentity(kind, obj) ?? uid;
  const found = category === "security" ? securityProblems(kind, obj) : detect(kind, obj);
  return found.map(({ object, ...d }) => {
    const key = `${uid}|${d.reason}`;
    const previous = before.find((p) => p.key === key);
    const firstSeen = previous && previous.stamp === d.stamp ? previous.firstSeen : now;
    const start = time(d.since) ?? firstSeen;
    return {
      ...d,
      key,
      notifyKey: `${identity}|${d.group ?? d.reason}`,
      category,
      uid,
      object: object ?? self,
      firstSeen,
      // Without a grace it counts at once, even if the cluster's clock is ahead of this machine's.
      activeAt: d.activeFrom ?? (d.graceMs ? start + d.graceMs : Math.min(start, firstSeen)),
    };
  });
}

/** A ReplicaSet's pod-template hash suffix; a CronJob's Job is `<cronjob>-<scheduled minutes>`. */
const REPLICA_SET_HASH = /-[a-z0-9]{6,10}$/;
const CRON_JOB_RUN = /-\d{8,}$/;

/**
 * Who stands behind an object whose runs or replicas come and go: a CronJob for its Jobs (and their pods), the
 * workload of a pod. `undefined`: the object is its own identity.
 */
export function ownerIdentity(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): string | undefined {
  if (!same(kind, POD) && !same(kind, JOB)) return undefined;
  const owner = status.controllerOf(obj);
  if (!owner) return undefined;
  const namespace = obj.metadata?.namespace ?? "";
  let { kind: ownerKind, name } = owner;
  if (ownerKind === "ReplicaSet" && REPLICA_SET_HASH.test(name)) {
    ownerKind = "Deployment";
    name = name.replace(REPLICA_SET_HASH, "");
  } else if (ownerKind === "Job" && CRON_JOB_RUN.test(name)) {
    ownerKind = "CronJob";
    name = name.replace(CRON_JOB_RUN, "");
  }
  return `owner:${namespace}/${ownerKind}/${name}`;
}

/** The problem counts now: its grace is over and it has not passed. */
export function isActive(problem: Pick<Problem, "activeAt" | "until">, now: number): boolean {
  return problem.activeAt <= now && (problem.until === undefined || now < problem.until);
}

/** When the problem began, for its age: what the object says, else when Sextant first saw it. */
export function startedAt(problem: Pick<Problem, "since" | "firstSeen" | "activeFrom">): number {
  return time(problem.since) ?? problem.activeFrom ?? problem.firstSeen;
}
