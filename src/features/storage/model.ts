// Shared vocabulary of the storage insights (#152): the kinds (claims, VolumeSnapshots, Velero), their state in one
// word with a tone, and `Phrase` — an i18n key under `storage:` with its values, so the pure helpers return texts
// without React. Read-only helpers; forms.ts builds the objects the actions create.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, str } = status;

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const PVC = k("", "v1", "PersistentVolumeClaim");
export const POD = k("", "v1", "Pod");
export const NAMESPACE = k("", "v1", "Namespace");
export const STORAGE_CLASS = k("storage.k8s.io", "v1", "StorageClass");

export const SNAPSHOT_GROUP = "snapshot.storage.k8s.io";
export const VOLUME_SNAPSHOT = k(SNAPSHOT_GROUP, "v1", "VolumeSnapshot");
export const VOLUME_SNAPSHOT_CLASS = k(SNAPSHOT_GROUP, "v1", "VolumeSnapshotClass");
export const VOLUME_SNAPSHOT_CONTENT = k(SNAPSHOT_GROUP, "v1", "VolumeSnapshotContent");

export const VELERO_GROUP = "velero.io";
export const BACKUP = k(VELERO_GROUP, "v1", "Backup");
export const SCHEDULE = k(VELERO_GROUP, "v1", "Schedule");
export const RESTORE = k(VELERO_GROUP, "v1", "Restore");
export const BACKUP_STORAGE_LOCATION = k(VELERO_GROUP, "v1", "BackupStorageLocation");
export const VOLUME_SNAPSHOT_LOCATION = k(VELERO_GROUP, "v1", "VolumeSnapshotLocation");

/** Where Velero usually runs; used when no BackupStorageLocation says otherwise. */
export const DEFAULT_VELERO_NAMESPACE = "velero";
/** The annotation that marks the default VolumeSnapshotClass of a driver. */
export const DEFAULT_SNAPSHOT_CLASS_ANNOTATION = "snapshot.storage.kubernetes.io/is-default-class";
/** The annotation that marks the cluster's default StorageClass. */
export const DEFAULT_STORAGE_CLASS_ANNOTATION = "storageclass.kubernetes.io/is-default-class";

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

/** An i18n key under `storage:` and its values. */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
  tone?: Tone;
}

const annotation = (obj: KubeObject, key: string): string | undefined => str(get(obj, "metadata", "annotations", key));

// ---------- VolumeSnapshots ----------

/** `status.readyToUse` of a VolumeSnapshot or VolumeSnapshotContent. */
export const readyToUse = (obj: KubeObject): boolean => get(obj, "status", "readyToUse") === true;

/** The snapshotter's error, if it reported one. */
export const snapshotError = (obj: KubeObject): string | undefined => str(get(obj, "status", "error", "message"));

/** "Ready", "Failed" or "Pending", with its tone. */
export function snapshotState(obj: KubeObject): { word: "Ready" | "Failed" | "Pending"; tone: Tone } {
  if (readyToUse(obj)) return { word: "Ready", tone: "success" };
  if (snapshotError(obj)) return { word: "Failed", tone: "danger" };
  return { word: "Pending", tone: "warning" };
}

/** The claim a VolumeSnapshot was taken of (`spec.source.persistentVolumeClaimName`). */
export const snapshotSourceClaim = (obj: KubeObject): string | undefined =>
  str(get(obj, "spec", "source", "persistentVolumeClaimName"));

/** A VolumeSnapshot's `status.restoreSize` (a quantity), or a content's (bytes). */
export function restoreSizeOf(obj: KubeObject): string | undefined {
  const value = get(obj, "status", "restoreSize");
  if (typeof value === "number") return String(value);
  return str(value);
}

export const snapshotClassOf = (obj: KubeObject): string | undefined => str(get(obj, "spec", "volumeSnapshotClassName"));

export const isDefaultSnapshotClass = (obj: KubeObject): boolean =>
  annotation(obj, DEFAULT_SNAPSHOT_CLASS_ANNOTATION) === "true";

export const isDefaultStorageClass = (obj: KubeObject): boolean =>
  annotation(obj, DEFAULT_STORAGE_CLASS_ANNOTATION) === "true";

/** Plain words for a snapshot that is not ready, or `undefined`. */
export function explainSnapshot(obj: KubeObject): Phrase | undefined {
  const error = snapshotError(obj);
  if (error) return { key: "snapshot.explain.failed", params: { message: error }, tone: "danger" };
  if (readyToUse(obj)) return undefined;
  if (!get(obj, "status", "boundVolumeSnapshotContentName")) {
    return { key: "snapshot.explain.unbound", tone: "warning" };
  }
  return { key: "snapshot.explain.pending", tone: "warning" };
}

// ---------- Velero ----------

/** `status.phase` of a Velero object. */
export const phaseOf = (obj: KubeObject): string | undefined => str(get(obj, "status", "phase"));

