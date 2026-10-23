// What the Kueue section reads from kueue.x-k8s.io objects, as Kueue writes them (apis/kueue/v1beta2 and v1beta1,
// kubernetes-sigs/kueue): the kinds it knows, a ClusterQueue's Active condition and its quotas against what is
// reserved and in use per flavor and resource, a LocalQueue's ClusterQueue, and a Workload's state — pending and why
// (the QuotaReserved=False message the scheduler writes), admitted, evicted and why, finished — with its owner job.
// v1beta1 and v1beta2 differ in a few field names (`cohort`/`cohortName`, `flavorUsage`/`flavorsUsage`,
// `priorityClassName`/`priorityClassRef`): both are read. Pure functions, no React.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";
import { parseQuantity } from "../metrics/format";

const { arr, get, num, record, str } = status;

export const KUEUE_GROUP = "kueue.x-k8s.io";
const k = (kind: string): KindRef => ({ group: KUEUE_GROUP, version: "v1beta2", kind });

export const CLUSTER_QUEUE = k("ClusterQueue");
export const LOCAL_QUEUE = k("LocalQueue");
export const WORKLOAD = k("Workload");
export const RESOURCE_FLAVOR = k("ResourceFlavor");
export const COHORT = k("Cohort");
export const ADMISSION_CHECK = k("AdmissionCheck");
export const WORKLOAD_PRIORITY_CLASS = k("WorkloadPriorityClass");

export interface KueueKind {
  kind: KindRef;
  order: number;
  /** Key under `kueue:sidebar`. */
  label: string;
  namespaced: boolean;
}

