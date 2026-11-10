// What the views read of Velero's objects (Backup, Schedule, Restore, BackupStorageLocation, VolumeSnapshotLocation
// of `velero.io/v1`), ported unchanged from Sextant's former built-in view (ADR-0086, `src/features/storage/model.ts`):
// a phase's tone, "needs attention" for "Only problems", the state in plain words — why it was refused or failed, how
// much went wrong, how far it got — and the namespace Velero runs in. `Phrase` is a text key with its values, so these
// helpers return texts without the DOM. Read-only; forms.ts builds the objects the actions create.
import type { KubeObject } from "@sextant/extension-sdk";

/** A kind as the views name it. */
export interface KindOf {
  group: string;
  version: string;
  kind: string;
}

export const VELERO_GROUP = "velero.io";
const k = (kind: string): KindOf => ({ group: VELERO_GROUP, version: "v1", kind });

export const BACKUP = k("Backup");
export const SCHEDULE = k("Schedule");
export const RESTORE = k("Restore");
export const BACKUP_STORAGE_LOCATION = k("BackupStorageLocation");
export const VOLUME_SNAPSHOT_LOCATION = k("VolumeSnapshotLocation");
export const NAMESPACE: KindOf = { group: "", version: "v1", kind: "Namespace" };

/** Velero's kinds, in the section's order. */
export const VELERO_KINDS: readonly KindOf[] = [BACKUP, SCHEDULE, RESTORE, BACKUP_STORAGE_LOCATION, VOLUME_SNAPSHOT_LOCATION];

/** Where Velero usually runs; used when no BackupStorageLocation says otherwise. */
export const DEFAULT_VELERO_NAMESPACE = "velero";

export const isKind = (a: Pick<KindOf, "group" | "kind">, ...of: Pick<KindOf, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

/** The tone of a status word, as the SDK's UI kit colours it. */
export type Tone = "success" | "warning" | "danger" | "muted" | "neutral";

/** A text key of the extension's catalog and its values. */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
  tone?: Tone;
  /** Lists (validation errors) raw: joined in the UI language when shown. */
  lists?: Record<string, string[]>;
}

// ---------- Reading fields ----------

export function get(value: unknown, ...path: string[]): unknown {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** A string, else nothing (as Sextant's `status.str`). */
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** A number, else nothing (as Sextant's `status.num`). */
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === "string" && v !== "");

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

/** A Velero object that failed, partly failed, was refused or cannot reach its storage ("Only problems"). */
export function hasVeleroProblem(obj: KubeObject): boolean {
  const tone = phaseTone(phaseOf(obj));
  return tone === "danger" || tone === "warning";
}

export const errorCount = (obj: KubeObject): number => num(get(obj, "status", "errors")) ?? 0;
export const warningCount = (obj: KubeObject): number => num(get(obj, "status", "warnings")) ?? 0;

export const validationErrors = (obj: KubeObject): string[] => strings(get(obj, "status", "validationErrors"));

/** The kind of an object by its `apiVersion`/`kind` (only the group and kind matter here). */
function kindOfObject(obj: KubeObject): Pick<KindOf, "group" | "kind"> {
  const apiVersion = obj.apiVersion ?? "";
  return { group: apiVersion.includes("/") ? apiVersion.split("/")[0]! : "", kind: obj.kind ?? "" };
}

/** The namespaces a Backup (or a Schedule's template, or a Restore) names; empty or `*`: every namespace. */
export function includedNamespaces(obj: KubeObject): string[] {
  const spec = isKind(kindOfObject(obj), SCHEDULE) ? get(obj, "spec", "template") : get(obj, "spec");
  return strings(get(spec, "includedNamespaces"));
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
export function explainVelero(kind: Pick<KindOf, "group" | "kind">, obj: KubeObject): Phrase[] {
  const out: Phrase[] = [];
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
