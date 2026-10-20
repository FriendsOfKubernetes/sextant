// What the CloudNativePG section reads from postgresql.cnpg.io objects: the kinds it knows, a Cluster's phase,
// instances, primary and replicas (from its status, as the operator reports them), a switchover or failover in
// progress, declarative hibernation, backups and continuous archiving; a Backup's phase. Pure functions, no React.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";

const { arr, get, num, record, str } = status;

export const CNPG_GROUP = "postgresql.cnpg.io";
const k = (kind: string): KindRef => ({
  group: CNPG_GROUP,
  version: "v1",
  kind,
});

export const PG_CLUSTER = k("Cluster");
export const BACKUP = k("Backup");
export const SCHEDULED_BACKUP = k("ScheduledBackup");
export const POOLER = k("Pooler");

export interface CnpgKind {
  kind: KindRef;
  order: number;
  /** Key under `cnpg:sidebar`. */
  label: string;
}

export const CNPG_KINDS: CnpgKind[] = [
  { kind: PG_CLUSTER, order: 10, label: "clusters" },
  { kind: BACKUP, order: 20, label: "backups" },
  { kind: SCHEDULED_BACKUP, order: 21, label: "scheduledBackups" },
  { kind: POOLER, order: 30, label: "poolers" },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

export const cnpgKind = (kind: Pick<KindRef, "group" | "kind">): CnpgKind | undefined =>
  CNPG_KINDS.find((d) => isKind(kind, d.kind));

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

// ---------- Cluster ----------

/** The healthy phase the operator reports (`apiv1.PhaseHealthy`). */
export const HEALTHY_PHASE = "Cluster in healthy state";
const SWITCHOVER_PHASES = new Set(["Switchover in progress", "Promoting to primary cluster"]);
/** Phases that need someone: an unrecoverable cluster, objects it cannot create, a plugin or image catalog error. */
const STUCK_PHASE = /unrecoverable|cannot|unable|waiting for user|error/i;

export type ClusterState = "healthy" | "hibernated" | "hibernating" | "switchover" | "failover" | "progressing" | "unhealthy";

/**
 * Declarative hibernation (pkg/reconciler/hibernation in CloudNativePG): the annotation `cnpg.io/hibernation: "on"`
 * (exactly "on"; any other value turns it off and removes the condition) makes the operator delete the instances' pods
 * and keep their volumes. The condition `cnpg.io/hibernation` says how far it is: True/`Hibernated` once no pod is
 * left; False/`DeletingPods` or `WaitingPodsDeletion` on the way; False/`WaitingForHealthy` while the cluster is not
 * healthy enough to start. The phase is left as it was (often "Cluster in healthy state") and `readyInstances` drops to
 * 0, so a hibernated cluster looks unready by every other field: it is a steady state the user asked for, not a fault.
 */
export const HIBERNATION_ANNOTATION = "cnpg.io/hibernation";
export const HIBERNATION_CONDITION = "cnpg.io/hibernation";

/** `hibernated` / `hibernating` while hibernation is on and has started; `undefined` otherwise. */
export function hibernationOf(obj: KubeObject): "hibernated" | "hibernating" | undefined {
  if (record(obj.metadata?.annotations)[HIBERNATION_ANNOTATION] !== "on") return undefined;
  const c = conditionOf(obj, HIBERNATION_CONDITION);
  if (c?.status === "True") return "hibernated";
  // Not started yet: the cluster must first be healthy, and is judged as any other until then.
  if (c?.reason === "WaitingForHealthy") return undefined;
  return "hibernating";
}

export interface Instance {
  name: string;
  role: "primary" | "replica";
  /** `healthy`, `failed`, `replicating`, … as `status.instancesStatus` lists it; `undefined` when not listed. */
  health?: string;
  timeline?: number;
}

export interface ClusterInfo {
  phase?: string;
  phaseReason?: string;
  instances: number;
  ready: number;
  currentPrimary?: string;
  targetPrimary?: string;
  /** The primary is being changed: `targetPrimary` differs from `currentPrimary`. */
  changingPrimary: boolean;
  /** A replica cluster (`spec.replica.enabled`): its primary is a designated primary following another cluster. */
  replicaCluster: boolean;
  members: Instance[];
  lastSuccessfulBackup?: string;
  lastFailedBackup?: string;
  firstRecoverabilityPoint?: string;
  image?: string;
  storageSize?: string;
  state: ClusterState;
}

export function clusterInfo(obj: KubeObject): ClusterInfo {
  const s = get(obj, "status");
  const currentPrimary = str(get(s, "currentPrimary"));
  const targetPrimary = str(get(s, "targetPrimary"));
  const health = new Map<string, string>();
  for (const [state, names] of Object.entries(record(get(s, "instancesStatus")))) {
    for (const name of arr(names)) health.set(String(name), state);
  }
  const reported = record(get(s, "instancesReportedState"));
  const names = new Set<string>([...arr(get(s, "instanceNames")).map(String), ...health.keys(), ...Object.keys(reported)]);
  const members: Instance[] = [...names].sort().map((name) => {
    const r = reported[name];
    const primary = name === currentPrimary || get(r, "isPrimary") === true;
    return {
      name,
      role: primary ? "primary" : "replica",
      health: health.get(name),
      timeline: num(get(r, "timeLineID")),
    };
  });
  members.sort((a, b) => (a.role === b.role ? 0 : a.role === "primary" ? -1 : 1));
  const phase = str(get(s, "phase"));
  const changingPrimary = !!targetPrimary && !!currentPrimary && targetPrimary !== currentPrimary;
  const instances = num(get(obj, "spec", "instances")) ?? num(get(s, "instances")) ?? 0;
  const ready = num(get(s, "readyInstances")) ?? 0;
  const info: ClusterInfo = {
    phase,
    phaseReason: str(get(s, "phaseReason")),
    instances,
    ready,
    currentPrimary,
    targetPrimary,
    changingPrimary,
    replicaCluster: get(obj, "spec", "replica", "enabled") === true,
    members,
    lastSuccessfulBackup: str(get(s, "lastSuccessfulBackup")),
    lastFailedBackup: str(get(s, "lastFailedBackup")),
    firstRecoverabilityPoint: str(get(s, "firstRecoverabilityPoint")),
    image: str(get(obj, "spec", "imageName")) ?? str(get(s, "image")),
    storageSize: str(get(obj, "spec", "storage", "size")),
    state: "progressing",
  };
  info.state = clusterState(obj, info);
  return info;
}

function clusterState(obj: KubeObject, info: Omit<ClusterInfo, "state">): ClusterState {
  const hibernation = hibernationOf(obj);
  if (hibernation) return hibernation;
  if (info.phase === "Failing over" || (info.changingPrimary && info.targetPrimary === "pending")) return "failover";
  if (info.changingPrimary || (info.phase && SWITCHOVER_PHASES.has(info.phase))) return "switchover";
  const ready = conditionOf(obj, "Ready");
  if (info.phase === HEALTHY_PHASE && ready?.status !== "False") return "healthy";
  if (info.phase && STUCK_PHASE.test(info.phase)) return "unhealthy";
  return "progressing";
}

export const CLUSTER_TONE: Record<ClusterState, Tone> = {
  healthy: "success",
  hibernated: "muted",
  hibernating: "muted",
  switchover: "warning",
  failover: "danger",
  progressing: "warning",
  unhealthy: "danger",
};

/** Continuous archiving of WAL: the `ContinuousArchiving` condition; `undefined` when the cluster has no backup set up. */
export const archivingOf = (obj: KubeObject): Condition | undefined => conditionOf(obj, "ContinuousArchiving");
/** Whether the last backup succeeded: the `LastBackupSucceeded` condition. */
export const lastBackupOf = (obj: KubeObject): Condition | undefined => conditionOf(obj, "LastBackupSucceeded");

// ---------- Backups ----------

export type BackupState = "completed" | "failed" | "running" | "pending";

export function backupState(obj: KubeObject): BackupState {
  const phase = (str(get(obj, "status", "phase")) ?? "").toLowerCase();
  if (phase === "completed") return "completed";
  if (phase === "failed" || phase === "walarchivingfailing") return "failed";
  if (phase === "started" || phase === "running" || phase === "finalizing") return "running";
  return "pending";
}

export const BACKUP_TONE: Record<BackupState, Tone> = {
  completed: "success",
  failed: "danger",
  running: "warning",
  pending: "muted",
};

/** The Cluster a Backup, ScheduledBackup or Pooler belongs to (`spec.cluster.name`). */
export const clusterNameOf = (obj: KubeObject): string | undefined => str(get(obj, "spec", "cluster", "name"));

/** How a backup is taken: `barmanObjectStore` (default), `volumeSnapshot` or `plugin`. */
export const backupMethodOf = (obj: KubeObject): string =>
  str(get(obj, "spec", "method")) ?? str(get(obj, "status", "method")) ?? "barmanObjectStore";

export const isProblem = (obj: KubeObject, kind: Pick<KindRef, "group" | "kind">): boolean => {
  if (isKind(kind, BACKUP)) return backupState(obj) === "failed";
  if (isKind(kind, PG_CLUSTER)) return cnpgProblems(kind, obj, Number.POSITIVE_INFINITY).length > 0;
  return false;
};

// ---------- Problems ----------

/** A Cluster not ready counts after this long (instances start, a switchover takes a while). */
export const CLUSTER_GRACE_MS = 5 * 60_000;
/** A failed Backup is a problem for a day after it stopped; the Cluster's LastBackupSucceeded keeps the lasting state. */
export const FAILED_BACKUP_MS = 24 * 3600_000;

/**
 * When a failed Backup stopped. The operator's `SetAsFailed` (api/v1/backup_funcs.go) sets only the phase, the error
 * and `reconciliationTerminatedAt`; `stoppedAt` is written only by the backup tools when a backup ran to its end
 * (barman, a plugin, a volume snapshot on completion), so most failed Backups have none. The first time known of:
 * `stoppedAt`, `reconciliationTerminatedAt`, `startedAt`, `reconciliationStartedAt`, the object's creation.
 */
export function backupStoppedAt(obj: KubeObject): string | undefined {
  for (const field of ["stoppedAt", "reconciliationTerminatedAt", "startedAt", "reconciliationStartedAt"]) {
    const value = str(get(obj, "status", field));
    if (time(value) !== undefined) return value;
  }
  const created = str(obj.metadata?.creationTimestamp);
  return time(created) !== undefined ? created : undefined;
}

function time(value: string | undefined): number | undefined {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? undefined : t;
}

/**
 * The problems of a CloudNativePG object: a Cluster not ready (after a grace), its archiving or last backup failing,
 * a failed Backup (for a day). `now` only for the table filter, which has no grace (the store applies `graceMs`).
 */
export function cnpgProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject, now?: number): Detected[] {
  if (obj.metadata?.deletionTimestamp) return [];
  const found: Detected[] = [];
  if (isKind(kind, PG_CLUSTER)) {
    const info = clusterInfo(obj);
    const ready = conditionOf(obj, "Ready");
    const steady = info.state === "healthy" || info.state === "hibernated" || info.state === "hibernating";
    if (!steady && (ready?.status === "False" || info.ready < info.instances)) {
      found.push({
        reason: info.state === "failover" ? "FailingOver" : ready?.reason || "ClusterNotReady",
        group: "notReady",
        message: info.phaseReason || info.phase,
        since: ready?.since,
        graceMs: CLUSTER_GRACE_MS,
        notify: true,
      });
    }
    const archiving = archivingOf(obj);
    if (archiving?.status === "False") {
      found.push({
        reason: archiving.reason || "ContinuousArchivingFailing",
        message: archiving.message,
        since: archiving.since,
        notify: true,
      });
    }
    const backup = lastBackupOf(obj);
    if (backup?.status === "False") {
      found.push({
        reason: backup.reason || "LastBackupFailed",
        message: backup.message,
        since: backup.since,
        notify: true,
      });
    }
  } else if (isKind(kind, BACKUP) && backupState(obj) === "failed") {
    const stoppedAt = backupStoppedAt(obj);
    const stopped = time(stoppedAt);
    const until = stopped === undefined ? undefined : stopped + FAILED_BACKUP_MS;
    if (until !== undefined && now !== undefined && Number.isFinite(now) && now >= until) return [];
    found.push({
      reason: "BackupFailed",
      message: str(get(obj, "status", "error")),
      since: stoppedAt,
      until,
      notify: true,
    });
  }
  return found;
}
