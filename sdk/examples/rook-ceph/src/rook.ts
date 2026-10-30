// Rook's objects, read by the field names of Rook's types (github.com/rook/rook, pkg/apis/ceph.rook.io/v1/types.go,
// read at v1.21.1) and of lib-bucket-provisioner's ObjectBucketClaim (objectbucket.io/v1alpha1). Nothing here is
// computed that Rook does not write: the health is Ceph's, as Rook last read it.
import type { KubeObject, ObjectRef } from "@sextant/extension-sdk";

export const ROOK_GROUP = "ceph.rook.io";
export const OBC_GROUP = "objectbucket.io";

export const CEPH_CLUSTER = { group: ROOK_GROUP, kind: "CephCluster" };
export const CEPH_BLOCK_POOL = { group: ROOK_GROUP, kind: "CephBlockPool" };
export const CEPH_FILESYSTEM = { group: ROOK_GROUP, kind: "CephFilesystem" };
export const CEPH_OBJECT_STORE = { group: ROOK_GROUP, kind: "CephObjectStore" };
export const CEPH_OBJECT_STORE_USER = { group: ROOK_GROUP, kind: "CephObjectStoreUser" };
export const CEPH_NFS = { group: ROOK_GROUP, kind: "CephNFS" };
export const CEPH_CLIENT = { group: ROOK_GROUP, kind: "CephClient" };
export const OBJECT_BUCKET_CLAIM = { group: OBC_GROUP, kind: "ObjectBucketClaim" };
export const OBJECT_BUCKET = { group: OBC_GROUP, kind: "ObjectBucket" };
export const POD = { group: "", kind: "Pod" };
export const PVC = { group: "", kind: "PersistentVolumeClaim" };
export const STORAGE_CLASS = { group: "storage.k8s.io", kind: "StorageClass" };

/** Minutes after Rook's last health check when the status counts as stale: the manifest's `health-stale` rule. */
export const STALE_MINUTES = 15;

/** `CephHealthMessage`. */
export interface HealthMessage {
  severity?: string;
  message?: string;
}

/** `ClusterStatus` with `CephStatus` (`status.ceph`), `ClusterVersion` (`status.version`). */
export interface CephClusterStatus {
  /** Deprecated `ClusterState`: Creating, Created, Updating, Connecting, Connected, Error. */
  state?: string;
  /** `ConditionType`: Progressing, Ready, Updating, Failure, Deleting, Connecting, Connected. */
  phase?: string;
  message?: string;
  conditions?: Condition[];
  ceph?: {
    health?: string;
    details?: Record<string, HealthMessage>;
    /** RFC 3339, written by the operator's health checker each run. */
    lastChecked?: string;
    lastChanged?: string;
    previousHealth?: string;
    capacity?: { bytesTotal?: number; bytesUsed?: number; bytesAvailable?: number; lastUpdated?: string };
    /** Daemon type → "ceph version … (…) squid (stable)" → count; `overall` sums them. */
    versions?: Record<string, Record<string, number>>;
    fsid?: string;
  };
  version?: { image?: string; version?: string };
  storage?: { deviceClasses?: { name?: string }[] };
  observedGeneration?: number;
}

export interface CephClusterSpec {
  external?: { enable?: boolean };
  cephVersion?: { image?: string };
  mon?: { count?: number };
  mgr?: { count?: number };
  healthCheck?: { daemonHealth?: { status?: { interval?: string } } };
}

export interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export type CephCluster = KubeObject<CephClusterSpec, CephClusterStatus>;

/** CephBlockPool, CephFilesystem, CephObjectStore, …: every Rook kind but CephCluster has a `phase`. */
export interface RookStatus {
  phase?: string;
  message?: string;
  info?: Record<string, string>;
  conditions?: Condition[];
  /** CephObjectStore's `ObjectEndpoints`. */
  endpoints?: { insecure?: string[] | null; secure?: string[] | null };
  /** CephBlockPool's Ceph pool id. */
  poolID?: number;
}

/** CephBlockPool's `spec.name` overrides the Ceph pool's name (`.mgr`, `.nfs`); otherwise it is the object's name. */
export type CephBlockPool = KubeObject<{ name?: string; replicated?: { size?: number }; erasureCoded?: object }, RookStatus>;
export type CephFilesystem = KubeObject<{ dataPools?: { name?: string }[] }, RookStatus>;
export type CephObjectStore = KubeObject<Record<string, unknown>, RookStatus>;
export type RookObject = KubeObject<Record<string, unknown>, RookStatus>;

export type Health = "HEALTH_OK" | "HEALTH_WARN" | "HEALTH_ERR" | "unknown";

/** Ceph's health as Rook last wrote it; anything else (none yet, an external cluster not read) is unknown. */
export function healthOf(cluster: CephCluster): Health {
  const health = cluster.status?.ceph?.health;
  return health === "HEALTH_OK" || health === "HEALTH_WARN" || health === "HEALTH_ERR" ? health : "unknown";
}

