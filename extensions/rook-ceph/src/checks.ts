// Ceph's health checks in plain words: what a code means and where to look, after Ceph's documentation of its health
// checks (doc/rados/operations/health-checks.rst, doc/cephfs/health-messages.rst). The texts are in the catalogs
// (`checks.<CODE>.meaning`, `checks.<CODE>.next`). A code not listed here is shown with Ceph's own message only:
// Ceph has more checks than these, and adds new ones.
import { t } from "./i18n";

export interface CheckWords {
  /** What it means, in one sentence. */
  meaning: string;
  /** What to look at first. */
  next?: string;
}

/** The codes explained, and where their "what to look at" comes from: their own text, the toolbox one, or none. */
export const KNOWN_CHECKS: Readonly<Record<string, "own" | "toolbox" | "none">> = {
  MON_DOWN: "own",
  MON_CLOCK_SKEW: "own",
  MON_DISK_LOW: "own",
  MON_DISK_CRIT: "own",
  MON_MSGR2_NOT_ENABLED: "none",
  MGR_DOWN: "own",
  MGR_MODULE_ERROR: "toolbox",
  MGR_MODULE_DEPENDENCY: "none",
  OSD_DOWN: "own",
  OSD_HOST_DOWN: "own",
  OSD_ROOT_DOWN: "none",
  OSD_ORPHAN: "none",
  OSD_OUT_OF_ORDER_FULL: "none",
  OSD_NEARFULL: "own",
  OSD_BACKFILLFULL: "none",
  OSD_FULL: "own",
  OSD_FLAGS: "none",
  OSDMAP_FLAGS: "none",
  OSD_UPGRADE_FINISHED: "none",
  OSD_FILESTORE: "none",
  OSD_SLOW_PING_TIME_FRONT: "none",
  OSD_SLOW_PING_TIME_BACK: "none",
  OSD_TOO_MANY_REPAIRS: "none",
  TOO_FEW_OSDS: "none",
  BLUESTORE_SLOW_OP_ALERT: "none",
  BLUESTORE_SPURIOUS_READ_ERRORS: "none",
  BLUESTORE_NO_PER_POOL_OMAP: "none",
  BLUEFS_SPILLOVER: "none",
  BLUEFS_LOW_SPACE: "none",
  DEVICE_HEALTH: "own",
  DEVICE_HEALTH_IN_USE: "none",
  PG_AVAILABILITY: "own",
  PG_DEGRADED: "own",
  PG_RECOVERY_FULL: "none",
  PG_BACKFILL_FULL: "none",
  PG_DAMAGED: "toolbox",
  OSD_SCRUB_ERRORS: "toolbox",
  OBJECT_UNFOUND: "toolbox",
  OBJECT_MISPLACED: "none",
  PG_NOT_SCRUBBED: "none",
  PG_NOT_DEEP_SCRUBBED: "none",
  PG_SLOW_SNAP_TRIMMING: "none",
  RECENT_CRASH: "own",
  SLOW_OPS: "toolbox",
  POOL_FULL: "none",
  POOL_NEAR_FULL: "none",
  POOL_NO_REDUNDANCY: "none",
  POOL_APP_NOT_ENABLED: "none",
  POOL_TOO_FEW_PGS: "none",
  POOL_TOO_MANY_PGS: "none",
  TOO_MANY_PGS: "none",
  POOL_TARGET_SIZE_BYTES_OVERCOMMITTED: "none",
  FS_DEGRADED: "own",
  FS_WITH_FAILED_MDS: "none",
  MDS_ALL_DOWN: "own",
  MDS_INSUFFICIENT_STANDBY: "none",
  MDS_SLOW_REQUEST: "none",
  MDS_SLOW_METADATA_IO: "none",
  MDS_CLIENT_LATE_RELEASE: "none",
  MDS_CLIENT_RECALL: "none",
  MDS_TRIM: "none",
  MDS_CACHE_OVERSIZED: "none",
  MDS_DAMAGE: "toolbox",
  AUTH_INSECURE_GLOBAL_ID_RECLAIM: "none",
  AUTH_INSECURE_GLOBAL_ID_RECLAIM_ALLOWED: "none",
  AUTH_BAD_CAPS: "none",
};

/** The plain words of a code in the UI language, or `null` when it is not one listed here. */
export function wordsOf(code: string): CheckWords | null {
  if (!Object.hasOwn(KNOWN_CHECKS, code)) return null;
  const next = KNOWN_CHECKS[code];
  const meaning = t(`checks.${code}.meaning`);
  if (next === "own") return { meaning, next: t(`checks.${code}.next`) };
  if (next === "toolbox") return { meaning, next: t("checks.next.toolbox") };
  return { meaning };
}
