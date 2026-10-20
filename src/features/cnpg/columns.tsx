// Columns of the CloudNativePG tables: a Cluster's state in words (healthy / switchover / failing over / progressing /
// unhealthy) with the operator's phase as its tooltip, ready instances of desired and the current primary; Backups
// their phase, Cluster and method; ScheduledBackups their schedule and next run; Poolers their Cluster and type.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { Age } from "../../components";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import { BACKUP_TONE, backupMethodOf, backupState, CLUSTER_TONE, clusterInfo, clusterNameOf } from "./model";

const { get, num, str } = status;

const errorOf = (o: KubeObject) => str(get(o, "status", "error"));
const startedAt = (o: KubeObject) => str(get(o, "status", "startedAt"));
const lastScheduled = (o: KubeObject) => str(get(o, "status", "lastScheduleTime"));

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `cnpg:columns.${id}`,
  value,
  ...options,
});

export function ClusterStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const info = clusterInfo(obj);
  return (
    <span title={[info.phase, info.phaseReason].filter(Boolean).join(": ") || undefined}>
      <StatusText value={t(`cnpg:state.${info.state}`)} tone={CLUSTER_TONE[info.state]} />
    </span>
  );
}

export function BackupStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = backupState(obj);
  return (
    <span title={errorOf(obj)}>
      <StatusText value={t(`cnpg:backupState.${state}`)} tone={BACKUP_TONE[state]} />
    </span>
  );
}

const clusterRef = col("cluster", clusterNameOf, {
  width: "minmax(120px, 1fr)",
});

export const clusterColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", (o) => clusterInfo(o).state, {
    width: "120px",
    render: (o) => <ClusterStateText obj={o} />,
  }),
  col(
    "instances",
    (o) => {
      const info = clusterInfo(o);
      return `${info.ready}/${info.instances}`;
    },
    { width: "90px" },
  ),
  col("primary", (o) => clusterInfo(o).currentPrimary, {
    width: "minmax(140px, 1.5fr)",
  }),
  col("phase", (o) => clusterInfo(o).phase, { width: "minmax(160px, 2fr)" }),
  ageColumn,
];

export const backupColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", backupState, {
    width: "110px",
    render: (o) => <BackupStateText obj={o} />,
  }),
  clusterRef,
  col("method", backupMethodOf, { width: "140px" }),
  col("started", startedAt, {
    width: "100px",
    render: (o, ctx) => <Age timestamp={startedAt(o)} now={ctx.now} />,
  }),
  ageColumn,
];

export const scheduledBackupColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  clusterRef,
  col("schedule", (o) => str(get(o, "spec", "schedule")), { width: "130px" }),
  col("suspended", (o) => (get(o, "spec", "suspend") === true ? "True" : "False"), { width: "100px" }),
  col("lastBackup", lastScheduled, {
    width: "110px",
    render: (o, ctx) => <Age timestamp={lastScheduled(o)} now={ctx.now} />,
  }),
  ageColumn,
];

export const poolerColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  clusterRef,
  col("type", (o) => str(get(o, "spec", "type")) ?? "rw", { width: "70px" }),
  col("instances", (o) => num(get(o, "spec", "instances")), { width: "90px" }),
  col("poolMode", (o) => str(get(o, "spec", "pgbouncer", "poolMode")), {
    width: "110px",
  }),
  ageColumn,
];
