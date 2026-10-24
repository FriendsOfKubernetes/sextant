// Registers the storage insights (#152): the Usage column of the PVC table, the usage sections of claims and pods,
// the discovered sidebar sections VolumeSnapshots (VolumeSnapshot, VolumeSnapshotClass, VolumeSnapshotContent) and
// Velero (Backup, Schedule, Restore, BackupStorageLocation, VolumeSnapshotLocation) — shown only while the cluster
// serves their kinds — their details, and the four actions that create objects (each through a form and a
// confirmation listing the object).
import type { KindRef, KubeObject } from "../../api";
import { useAppStore } from "../../app/store";
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { extendColumns, findKind, registerResource, status, type ColumnDef, type SidebarSection } from "../../resources";
import { extendActions } from "../../resources/registry";
import { knownClusterKinds } from "../../resources/useKinds";
import { registerAction } from "../actions/registry";
import {
  backupColumns,
  locationColumns,
  restoreColumns,
  scheduleColumns,
  snapshotClassColumns,
  snapshotColumns,
  snapshotContentColumns,
  snapshotLocationColumns,
  snapshotProblem,
} from "./columns";
import { SnapshotSection, VeleroSection } from "./details";
import {
  BACKUP,
  BACKUP_STORAGE_LOCATION,
  hasVeleroProblem,
  isKind,
  NAMESPACE,
  POD,
  PVC,
  readyToUse,
  RESTORE,
  SCHEDULE,
  VOLUME_SNAPSHOT,
  VOLUME_SNAPSHOT_CLASS,
  VOLUME_SNAPSHOT_CONTENT,
  VOLUME_SNAPSHOT_LOCATION,
} from "./model";
import { RestoreClaimDialog, SnapshotDialog } from "./SnapshotDialogs";
import { ClaimUsageSection, PodVolumeUsageSection, usageColumn } from "./UsageViews";
import { VeleroBackupDialog, VeleroRestoreDialog } from "./VeleroDialogs";

interface ToolKind {
  kind: KindRef;
  section: SidebarSection;
  order: number;
  /** Key under `storage:sidebar`. */
  label: string;
  icon: IconName;
  columns: ColumnDef[];
  namespaced: boolean;
  problem?: (obj: KubeObject) => boolean;
  actions: readonly ("snapshotRestore" | "veleroRestore")[];
}

export const TOOL_KINDS: ToolKind[] = [
  { kind: VOLUME_SNAPSHOT, section: "volumeSnapshots", order: 10, label: "volumeSnapshots", icon: "volumeSnapshot", columns: snapshotColumns, namespaced: true, problem: snapshotProblem, actions: ["snapshotRestore"] },
  { kind: VOLUME_SNAPSHOT_CLASS, section: "volumeSnapshots", order: 20, label: "volumeSnapshotClasses", icon: "volumeSnapshotClass", columns: snapshotClassColumns, namespaced: false, actions: [] },
  { kind: VOLUME_SNAPSHOT_CONTENT, section: "volumeSnapshots", order: 30, label: "volumeSnapshotContents", icon: "volumeSnapshotContent", columns: snapshotContentColumns, namespaced: false, problem: snapshotProblem, actions: [] },
  { kind: BACKUP, section: "velero", order: 10, label: "backups", icon: "veleroBackup", columns: backupColumns, namespaced: true, problem: hasVeleroProblem, actions: ["veleroRestore"] },
  { kind: SCHEDULE, section: "velero", order: 20, label: "schedules", icon: "veleroSchedule", columns: scheduleColumns, namespaced: true, problem: hasVeleroProblem, actions: [] },
  { kind: RESTORE, section: "velero", order: 30, label: "restores", icon: "veleroRestore", columns: restoreColumns, namespaced: true, problem: hasVeleroProblem, actions: [] },
  { kind: BACKUP_STORAGE_LOCATION, section: "velero", order: 40, label: "backupStorageLocations", icon: "veleroLocation", columns: locationColumns, namespaced: true, problem: hasVeleroProblem, actions: [] },
  { kind: VOLUME_SNAPSHOT_LOCATION, section: "velero", order: 50, label: "volumeSnapshotLocations", icon: "veleroLocation", columns: snapshotLocationColumns, namespaced: true, problem: hasVeleroProblem, actions: [] },
];

