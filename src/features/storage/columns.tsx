// Columns of the VolumeSnapshot tables (#152): the source claim, class, restore size and the state in one word.
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import { isDefaultSnapshotClass, restoreSizeOf, snapshotClassOf, snapshotSourceClaim, snapshotState } from "./model";

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

const driverColumn = col("driver", (o) => str(get(o, "driver")) ?? str(get(o, "spec", "driver")), { width: "minmax(140px, 1.5fr)" });
const deletionPolicyColumn = col("deletionPolicy", (o) => str(get(o, "deletionPolicy")) ?? str(get(o, "spec", "deletionPolicy")), {
  width: "110px",
});
const restoreSizeColumn = col("restoreSize", restoreSizeOf, { width: "100px" });

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

/** A snapshot the snapshotter reported an error for ("Only problems"). */
export const snapshotProblem = (o: KubeObject): boolean => snapshotState(o).word === "Failed";

