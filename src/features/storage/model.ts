// Shared vocabulary of the storage insights (#152): the kinds (claims, VolumeSnapshots), their state in one word with
// a tone, and `Phrase` — an i18n key under `storage:` with its values, so the pure helpers return texts
// without React. Read-only helpers; forms.ts builds the objects the actions create.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";

const { get, str } = status;

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const PVC = k("", "v1", "PersistentVolumeClaim");
export const POD = k("", "v1", "Pod");
export const STORAGE_CLASS = k("storage.k8s.io", "v1", "StorageClass");

export const SNAPSHOT_GROUP = "snapshot.storage.k8s.io";
export const VOLUME_SNAPSHOT = k(SNAPSHOT_GROUP, "v1", "VolumeSnapshot");
export const VOLUME_SNAPSHOT_CLASS = k(SNAPSHOT_GROUP, "v1", "VolumeSnapshotClass");
export const VOLUME_SNAPSHOT_CONTENT = k(SNAPSHOT_GROUP, "v1", "VolumeSnapshotContent");

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