export const KUEUE_KINDS: KueueKind[] = [
  { kind: CLUSTER_QUEUE, order: 10, label: "clusterQueues", namespaced: false },
  { kind: LOCAL_QUEUE, order: 20, label: "localQueues", namespaced: true },
  { kind: WORKLOAD, order: 30, label: "workloads", namespaced: true },
  { kind: RESOURCE_FLAVOR, order: 40, label: "resourceFlavors", namespaced: false },
  { kind: COHORT, order: 50, label: "cohorts", namespaced: false },
  { kind: ADMISSION_CHECK, order: 60, label: "admissionChecks", namespaced: false },
  { kind: WORKLOAD_PRIORITY_CLASS, order: 70, label: "priorityClasses", namespaced: false },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

export const kueueKind = (kind: Pick<KindRef, "group" | "kind">): KueueKind | undefined => KUEUE_KINDS.find((d) => isKind(kind, d.kind));

/** The label a job carries to be queued (`constants.QueueLabel`). */
export const QUEUE_LABEL = "kueue.x-k8s.io/queue-name";
/** The label Kueue puts on a job's Workload: the job's uid (`constants.JobUIDLabel`). */
export const JOB_UID_LABEL = "kueue.x-k8s.io/job-uid";
/**
 * A job that names its prebuilt Workload: the annotation (`constants.PrebuiltWorkloadAnnotation`, with the
 * WorkloadIdentifierAnnotations gate) or the label (`constants.PrebuiltWorkloadLabel`) of the same key
 * (pkg/controller/constants/constants.go).
 */
export const PREBUILT_LABEL = "kueue.x-k8s.io/prebuilt-workload-name";
export const PREBUILT_ANNOTATION = "kueue.x-k8s.io/prebuilt-workload-name";

/** The prebuilt Workload a job names: the annotation first, then the label, as Kueue reads them. */
export function prebuiltWorkloadOf(job: KubeObject | null | undefined): string | undefined {
  return str(record(job?.metadata?.annotations)[PREBUILT_ANNOTATION]) || str(record(job?.metadata?.labels)[PREBUILT_LABEL]) || undefined;
}
/** Composable jobs name their owner by annotation (`constants.JobOwnerGVKAnnotation` / `JobOwnerNameAnnotation`). */
export const OWNER_GVK_ANNOTATION = "kueue.x-k8s.io/job-owner-gvk";
export const OWNER_NAME_ANNOTATION = "kueue.x-k8s.io/job-owner-name";

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

const quantity = (value: unknown): string | undefined => (typeof value === "number" ? String(value) : str(value));

// ---------- Queues ----------

export type QueueState = "active" | "stopped" | "terminating" | "inactive" | "unknown";

export const QUEUE_TONE: Record<QueueState, Tone> = {
  active: "success",
  stopped: "muted",
  terminating: "muted",
  inactive: "danger",
  unknown: "neutral",
};

/**
 * A ClusterQueue's or LocalQueue's state from its `Active` condition: True is active; False with `Stopped` is a
 * stop the user asked for (`spec.stopPolicy`), `Terminating` is being deleted; any other False reason (a missing
 * flavor or admission check, a cohort cycle, a missing ClusterQueue) is inactive: it admits nothing.
 */
export function queueState(obj: KubeObject): QueueState {
  if (obj.metadata?.deletionTimestamp) return "terminating";
  const active = conditionOf(obj, "Active");
  if (!active) return "unknown";
  if (active.status === "True") return "active";
  if (active.reason === "Stopped") return "stopped";
  if (active.reason === "Terminating") return "terminating";
  return active.status === "False" ? "inactive" : "unknown";
}

/** A ClusterQueue's cohort (`cohortName` in v1beta2, `cohort` in v1beta1). */
export const cohortOf = (cq: KubeObject): string | undefined => str(get(cq, "spec", "cohortName")) ?? str(get(cq, "spec", "cohort"));

/** A Cohort's parent (both versions). */
export const parentCohortOf = (cohort: KubeObject): string | undefined => str(get(cohort, "spec", "parentName"));

/** A LocalQueue's ClusterQueue. */
export const clusterQueueOf = (lq: KubeObject): string | undefined => str(get(lq, "spec", "clusterQueue"));

export interface QueueCounts {
  pending: number;
  reserving: number;
  admitted: number;
}

export function queueCounts(obj: KubeObject): QueueCounts {
  return {
    pending: num(get(obj, "status", "pendingWorkloads")) ?? 0,
    reserving: num(get(obj, "status", "reservingWorkloads")) ?? 0,
    admitted: num(get(obj, "status", "admittedWorkloads")) ?? 0,
  };
}

// ---------- Quotas ----------

/** One resource of one flavor of a queue: the quota and what is reserved (admitted or holding quota) and in use. */
export interface QuotaRow {
  flavor: string;
  resource: string;
  nominal?: string;
  borrowingLimit?: string;
  lendingLimit?: string;
  /** Quota held by Workloads with a reservation (`flavorsReservation`). */
  reserved?: string;
  /** Of `reserved`, what is borrowed from the cohort. */
  borrowed?: string;
  /** Quota of admitted Workloads (`flavorsUsage`). */
  used?: string;
  /** `reserved` of `nominal` in percent (borrowing can go over 100). */
  percent?: number;
}

/** `flavor/resource` → { total, borrowed } of a usage list (`flavorsReservation`, `flavorsUsage`, `flavorUsage`). */
function usageOf(list: unknown): Map<string, { total?: string; borrowed?: string }> {
  const out = new Map<string, { total?: string; borrowed?: string }>();
  for (const flavor of arr(list)) {
    const name = str(get(flavor, "name")) ?? "";
    for (const r of arr(get(flavor, "resources"))) {
      out.set(`${name}/${str(get(r, "name")) ?? ""}`, { total: quantity(get(r, "total")), borrowed: quantity(get(r, "borrowed")) });
    }
  }
  return out;
}

function percent(part: string | undefined, whole: string | undefined): number | undefined {
  const p = parseQuantity(part);
  const w = parseQuantity(whole);
  if (p === undefined || w === undefined || w <= 0) return undefined;
  return Math.round((p / w) * 100);
}

/** The quota rows of a ClusterQueue (or a Cohort: its own quotas, no usage), in the order of its resource groups. */
export function quotaRows(obj: KubeObject): QuotaRow[] {
  const reserved = usageOf(get(obj, "status", "flavorsReservation"));
  const used = usageOf(get(obj, "status", "flavorsUsage"));
  const rows: QuotaRow[] = [];
  for (const group of arr(get(obj, "spec", "resourceGroups"))) {
    for (const flavor of arr(get(group, "flavors"))) {
      const name = str(get(flavor, "name")) ?? "";
      for (const r of arr(get(flavor, "resources"))) {
        const resource = str(get(r, "name")) ?? "";
        const key = `${name}/${resource}`;
        const nominal = quantity(get(r, "nominalQuota"));
        const res = reserved.get(key);
        rows.push({
          flavor: name,
          resource,
          nominal,
          borrowingLimit: quantity(get(r, "borrowingLimit")),
          lendingLimit: quantity(get(r, "lendingLimit")),
          reserved: res?.total,
          borrowed: res?.borrowed && parseQuantity(res.borrowed) ? res.borrowed : undefined,
          used: used.get(key)?.total,
          percent: percent(res?.total, nominal),
        });
      }
    }
  }
  return rows;
}

/** A LocalQueue's usage rows (`flavorsReservation` and `flavorsUsage`, v1beta1 `flavorUsage`). */
export function localQueueUsage(lq: KubeObject): QuotaRow[] {
  const reserved = usageOf(get(lq, "status", "flavorsReservation"));
  const used = usageOf(get(lq, "status", "flavorsUsage") ?? get(lq, "status", "flavorUsage"));
  const keys = [...new Set([...reserved.keys(), ...used.keys()])];
  return keys.map((key) => {
    const [flavor = "", resource = ""] = key.split("/");
    return { flavor, resource, reserved: reserved.get(key)?.total, used: used.get(key)?.total };
  });
}

/** The ClusterQueue's flavors (in order) and the resources each covers. */
export function flavorsOf(cq: KubeObject): string[] {
  const names: string[] = [];
  for (const group of arr(get(cq, "spec", "resourceGroups")))
    for (const flavor of arr(get(group, "flavors"))) {
      const name = str(get(flavor, "name"));
      if (name && !names.includes(name)) names.push(name);
    }
  return names;
}

/** The admission checks a ClusterQueue asks for (`admissionChecksStrategy`, and v1beta1's `admissionChecks`). */
export function admissionChecksOf(cq: KubeObject): string[] {
  const names = arr(get(cq, "spec", "admissionChecksStrategy", "admissionChecks")).map((r) => str(get(r, "name")));
  const legacy = arr(get(cq, "spec", "admissionChecks")).map(str);
  return [...new Set([...names, ...legacy].filter((n): n is string => Boolean(n)))];
}

// ---------- Workloads ----------

export type WorkloadState =
  | "finished"
  | "failed"
  | "deactivated"
  | "evicted"
  | "admitted"
  | "checking"
  | "inadmissible"
  | "pending";

export const WORKLOAD_TONE: Record<WorkloadState, Tone> = {
  finished: "success",
  failed: "danger",
  deactivated: "muted",
  evicted: "warning",
  admitted: "success",
  checking: "warning",
  inadmissible: "danger",
  pending: "warning",
};

/**
 * QuotaReserved=False reasons that mean "waiting for quota" — the scheduler's (`pkg/scheduler/scheduler.go`): `Pending`
 * (every version; the only one without the UnadmittedWorkloadsObservability gate), and with it `WaitingForQuota`,
 * `NoMatchingFlavor`, `ExceedsMaxQuota`, `TopologyPlacementFailed`, `WaitingForPreemptedWorkloads`, and
 * `WaitingForPodsReady` (waitForPodsReady holds the queue until admitted Workloads' pods are ready; `Waiting` without
 * the gate — `UnadmittedWorkloadReasonWithFallback` in scheduler.go; reasons in apis/kueue/v1beta2/workload_types.go).
 */
export const QUOTA_REASONS = new Set([
  "Pending",
  "WaitingForQuota",
  "NoMatchingFlavor",
  "ExceedsMaxQuota",
  "TopologyPlacementFailed",
  "WaitingForPreemptedWorkloads",
  "WaitingForPodsReady",
  "Waiting",
]);
/**
 * Reasons that mean the Workload cannot be queued as it is (a missing LocalQueue or ClusterQueue, a namespace the
 * ClusterQueue does not select, DRA resources Kueue cannot resolve): `Inadmissible` (every version), `Misconfigured`
 * and `DRAResourcesUnresolved` (with the gate; Kueue itself reads the last as inadmissible, `isDRAInadmissibleReason`
 * in pkg/controller/core/workload_controller.go). A stopped or inactive queue (`Suspended`, or `Inadmissible` saying
 * so) is the queue's state, told through the queue.
 */
const INADMISSIBLE_REASONS = new Set(["Inadmissible", "Misconfigured", "DRAResourcesUnresolved"]);
const QUEUE_STOPPED = /\bis (?:stopped|inactive)\b/;
/** Deactivations that are a failure, not a user's choice (`Evicted` reason `Deactivated<cause>`). */
const FAILED_DEACTIVATION = /RequeuingLimitExceeded|MaximumExecutionTimeExceeded|AdmissionCheck/;

export interface WorkloadInfo {
  state: WorkloadState;
  /** The LocalQueue (`spec.queueName`). */
  queue?: string;
  /** The ClusterQueue that admitted or reserved quota for it (`status.admission.clusterQueue`). */
  clusterQueue?: string;
  /** Why it is not admitted, or why it was evicted, deactivated or failed: the condition Kueue wrote. */
  why?: Condition & { type: string };
  priority?: number;
  priorityClass?: string;
  /** Evictions so far (`schedulingStats.evictions`, else `requeueState.count`). */
  evictions: number;
}

export const isActiveWorkload = (wl: KubeObject): boolean => get(wl, "spec", "active") !== false;

/** The evictions Kueue counted, by reason and cause (`status.schedulingStats.evictions`). */
export function evictionsOf(wl: KubeObject): { reason: string; cause?: string; count: number }[] {
  return arr(get(wl, "status", "schedulingStats", "evictions")).map((e) => ({
    reason: str(get(e, "reason")) ?? "",
    cause: str(get(e, "underlyingCause")) || undefined,
    count: num(get(e, "count")) ?? 0,
  }));
}

export function evictionCount(wl: KubeObject): number {
  const stats = evictionsOf(wl);
  if (stats.length > 0) return stats.reduce((sum, e) => sum + e.count, 0);
  return num(get(wl, "status", "requeueState", "count")) ?? 0;
}

const withType = (type: string, c: Condition | undefined) => (c ? { ...c, type } : undefined);

export function workloadInfo(wl: KubeObject): WorkloadInfo {
  const finished = conditionOf(wl, "Finished");
  const reserved = conditionOf(wl, "QuotaReserved");
  const admitted = conditionOf(wl, "Admitted");
  const evicted = conditionOf(wl, "Evicted");
  const base = {
    queue: str(get(wl, "spec", "queueName")),
    clusterQueue: str(get(wl, "status", "admission", "clusterQueue")),
    priority: num(get(wl, "spec", "priority")),
    priorityClass: str(get(wl, "spec", "priorityClassRef", "name")) ?? str(get(wl, "spec", "priorityClassName")),
    evictions: evictionCount(wl),
  };
  if (finished?.status === "True")
    return { ...base, state: finished.reason === "Failed" ? "failed" : "finished", why: withType("Finished", finished) };
  if (!isActiveWorkload(wl)) return { ...base, state: "deactivated", why: withType("Evicted", evicted) };
  if (admitted?.status === "True") return { ...base, state: "admitted" };
  if (evicted?.status === "True" && reserved?.status !== "True") return { ...base, state: "evicted", why: withType("Evicted", evicted) };
  if (reserved?.status === "True") return { ...base, state: "checking", why: withType("Admitted", admitted) };
  if (reserved?.status === "False" && INADMISSIBLE_REASONS.has(reserved.reason ?? "") && !QUEUE_STOPPED.test(reserved.message ?? ""))
    return { ...base, state: "inadmissible", why: withType("QuotaReserved", reserved) };
  return { ...base, state: "pending", why: withType("QuotaReserved", reserved) };
}

/** Evicted reasons of a deactivation that do not carry its cause (older Kueue: `InactiveWorkload`; `Deactivated` without one). */
const CAUSELESS_DEACTIVATION = new Set(["InactiveWorkload", "Deactivated"]);

/**
 * A deactivation Kueue made because something failed (the requeuing limit, the maximum execution time, a check): by
 * the Evicted or DeactivationTarget condition's reason (`Deactivated<cause>`), else — where the Evicted reason carries
 * no cause, as older Kueue writes it with the cause in the message only — by the eviction counts' `underlyingCause`
 * of a deactivation (`workloadEvictionStateInc` in pkg/workload/evict/evict.go records reason `Deactivated` with the
 * DeactivationTarget's reason as the cause).
 */
export function failedDeactivation(wl: KubeObject): boolean {
  if (isActiveWorkload(wl)) return false;
  const evicted = conditionOf(wl, "Evicted");
  const target = conditionOf(wl, "DeactivationTarget");
  if ([evicted?.reason, target?.reason].some((r) => r !== undefined && FAILED_DEACTIVATION.test(r))) return true;
  if (evicted?.reason !== undefined && !CAUSELESS_DEACTIVATION.has(evicted.reason)) return false;
  return evictionsOf(wl).some((e) => CAUSELESS_DEACTIVATION.has(e.reason) && e.cause !== undefined && FAILED_DEACTIVATION.test(e.cause));
}

export interface OwnerLink {
  apiVersion: string;
  kind: string;
  name: string;
}

/** The job a Workload belongs to: its controller owner reference, else the composable-job annotations. */
export function ownerOf(wl: KubeObject): OwnerLink | undefined {
  const refs = arr(wl.metadata?.ownerReferences);
  const ref = refs.find((r) => get(r, "controller") === true) ?? refs[0];
  if (ref) {
    const apiVersion = str(get(ref, "apiVersion"));
    const kind = str(get(ref, "kind"));
    const name = str(get(ref, "name"));
    if (apiVersion && kind && name) return { apiVersion, kind, name };
  }
  const annotations = record(wl.metadata?.annotations);
  const gvk = str(annotations[OWNER_GVK_ANNOTATION]);
  const name = str(annotations[OWNER_NAME_ANNOTATION]);
  // "group/version, Kind=Name" as schema.GroupVersionKind prints it ("batch/v1, Kind=Job").
  const m = gvk ? /^(.*), Kind=(.+)$/.exec(gvk) : null;
  return m && name ? { apiVersion: m[1]!, kind: m[2]!, name } : undefined;
}

// ---------- Problems ----------

/** A Workload waiting for quota is a problem after this long (#246). */
export const PENDING_GRACE_MS = 30 * 60_000;
/** A Workload that cannot be queued as it is, and a queue that admits nothing, count after this long. */
export const INADMISSIBLE_GRACE_MS = 5 * 60_000;
export const QUEUE_GRACE_MS = 2 * 60_000;
/** Evictions after which a Workload is "evicted repeatedly". */
export const EVICTIONS_THRESHOLD = 3;
/** A Workload evicted repeatedly and admitted again counts this long after its last eviction. */
export const RECENT_EVICTION_MS = 60 * 60_000;

/**
 * The problems of a ClusterQueue or LocalQueue (category `kueue`): inactive for a reason other than a stop the user
 * asked for (a missing flavor, admission check or topology, a cohort cycle), and a LocalQueue whose ClusterQueue does
 * not exist. A LocalQueue of an inactive ClusterQueue is told through the ClusterQueue.
 */
export function queueProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  if (obj.metadata?.deletionTimestamp) return [];
  const active = conditionOf(obj, "Active");
  if (queueState(obj) !== "inactive" || !active) return [];
  if (isKind(kind, LOCAL_QUEUE) && active.reason !== "ClusterQueueDoesNotExist") return [];
  return [
    {
      reason: active.reason || "Inactive",
      group: "inactive",
      message: active.message,
      since: active.since,
      graceMs: QUEUE_GRACE_MS,
      notify: true,
    },
  ];
}

