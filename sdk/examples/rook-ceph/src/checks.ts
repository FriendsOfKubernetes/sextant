// Ceph's health checks in plain words: what a code means and where to look, after Ceph's documentation of its health
// checks (doc/rados/operations/health-checks.rst, doc/cephfs/health-messages.rst). A code not listed here is shown
// with Ceph's own message only: Ceph has more checks than these, and adds new ones.

export interface CheckWords {
  /** What it means, in one sentence. */
  meaning: string;
  /** What to look at first. */
  next?: string;
}

const TOOLBOX = "In the toolbox, `ceph health detail` lists what it is about.";

export const CHECK_WORDS: Readonly<Record<string, CheckWords>> = {
  // Monitors
  MON_DOWN: {
    meaning: "One or more monitors are down; the cluster keeps working while a majority of monitors is up.",
    next: "Look at the rook-ceph-mon pods on the Daemons tab.",
  },
  MON_CLOCK_SKEW: {
    meaning: "The clocks of the monitors' nodes differ by more than Ceph allows.",
    next: "Check time synchronisation (NTP, chrony) on the nodes running monitors.",
  },
  MON_DISK_LOW: {
    meaning: "A monitor's disk is nearly full.",
    next: "Free space under the cluster's dataDirHostPath on the monitor's node.",
  },
  MON_DISK_CRIT: {
    meaning: "A monitor's disk is critically full; the monitor will stop when it runs out.",
    next: "Free space under the cluster's dataDirHostPath on the monitor's node now.",
  },
  MON_MSGR2_NOT_ENABLED: { meaning: "Some monitors do not listen on the newer msgr2 protocol." },
  // Managers
  MGR_DOWN: { meaning: "No manager is active: metrics, the dashboard and Rook's orchestration stop.", next: "Look at the rook-ceph-mgr pods." },
  MGR_MODULE_ERROR: { meaning: "A manager module failed.", next: TOOLBOX },
  MGR_MODULE_DEPENDENCY: { meaning: "A manager module cannot run because something it needs is missing." },
  // OSDs
  OSD_DOWN: {
    meaning: "One or more OSDs are down: their data is served by the other copies while they are.",
    next: "Look at the rook-ceph-osd pods and their nodes on the Daemons tab.",
  },
  OSD_HOST_DOWN: { meaning: "Every OSD of a host is down.", next: "Check that node and its disks." },
  OSD_ROOT_DOWN: { meaning: "Every OSD under a CRUSH root is down." },
  OSD_ORPHAN: { meaning: "An OSD is in the CRUSH map but does not exist." },
  OSD_OUT_OF_ORDER_FULL: { meaning: "The OSD fullness thresholds are not in ascending order." },
  OSD_NEARFULL: {
    meaning: "One or more OSDs are nearly full.",
    next: "Add capacity or delete data before they reach the full ratio, when writes stop.",
  },
  OSD_BACKFILLFULL: { meaning: "One or more OSDs are too full to take data moved to them by backfill." },
  OSD_FULL: {
    meaning: "One or more OSDs are full: Ceph stops writes to the pools on them.",
    next: "Add capacity or delete data at once.",
  },
  OSD_FLAGS: { meaning: "OSD flags such as noout or noup are set on some OSDs, hosts or classes." },
  OSDMAP_FLAGS: { meaning: "Cluster-wide flags such as noout, norebalance or pause are set; they are often left over from maintenance." },
  OSD_UPGRADE_FINISHED: { meaning: "Every OSD runs the new release, but require-osd-release still names an old one." },
  OSD_FILESTORE: { meaning: "Some OSDs still use FileStore, which newer Ceph releases do not run." },
  OSD_SLOW_PING_TIME_FRONT: { meaning: "Network pings between OSDs on the public network are slow." },
  OSD_SLOW_PING_TIME_BACK: { meaning: "Network pings between OSDs on the cluster network are slow." },
  OSD_TOO_MANY_REPAIRS: { meaning: "An OSD repaired more read errors than Ceph allows: its disk may be failing." },
  TOO_FEW_OSDS: { meaning: "The cluster has fewer OSDs than the pools' replica size needs." },
  BLUESTORE_SLOW_OP_ALERT: { meaning: "BlueStore on some OSDs reports slow operations: a disk may be slow or failing." },
  BLUESTORE_SPURIOUS_READ_ERRORS: { meaning: "Some OSDs saw read errors that went away on retry: a disk may be failing." },
  BLUESTORE_NO_PER_POOL_OMAP: { meaning: "Some OSDs were created before per-pool omap accounting." },
  BLUEFS_SPILLOVER: { meaning: "The OSD's metadata no longer fits on its fast device and spills onto the slow one." },
  BLUEFS_LOW_SPACE: { meaning: "The OSD's metadata device is running out of space." },
  DEVICE_HEALTH: { meaning: "A disk is expected to fail soon, by its SMART data.", next: "Plan to replace the disk." },
  DEVICE_HEALTH_IN_USE: { meaning: "A disk expected to fail soon still holds data." },
  // Placement groups and data
  PG_AVAILABILITY: {
    meaning: "Some placement groups are inactive: reads and writes to the data in them block.",
    next: "Usually OSDs are down; look at OSD_DOWN first.",
  },
  PG_DEGRADED: {
    meaning: "Some data has fewer copies than its pool asks for; Ceph recovers it when it can.",
    next: "Usually OSDs are down or recovering.",
  },
  PG_RECOVERY_FULL: { meaning: "Data cannot recover because OSDs are full." },
  PG_BACKFILL_FULL: { meaning: "Data cannot move because OSDs are too full for backfill." },
  PG_DAMAGED: { meaning: "Scrubbing found inconsistent data in some placement groups.", next: TOOLBOX },
  OSD_SCRUB_ERRORS: { meaning: "Scrubbing found errors.", next: TOOLBOX },
  OBJECT_UNFOUND: { meaning: "Ceph knows objects exist but finds no copy of them.", next: TOOLBOX },
  OBJECT_MISPLACED: { meaning: "Some objects are not where CRUSH places them yet; Ceph is moving them." },
  PG_NOT_SCRUBBED: { meaning: "Some placement groups were not scrubbed in time." },
  PG_NOT_DEEP_SCRUBBED: { meaning: "Some placement groups were not deep-scrubbed in time." },
  PG_SLOW_SNAP_TRIMMING: { meaning: "Removing snapshots is falling behind." },
  RECENT_CRASH: {
    meaning: "Ceph daemons crashed recently; the crashes stay listed until someone archives them.",
    next: "In the toolbox, `ceph crash ls` lists them.",
  },
  SLOW_OPS: { meaning: "Some requests to OSDs or monitors are taking long.", next: TOOLBOX },
  // Pools
  POOL_FULL: { meaning: "A pool reached its quota: writes to it stop." },
  POOL_NEAR_FULL: { meaning: "A pool is near its quota." },
  POOL_NO_REDUNDANCY: { meaning: "A pool keeps a single copy of its data: losing one OSD loses data." },
  POOL_APP_NOT_ENABLED: { meaning: "A pool has no application (rbd, cephfs, rgw) set." },
  POOL_TOO_FEW_PGS: { meaning: "A pool has fewer placement groups than its data needs." },
  POOL_TOO_MANY_PGS: { meaning: "A pool has more placement groups than its data needs." },
  TOO_MANY_PGS: { meaning: "The OSDs hold more placement groups each than Ceph allows." },
  POOL_TARGET_SIZE_BYTES_OVERCOMMITTED: { meaning: "The pools' target sizes add up to more than the cluster holds." },
  // CephFS
  FS_DEGRADED: { meaning: "A filesystem is degraded: one of its ranks is not active.", next: "Look at the rook-ceph-mds pods." },
  FS_WITH_FAILED_MDS: { meaning: "A filesystem has a failed metadata server rank." },
  MDS_ALL_DOWN: { meaning: "No metadata server of a filesystem is up: the filesystem cannot be used.", next: "Look at the rook-ceph-mds pods." },
  MDS_INSUFFICIENT_STANDBY: { meaning: "Fewer standby metadata servers are available than the filesystem asks for." },
  MDS_SLOW_REQUEST: { meaning: "Some metadata requests are taking long." },
  MDS_SLOW_METADATA_IO: { meaning: "A metadata server waits long for its own metadata reads and writes." },
  MDS_CLIENT_LATE_RELEASE: { meaning: "Clients do not release capabilities the metadata server asked back." },
  MDS_CLIENT_RECALL: { meaning: "Clients do not release cached inodes the metadata server asked back." },
  MDS_TRIM: { meaning: "A metadata server's journal is falling behind." },
  MDS_CACHE_OVERSIZED: { meaning: "A metadata server's cache is over its memory limit." },
  MDS_DAMAGE: { meaning: "A metadata server found damaged metadata.", next: TOOLBOX },
  // Security
  AUTH_INSECURE_GLOBAL_ID_RECLAIM: { meaning: "Clients reconnect in a way that has a known security problem." },
  AUTH_INSECURE_GLOBAL_ID_RECLAIM_ALLOWED: { meaning: "Ceph still lets clients reconnect in a way that has a known security problem." },
  AUTH_BAD_CAPS: { meaning: "Some keys have capabilities Ceph cannot parse." },
};

/** The plain words of a code, or `null` when it is not one listed here. */
export function wordsOf(code: string): CheckWords | null {
  return Object.hasOwn(CHECK_WORDS, code) ? CHECK_WORDS[code]! : null;
}
