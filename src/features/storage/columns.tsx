// Columns of the VolumeSnapshot and Velero tables (#152): for snapshots the source claim, class, restore size and the
// state in one word; for Velero the namespaces, phase, error and warning counts, schedule and storage location.
import type { KubeObject } from "../../api";
import { Age } from "../../components";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import { formatList } from "../../i18n";
import {
  errorCount,
  includedNamespaces,
  isDefaultSnapshotClass,
  phaseOf,
  phaseTone,
  restoreSizeOf,
  snapshotClassOf,
  snapshotSourceClaim,
  snapshotState,
  warningCount,
} from "./model";

const { get, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `storage:columns.${id}`,
  value,
  ...options,
});

const stateColumn = col("state", (o) => snapshotState(o).word, {
  width: "90px",
  render: (o) => {
    const { word, tone } = snapshotState(o);
    return <StatusText value={word} tone={tone} />;
  },
});

const phaseColumn = col("phase", phaseOf, {
  width: "150px",
  render: (o) => {
    const phase = phaseOf(o);
    return phase ? <StatusText value={phase} tone={phaseTone(phase)} /> : null;
  },
});

const countColumn = (id: "errors" | "warnings", of: (o: KubeObject) => number) =>
  col(id, of, {
    width: "80px",
    render: (o) => {
      const n = of(o);
      return n > 0 ? <StatusText value={String(n)} tone={id === "errors" ? "danger" : "warning"} /> : <span>{n}</span>;
    },
  });

const timeColumn = (id: string, path: string[]) =>
  col(id, (o) => str(get(o, ...path)), {
    width: "90px",
    render: (o, ctx) => <Age timestamp={str(get(o, ...path))} now={ctx.now} />,
  });

const driverColumn = col("driver", (o) => str(get(o, "driver")) ?? str(get(o, "spec", "driver")), { width: "minmax(140px, 1.5fr)" });
const deletionPolicyColumn = col("deletionPolicy", (o) => str(get(o, "deletionPolicy")) ?? str(get(o, "spec", "deletionPolicy")), {
  width: "110px",
});
const restoreSizeColumn = col("restoreSize", restoreSizeOf, { width: "100px" });
const namespacesColumn = col("namespaces", (o) => formatList(includedNamespaces(o)) || "*", { width: "minmax(120px, 1.5fr)" });

export const snapshotColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("source", snapshotSourceClaim, { width: "minmax(120px, 1.5fr)" }),
  col("snapshotClass", snapshotClassOf, { width: "minmax(120px, 1fr)" }),
  restoreSizeColumn,
  stateColumn,
  ageColumn,
];

export const snapshotClassColumns: ColumnDef[] = [
  nameColumn,
  driverColumn,
  deletionPolicyColumn,
  col("default", (o) => (isDefaultSnapshotClass(o) ? "true" : ""), { width: "80px" }),
  ageColumn,
];

export const snapshotContentColumns: ColumnDef[] = [
  nameColumn,
  col(
    "snapshot",
    (o) => {
      const ns = str(get(o, "spec", "volumeSnapshotRef", "namespace"));
      const name = str(get(o, "spec", "volumeSnapshotRef", "name"));
      return name ? `${ns ? `${ns}/` : ""}${name}` : undefined;
    },
    { width: "minmax(140px, 1.5fr)" },
  ),
  driverColumn,
  deletionPolicyColumn,
  restoreSizeColumn,
  stateColumn,
  ageColumn,
];

export const backupColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  namespacesColumn,
  phaseColumn,
  countColumn("errors", errorCount),
  countColumn("warnings", warningCount),
  timeColumn("completed", ["status", "completionTimestamp"]),
  ageColumn,
];

export const scheduleColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("schedule", (o) => str(get(o, "spec", "schedule")), { width: "120px" }),
  namespacesColumn,
  col("paused", (o) => (get(o, "spec", "paused") === true ? "true" : ""), { width: "70px" }),
  phaseColumn,
  timeColumn("lastBackup", ["status", "lastBackup"]),
  ageColumn,
];

export const restoreColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("backup", (o) => str(get(o, "spec", "backupName")) ?? str(get(o, "spec", "scheduleName")), { width: "minmax(140px, 1.5fr)" }),
  phaseColumn,
  countColumn("errors", errorCount),
  countColumn("warnings", warningCount),
  ageColumn,
];

export const locationColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("provider", (o) => str(get(o, "spec", "provider")), { width: "100px" }),
  col("bucket", (o) => str(get(o, "spec", "objectStorage", "bucket")), { width: "minmax(120px, 1fr)" }),
  col("default", (o) => (get(o, "spec", "default") === true ? "true" : ""), { width: "80px" }),
  phaseColumn,
  timeColumn("lastValidated", ["status", "lastValidationTime"]),
  ageColumn,
];

export const snapshotLocationColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("provider", (o) => str(get(o, "spec", "provider")), { width: "120px" }),
  phaseColumn,
  ageColumn,
];

/** A snapshot the snapshotter reported an error for ("Only problems"). */
export const snapshotProblem = (o: KubeObject): boolean => snapshotState(o).word === "Failed";