/**
 * The problems of a Workload (category `kueueWorkloads`, opt-in): waiting for quota longer than `PENDING_GRACE_MS`
 * (from when QuotaReserved turned False, with the scheduler's message: which flavor and resource is short), not
 * queueable as it is (`INADMISSIBLE_GRACE_MS`), evicted `EVICTIONS_THRESHOLD` times or more (while evicted, then
 * for `RECENT_EVICTION_MS`), or deactivated by Kueue for a failure. A finished Workload has none.
 */
export function workloadProblems(wl: KubeObject, now?: number): Detected[] {
  if (wl.metadata?.deletionTimestamp) return [];
  const info = workloadInfo(wl);
  if (info.state === "finished" || info.state === "failed") return [];
  const found: Detected[] = [];
  const why = info.why;
  if (info.state === "pending" && why?.status === "False" && QUOTA_REASONS.has(why.reason ?? ""))
    found.push({ reason: "PendingQuota", group: "pending", message: why.message, since: why.since, graceMs: PENDING_GRACE_MS, notify: true });
  if (info.state === "inadmissible" && why)
    found.push({ reason: "Inadmissible", group: "pending", message: why.message, since: why.since, graceMs: INADMISSIBLE_GRACE_MS, notify: true });
  if (info.state === "deactivated" && failedDeactivation(wl)) {
    const evicted = conditionOf(wl, "Evicted");
    found.push({ reason: "Deactivated", message: evicted?.message, since: evicted?.since, notify: true });
  }
  if (info.state !== "deactivated" && info.evictions >= EVICTIONS_THRESHOLD) {
    const evicted = conditionOf(wl, "Evicted");
    const at = evicted?.since ? Date.parse(evicted.since) : NaN;
    const until = evicted?.status === "True" || Number.isNaN(at) ? undefined : at + RECENT_EVICTION_MS;
    if (until === undefined || now === undefined || now < until)
      found.push({
        reason: "EvictedRepeatedly",
        message: evicted?.message,
        messageKey: "messages.kueueEvictions",
        messageParams: { count: info.evictions },
        since: evicted?.since,
        until,
        stamp: String(info.evictions),
        notify: true,
      });
  }
  return found;
}

