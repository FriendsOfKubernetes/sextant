// Columns of the Crossplane tables: an XRD's composite and claim kinds with Established / Offered; a Composition's
// composite type and mode; a package's source, Installed and Healthy, and its state in words.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, StatusText, type ColumnDef } from "../../resources";
import { compositionFields, conditionStatus, conditionTone, HEALTH_TONE, packageFields, packageHealth, parseXrd } from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `crossplane:columns.${id}`,
  value,
  ...options,
});

const conditionColumn = (id: string, type: string) =>
  col(id, (o) => conditionStatus(o, type), {
    width: "100px",
    render: (o) => {
      const value = conditionStatus(o, type);
      return value ? <StatusText value={value} tone={conditionTone(value)} /> : null;
    },
  });

function PackageState({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const health = packageHealth(obj);
  return <StatusText value={t(`crossplane:health.${health}`)} tone={HEALTH_TONE[health]} />;
}

export const xrdColumns: ColumnDef[] = [
  nameColumn,
  col("composite", (o) => parseXrd(o)?.composite.kind, { width: "minmax(120px, 1fr)" }),
  col("claim", (o) => parseXrd(o)?.claim?.kind, { width: "minmax(120px, 1fr)" }),
  conditionColumn("established", "Established"),
  conditionColumn("offered", "Offered"),
  ageColumn,
];

export const compositionColumns: ColumnDef[] = [
  nameColumn,
  col("compositeType", (o) => compositionFields(o).compositeType, { width: "minmax(180px, 2fr)" }),
  col("mode", (o) => compositionFields(o).mode, { width: "100px" }),
  ageColumn,
];

export const packageColumns: ColumnDef[] = [
  nameColumn,
  col("status", packageHealth, { width: "110px", render: (o) => <PackageState obj={o} /> }),
  col("package", (o) => packageFields(o).package, {
    width: "minmax(200px, 3fr)",
    render: (o) => {
      const text = packageFields(o).package;
      return text ? <span title={text}>{text}</span> : null;
    },
  }),
  conditionColumn("installed", "Installed"),
  conditionColumn("healthy", "Healthy"),
  ageColumn,
];
