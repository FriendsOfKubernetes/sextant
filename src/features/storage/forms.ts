// The objects the storage actions create (#152), built from the form's fields and nothing else, so what the
// confirmation lists is exactly what is applied:
//   snapshotOf        — "Create snapshot" of a claim: a VolumeSnapshot in the claim's namespace;
//   restoredClaimOf   — "Restore to a new PVC" of a ready snapshot: a claim in the snapshot's namespace whose
//                       `dataSource` is the snapshot, at least the snapshot's restore size;
//   veleroBackupOf    — "Back up namespace…": a Velero Backup of that one namespace, in Velero's namespace;
//   veleroRestoreOf   — "Restore from this backup…": a Velero Restore, optionally into other namespaces.
// With `existingResourcePolicy` unset (none) Velero skips most objects that already exist; some kinds (ServiceAccounts)
// are merged.
import type { KubeObject } from "../../api";
import { parseQuantity } from "../metrics/format";
import { SNAPSHOT_GROUP } from "./model";

/** A DNS-1123 subdomain (most object names). */
const SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
/** A DNS-1123 label (namespace names). */
const LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** A quantity of bytes as a claim takes it: "10Gi", "500M", "1073741824". */
const SIZE = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/;
/** A Go duration as Velero reads a TTL: "720h", "72h0m0s", "30m". */
const DURATION = /^(\d+h)?(\d+m)?(\d+s)?$/;

/** Velero's own default TTL of a backup: 30 days. */
export const DEFAULT_TTL = "720h0m0s";
/** Access modes a restored claim can ask for. */
export const ACCESS_MODES = ["ReadWriteOnce", "ReadWriteOncePod", "ReadWriteMany", "ReadOnlyMany"] as const;

/** Names Velero also writes as label values: at most 63 characters. */
const MAX_LABEL_NAME = 63;

export const validName = (name: string): boolean => name.length <= 253 && SUBDOMAIN.test(name);
/** A name Velero also writes into labels. */
export const validVeleroName = (name: string): boolean => name.length <= MAX_LABEL_NAME && SUBDOMAIN.test(name);
export const validNamespace = (name: string): boolean => name.length <= 63 && LABEL.test(name);
export const validTtl = (ttl: string): boolean => ttl !== "" && DURATION.test(ttl);
export const validSize = (size: string): boolean => SIZE.test(size);

/** Whether `size` is a size and at least `minimum` (a quantity; none: any size). */
export function sizeAtLeast(size: string, minimum: string | undefined): boolean {
  if (!validSize(size)) return false;
  if (!minimum) return true;
  const want = parseQuantity(size);
  const least = parseQuantity(minimum);
  return want !== undefined && (least === undefined || want >= least);
}

/** `20261019-1432` for a name suffix. */
export function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** `<base>-<suffix>` within `max` characters: the base is cut (and a trailing dash or dot dropped). */
export function suffixed(base: string, suffix: string, max = MAX_LABEL_NAME): string {
  const room = max - suffix.length - 1;
  const cut = base.slice(0, Math.max(1, room)).replace(/[-.]+$/, "");
  return `${cut}-${suffix}`;
}

export interface SnapshotForm {
  namespace: string;
  claim: string;
  name: string;
  /** `""`: the driver's default class. */
  snapshotClass: string;
}

export function snapshotOf(f: SnapshotForm): KubeObject {
  return {
    apiVersion: `${SNAPSHOT_GROUP}/v1`,
    kind: "VolumeSnapshot",
    metadata: { name: f.name, namespace: f.namespace },
    spec: {
      ...(f.snapshotClass ? { volumeSnapshotClassName: f.snapshotClass } : {}),
      source: { persistentVolumeClaimName: f.claim },
    },
  };
}

export interface RestoreClaimForm {
  namespace: string;
  snapshot: string;
  name: string;
  size: string;
  /** `""`: the cluster's default StorageClass. */
  storageClass: string;
  accessMode: string;
  /** The source claim's `volumeMode` when known (`Block` must stay Block). */
  volumeMode?: string;
}

export function restoredClaimOf(f: RestoreClaimForm): KubeObject {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: f.name, namespace: f.namespace },
    spec: {
      ...(f.storageClass ? { storageClassName: f.storageClass } : {}),
      dataSource: { apiGroup: SNAPSHOT_GROUP, kind: "VolumeSnapshot", name: f.snapshot },
      accessModes: [f.accessMode],
      ...(f.volumeMode ? { volumeMode: f.volumeMode } : {}),
      resources: { requests: { storage: f.size } },
    },
  };
}

export interface BackupForm {
  /** Velero's namespace. */
  veleroNamespace: string;
  name: string;
  /** The namespace backed up. */
  namespace: string;
  ttl: string;
  /** `""`: Velero's default location. */
  storageLocation: string;
}

export function veleroBackupOf(f: BackupForm): KubeObject {
  return {
    apiVersion: "velero.io/v1",
    kind: "Backup",
    metadata: { name: f.name, namespace: f.veleroNamespace },
    spec: {
      includedNamespaces: [f.namespace],
      ttl: f.ttl,
      ...(f.storageLocation ? { storageLocation: f.storageLocation } : {}),
    },
  };
}

export interface RestoreForm {
  veleroNamespace: string;
  name: string;
  backup: string;
  /** Source namespace → target namespace; only the entries that differ are written. */
  mapping: Record<string, string>;
}

export function veleroRestoreOf(f: RestoreForm): KubeObject {
  const mapping = Object.fromEntries(Object.entries(f.mapping).filter(([from, to]) => to !== "" && to !== from));
  return {
    apiVersion: "velero.io/v1",
    kind: "Restore",
    metadata: { name: f.name, namespace: f.veleroNamespace },
    spec: {
      backupName: f.backup,
      ...(Object.keys(mapping).length > 0 ? { namespaceMapping: mapping } : {}),
    },
  };
}