/** Whether a Kueue object is in trouble now (the table's "Only problems" filter), as the problems screen counts. */
export function isProblem(obj: KubeObject, kind: Pick<KindRef, "group" | "kind">): boolean {
  const now = Date.now();
  const found = isKind(kind, CLUSTER_QUEUE, LOCAL_QUEUE) ? queueProblems(kind, obj) : isKind(kind, WORKLOAD) ? workloadProblems(obj, now) : [];
  return found.some((p) => !p.graceMs || !p.since || Date.parse(p.since) + p.graceMs <= now);
}

// ---------- Compact rows (the queues' Workload lists) ----------

/** What a queue's details show of one Workload: kept as a row by a tap on the problems store's Workload watch. */
export interface WorkloadRow {
  namespace: string;
  name: string;
  queue?: string;
  clusterQueue?: string;
  state: WorkloadState;
  reason?: string;
  /** The condition's message, clipped to `MAX_ROW_MESSAGE` characters. */
  message?: string;
  since?: string;
  created?: string;
  owner?: OwnerLink;
}

export const MAX_ROW_MESSAGE = 300;

export function workloadRow(wl: KubeObject): WorkloadRow {
  const info = workloadInfo(wl);
  const message = info.why?.message;
  return {
    namespace: wl.metadata?.namespace ?? "",
    name: wl.metadata?.name ?? "",
    queue: info.queue,
    clusterQueue: info.clusterQueue,
    state: info.state,
    reason: info.why?.reason,
    message: message && message.length > MAX_ROW_MESSAGE ? `${message.slice(0, MAX_ROW_MESSAGE)}…` : message,
    since: info.why?.since,
    created: str(wl.metadata?.creationTimestamp),
    owner: ownerOf(wl),
  };
}

/** Whether a row is waiting: pending or inadmissible (not yet holding quota). */
export const isWaiting = (row: Pick<WorkloadRow, "state">): boolean => row.state === "pending" || row.state === "inadmissible";

/**
 * The waiting Workloads of a ClusterQueue: those of its LocalQueues (`localQueues`: `namespace/name` of each LocalQueue
 * pointing at it), oldest first.
 */
export function waitingFor(rows: Iterable<WorkloadRow>, localQueues: ReadonlySet<string>): WorkloadRow[] {
  return [...rows]
    .filter((r) => isWaiting(r) && r.queue !== undefined && localQueues.has(`${r.namespace}/${r.queue}`))
    .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.name.localeCompare(b.name));
}