/** The tone of a Velero phase: done, partly failed, failed (or refused, unreachable), or on its way. */
export function phaseTone(phase: string | undefined): Tone {
  if (!phase) return "muted";
  if (phase === "Completed" || phase === "Enabled" || phase === "Available") return "success";
  if (phase.endsWith("PartiallyFailed")) return "warning";
  if (phase === "Failed" || phase === "FailedValidation" || phase === "Unavailable") return "danger";
  return "muted";
}

/** A Velero object that failed, partly failed, was refused or cannot reach its storage. */
export function hasVeleroProblem(obj: KubeObject): boolean {
  const tone = phaseTone(phaseOf(obj));
  return tone === "danger" || tone === "warning";
}

export const errorCount = (obj: KubeObject): number => num(get(obj, "status", "errors")) ?? 0;
export const warningCount = (obj: KubeObject): number => num(get(obj, "status", "warnings")) ?? 0;

const strings = (value: unknown): string[] => arr(value).filter((v): v is string => typeof v === "string" && v !== "");

export const validationErrors = (obj: KubeObject): string[] => strings(get(obj, "status", "validationErrors"));

/** The namespaces a Backup (or a Schedule's template, or a Restore) names; empty or `*`: every namespace. */
export function includedNamespaces(obj: KubeObject): string[] {
  const spec = isKind(kindOfObject(obj), SCHEDULE) ? get(obj, "spec", "template") : get(obj, "spec");
  return strings(get(spec, "includedNamespaces"));
}

/** The kind of an object by its `apiVersion`/`kind` (only the group and kind matter here). */
function kindOfObject(obj: KubeObject): Pick<KindRef, "group" | "kind"> {
  const apiVersion = obj.apiVersion ?? "";
  return { group: apiVersion.includes("/") ? apiVersion.split("/")[0]! : "", kind: obj.kind ?? "" };
}

/** Items done of the total, while a backup or restore runs. */
export function progressOf(obj: KubeObject): { done: number; total: number } | undefined {
  const progress = get(obj, "status", "progress");
  const total = num(get(progress, "totalItems"));
  const done = num(get(progress, "itemsBackedUp")) ?? num(get(progress, "itemsRestored"));
  return total === undefined || done === undefined ? undefined : { done, total };
}

/**
 * Plain words for a Velero object's state: why it was refused or failed, how much went wrong, how far it got. Lists
 * (validation errors) come raw in `lists` and are joined when shown.
 */
export function explainVelero(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): (Phrase & { lists?: Record<string, string[]> })[] {
  const out: (Phrase & { lists?: Record<string, string[]> })[] = [];
  const phase = phaseOf(obj);
  const name = obj.metadata?.name ?? "";
  const restore = isKind(kind, RESTORE);
  const invalid = validationErrors(obj);
  if (invalid.length > 0) out.push({ key: "velero.explain.validation", lists: { errors: invalid }, tone: "danger" });
  else if (phase === "FailedValidation") out.push({ key: "velero.explain.validationNoReason", tone: "danger" });
  if (phase === "Failed") {
    const reason = str(get(obj, "status", "failureReason"));
    out.push(reason ? { key: "velero.explain.failed", params: { reason }, tone: "danger" } : { key: "velero.explain.failedNoReason", tone: "danger" });
  }
  const errors = errorCount(obj);
  if (phase?.endsWith("PartiallyFailed") || (errors > 0 && phase !== "Failed")) {
    out.push({ key: restore ? "velero.explain.restoreErrors" : "velero.explain.backupErrors", params: { count: errors }, tone: "warning" });
  }
  const warnings = warningCount(obj);
  if (warnings > 0) out.push({ key: "velero.explain.warnings", params: { count: warnings }, tone: "warning" });
  if ((errors > 0 || phase === "Failed") && (isKind(kind, BACKUP) || restore)) {
    out.push({ key: restore ? "velero.explain.restoreLogs" : "velero.explain.backupLogs", params: { name } });
  }
  const progress = progressOf(obj);
  if (progress && (phase === "InProgress" || phase === "New")) {
    out.push({ key: "velero.explain.progress", params: { done: progress.done, total: progress.total } });
  }
  if (phase === "Deleting") out.push({ key: "velero.explain.deleting" });
  if (isKind(kind, SCHEDULE) && get(obj, "spec", "paused") === true) out.push({ key: "velero.explain.paused", tone: "warning" });
  if (phase === "Unavailable") {
    const message = str(get(obj, "status", "message"));
    out.push(message ? { key: "velero.explain.unavailable", params: { message }, tone: "danger" } : { key: "velero.explain.unavailableNoMessage", tone: "danger" });
  }
  return out;
}

/**
 * The namespace Velero runs in: where its default BackupStorageLocation is, else its first one, else `velero`.
 * Backups and Restores are created there.
 */
export function veleroNamespaceOf(locations: readonly KubeObject[]): string {
  const ns = (o: KubeObject | undefined) => o?.metadata?.namespace;
  return ns(locations.find((l) => get(l, "spec", "default") === true)) ?? ns(locations[0]) ?? DEFAULT_VELERO_NAMESPACE;
}