for (const def of TOOL_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: def.section, order: def.order, labelKey: `storage:sidebar.${def.label}`, icon: def.icon },
    columns: def.columns,
    actions: [...def.actions, "edit", "delete"],
    namespaced: def.namespaced,
    ...(def.problem ? { problem: def.problem } : {}),
  });
}

// Usage of claims: a column of the PVC table, a section of a claim's and a pod's details (after the fields, 20).
extendColumns({ group: "", kind: "PersistentVolumeClaim" }, [usageColumn]);
registerDetailsSection({ id: "storageClaimUsage", order: 22, appliesTo: (kind) => isKind(kind, PVC), Component: ClaimUsageSection });
registerDetailsSection({ id: "storagePodVolumes", order: 23, appliesTo: (kind) => isKind(kind, POD), Component: PodVolumeUsageSection });

// The tools' kinds: their state in plain words, after the fields.
registerDetailsSection({
  id: "storageSnapshot",
  order: 21,
  appliesTo: (kind) => isKind(kind, VOLUME_SNAPSHOT, VOLUME_SNAPSHOT_CONTENT),
  Component: SnapshotSection,
});
registerDetailsSection({
  id: "storageVelero",
  order: 21,
  appliesTo: (kind) => isKind(kind, BACKUP, SCHEDULE, RESTORE, BACKUP_STORAGE_LOCATION, VOLUME_SNAPSHOT_LOCATION),
  Component: VeleroSection,
});

/** Whether the open cluster serves `kind` (as discovery knows it now). */
export function served(kind: Pick<KindRef, "group" | "kind">): boolean {
  return findKind(knownClusterKinds(useAppStore.getState().activeClusterId), kind) !== undefined;
}

const phase = (obj: KubeObject) => status.str(status.get(obj, "status", "phase"));

extendActions({ group: "", kind: "PersistentVolumeClaim" }, ["snapshotCreate"]);
extendActions({ group: "", kind: "Namespace" }, ["veleroBackup"]);

registerAction("snapshotCreate", {
  placement: "more",
  labelKey: "storage:snapshot.create",
  icon: "volumeSnapshot",
  // A claim that is bound, in a cluster with the snapshot API.
  appliesTo: (obj, kind) => isKind(kind, PVC) && phase(obj) === "Bound" && served(VOLUME_SNAPSHOT),
  run: ({ clusterId, objects, openDialog }) => {
    const claim = objects[0];
    if (claim) openDialog((close) => <SnapshotDialog clusterId={clusterId} claim={claim} close={close} />);
  },
});

registerAction("snapshotRestore", {
  placement: "more",
  labelKey: "storage:restore.action",
  icon: "restoreSnapshot",
  appliesTo: (obj, kind) => isKind(kind, VOLUME_SNAPSHOT) && readyToUse(obj),
  run: ({ clusterId, objects, openDialog }) => {
    const snapshot = objects[0];
    if (snapshot) openDialog((close) => <RestoreClaimDialog clusterId={clusterId} snapshot={snapshot} close={close} />);
  },
});

registerAction("veleroBackup", {
  placement: "more",
  labelKey: "storage:velero.backupAction",
  icon: "veleroBackup",
  appliesTo: (obj, kind) => isKind(kind, NAMESPACE) && phase(obj) !== "Terminating" && served(BACKUP),
  run: ({ clusterId, refs, openDialog }) => {
    const ns = refs[0]?.name;
    if (ns) openDialog((close) => <VeleroBackupDialog clusterId={clusterId} namespace={ns} close={close} />);
  },
});

registerAction("veleroRestore", {
  placement: "more",
  labelKey: "storage:velero.restoreAction",
  icon: "veleroRestore",
  appliesTo: (obj, kind) => isKind(kind, BACKUP) && status.get(obj, "status", "phase") !== "Deleting",
  run: ({ clusterId, objects, openDialog }) => {
    const backup = objects[0];
    if (backup) openDialog((close) => <VeleroRestoreDialog clusterId={clusterId} backup={backup} close={close} />);
  },
});
