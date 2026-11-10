// Registers the storage insights (#152): the Usage column of the PVC table, the usage sections of claims and pods,
// the discovered sidebar section VolumeSnapshots (VolumeSnapshot, VolumeSnapshotClass, VolumeSnapshotContent) — shown
// only while the cluster serves its kinds — its details, and the two actions that create objects (each through a form
// and a confirmation listing the object). Velero is Sextant's own extension `extensions/velero` (ADR-0162 amendment).
import type { KindRef, KubeObject } from "../../api";
import { useAppStore } from "../../app/store";
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { extendColumns, findKind, registerResource, status, type ColumnDef, type SidebarSection } from "../../resources";
import { extendActions } from "../../resources/registry";
import { knownClusterKinds } from "../../resources/useKinds";
import { registerAction } from "../actions/registry";
import { snapshotClassColumns, snapshotColumns, snapshotContentColumns, snapshotProblem } from "./columns";
import { SnapshotSection } from "./details";
import { isKind, POD, PVC, readyToUse, VOLUME_SNAPSHOT, VOLUME_SNAPSHOT_CLASS, VOLUME_SNAPSHOT_CONTENT } from "./model";
import { RestoreClaimDialog, SnapshotDialog } from "./SnapshotDialogs";
import { ClaimUsageSection, PodVolumeUsageSection, usageColumn } from "./UsageViews";

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
  actions: readonly "snapshotRestore"[];
}

export const TOOL_KINDS: ToolKind[] = [
  { kind: VOLUME_SNAPSHOT, section: "volumeSnapshots", order: 10, label: "volumeSnapshots", icon: "volumeSnapshot", columns: snapshotColumns, namespaced: true, problem: snapshotProblem, actions: ["snapshotRestore"] },
  { kind: VOLUME_SNAPSHOT_CLASS, section: "volumeSnapshots", order: 20, label: "volumeSnapshotClasses", icon: "volumeSnapshotClass", columns: snapshotClassColumns, namespaced: false, actions: [] },
  { kind: VOLUME_SNAPSHOT_CONTENT, section: "volumeSnapshots", order: 30, label: "volumeSnapshotContents", icon: "volumeSnapshotContent", columns: snapshotContentColumns, namespaced: false, problem: snapshotProblem, actions: [] },
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

// The snapshot kinds: their state in plain words, after the fields.
registerDetailsSection({
  id: "storageSnapshot",
  order: 21,
  appliesTo: (kind) => isKind(kind, VOLUME_SNAPSHOT, VOLUME_SNAPSHOT_CONTENT),
  Component: SnapshotSection,
});

/** Whether the open cluster serves `kind` (as discovery knows it now). */
export function served(kind: Pick<KindRef, "group" | "kind">): boolean {
  return findKind(knownClusterKinds(useAppStore.getState().activeClusterId), kind) !== undefined;
}

const phase = (obj: KubeObject) => status.str(status.get(obj, "status", "phase"));

extendActions({ group: "", kind: "PersistentVolumeClaim" }, ["snapshotCreate"]);

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