export interface HealthCheck {
  /** Ceph's check code, such as `OSD_DOWN`. */
  code: string;
  severity: "HEALTH_WARN" | "HEALTH_ERR" | "other";
  /** Ceph's own summary, such as "1 osds down". */
  message: string;
}

/** The checks of `status.ceph.details`, errors first, then by code. */
export function healthChecks(cluster: CephCluster): HealthCheck[] {
  const details = cluster.status?.ceph?.details ?? {};
  const checks = Object.entries(details).map(([code, detail]): HealthCheck => {
    const severity = detail?.severity === "HEALTH_ERR" || detail?.severity === "HEALTH_WARN" ? detail.severity : "other";
    return { code, severity, message: typeof detail?.message === "string" ? detail.message : "" };
  });
  const rank = (c: HealthCheck) => (c.severity === "HEALTH_ERR" ? 0 : c.severity === "HEALTH_WARN" ? 1 : 2);
  return checks.sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}

export interface Capacity {
  total: number;
  used: number;
  available: number;
  /** used / total, 0–1; `null` when the total is unknown. */
  fraction: number | null;
  lastUpdated: string | null;
}

/** `status.ceph.capacity`, or `null` before Rook has read it (an external cluster may never have it). */
export function capacityOf(cluster: CephCluster): Capacity | null {
  const capacity = cluster.status?.ceph?.capacity;
  const total = capacity?.bytesTotal;
  if (typeof total !== "number" || total <= 0) return null;
  const used = typeof capacity?.bytesUsed === "number" ? capacity.bytesUsed : 0;
  const available = typeof capacity?.bytesAvailable === "number" ? capacity.bytesAvailable : Math.max(0, total - used);
  return { total, used, available, fraction: Math.min(1, used / total), lastUpdated: capacity?.lastUpdated ?? null };
}

export interface Versions {
  /** The Ceph version Rook reports for the cluster (`status.version.version`), such as `20.2.0-0`. */
  version: string | null;
  image: string | null;
  /** Each distinct running version and how many daemons run it (`versions.overall`). */
  running: { version: string; daemons: number }[];
}

export function versionsOf(cluster: CephCluster): Versions {
  const overall = cluster.status?.ceph?.versions?.overall ?? {};
  const running = Object.entries(overall)
    .filter(([, n]) => typeof n === "number")
    .map(([version, daemons]) => ({ version: shortVersion(version), daemons }))
    .sort((a, b) => b.daemons - a.daemons);
  return {
    version: cluster.status?.version?.version ?? null,
    image: cluster.status?.version?.image ?? cluster.spec?.cephVersion?.image ?? null,
    running,
  };
}

/** "ceph version 20.2.0 (69f84…) tentacle (stable)" → "20.2.0 tentacle (stable)"; anything else as it is. */
export function shortVersion(text: string): string {
  const match = /^ceph version (\S+) \([0-9a-f]+\) (.+)$/.exec(text);
  return match ? `${match[1]} ${match[2]}` : text;
}

/** When Rook last checked Ceph's health (ms), and whether that is longer ago than `STALE_MINUTES`. */
export function freshnessOf(cluster: CephCluster, now: number): { checked: number | null; stale: boolean } {
  const text = cluster.status?.ceph?.lastChecked;
  const checked = text ? Date.parse(text) : NaN;
  if (Number.isNaN(checked)) return { checked: null, stale: false };
  return { checked, stale: now - checked > STALE_MINUTES * 60_000 };
}

export type Tone = "ok" | "warning" | "error" | "neutral";

/** How a Rook phase reads: Ready and Connected are good, Failure is bad, the rest is on its way. */
export function phaseTone(phase: string | undefined): Tone {
  if (phase === "Ready" || phase === "Connected" || phase === "Bound") return "ok";
  if (phase === "Failure" || phase === "Failed") return "error";
  if (!phase) return "neutral";
  return "warning";
}

export function healthTone(health: Health): Tone {
  return health === "HEALTH_OK" ? "ok" : health === "HEALTH_WARN" ? "warning" : health === "HEALTH_ERR" ? "error" : "neutral";
}

/** The Ceph pool a CephBlockPool makes: `spec.name` when set (as Rook's `getPoolName`), else its name. */
export function cephPoolName(pool: CephBlockPool): string {
  const name = pool.spec?.name;
  return typeof name === "string" && name !== "" ? name : pool.metadata.name;
}

/** An `ObjectRef` of a listed object of `kind` (the version from its `apiVersion`). */
export function refOf(
  object: { apiVersion?: string; metadata: { name: string; namespace?: string } },
  kind: { group: string; kind: string },
): ObjectRef {
  const version = (object.apiVersion ?? "").split("/").pop() ?? "";
  return { kind: { group: kind.group, version, kind: kind.kind }, namespace: object.metadata.namespace ?? null, name: object.metadata.name };
}
