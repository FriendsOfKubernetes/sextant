// Columns of the Kueue tables: a queue's state (active / stopped / inactive) with its condition's message as the
// tooltip and its pending, reserving and admitted Workloads; a Workload's state (pending / admitted / evicted / …) with
// the reason Kueue wrote as the tooltip, its queues and its owner job; flavors, cohorts, admission checks and
// priority classes by their main fields.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import {
  clusterQueueOf,
  cohortOf,
  conditionOf,
  ownerOf,
  parentCohortOf,
  queueCounts,
  queueState,
  QUEUE_TONE,
  workloadInfo,
  WORKLOAD_TONE,
} from "./model";

const { get, num, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `kueue:columns.${id}`,
  value,
  ...options,
});

export function QueueStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = queueState(obj);
  const active = conditionOf(obj, "Active");
  return (
    <span title={[active?.reason, active?.message].filter(Boolean).join(": ") || undefined}>
      <StatusText value={t(`kueue:queueState.${state}`)} tone={QUEUE_TONE[state]} />
    </span>
  );
}

export function WorkloadStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const info = workloadInfo(obj);
  return (
    <span title={[info.why?.reason, info.why?.message].filter(Boolean).join(": ") || undefined}>
      <StatusText value={t(`kueue:workloadState.${info.state}`)} tone={WORKLOAD_TONE[info.state]} />
    </span>
  );
}

const counts = (field: "pending" | "reserving" | "admitted") =>
  col(field, (o) => queueCounts(o)[field], { width: "90px" });

const queueStatus = col("status", queueState, { width: "110px", render: (o) => <QueueStateText obj={o} /> });

export const clusterQueueColumns: ColumnDef[] = [
  nameColumn,
  queueStatus,
  col("cohort", cohortOf, { width: "minmax(120px, 1fr)" }),
  counts("pending"),
  counts("reserving"),
  counts("admitted"),
  col("strategy", (o) => str(get(o, "spec", "queueingStrategy")) ?? "BestEffortFIFO", { width: "130px" }),
  ageColumn,
];

export const localQueueColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  queueStatus,
  col("clusterQueue", clusterQueueOf, { width: "minmax(120px, 1fr)" }),
  counts("pending"),
  counts("reserving"),
  counts("admitted"),
  ageColumn,
];

const ownerText = (o: KubeObject) => {
  const owner = ownerOf(o);
  return owner ? `${owner.kind}/${owner.name}` : undefined;
};

export const workloadColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", (o) => workloadInfo(o).state, { width: "120px", render: (o) => <WorkloadStateText obj={o} /> }),
  col("queue", (o) => workloadInfo(o).queue, { width: "minmax(100px, 1fr)" }),
  col("clusterQueue", (o) => workloadInfo(o).clusterQueue, { width: "minmax(100px, 1fr)" }),
  col("owner", ownerText, { width: "minmax(140px, 1.5fr)" }),
  col("priority", (o) => workloadInfo(o).priority, { width: "80px" }),
  col("evictions", (o) => workloadInfo(o).evictions, { width: "90px" }),
  ageColumn,
];

export const resourceFlavorColumns: ColumnDef[] = [
  nameColumn,
  col(
    "nodeLabels",
    (o) =>
      Object.entries((get(o, "spec", "nodeLabels") as Record<string, unknown> | undefined) ?? {})
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(", ") || undefined,
    { width: "minmax(160px, 2fr)" },
  ),
  col("topology", (o) => str(get(o, "spec", "topologyName")), { width: "120px" }),
  ageColumn,
];

export const cohortColumns: ColumnDef[] = [nameColumn, col("parent", parentCohortOf, { width: "minmax(120px, 1fr)" }), ageColumn];

export const admissionCheckColumns: ColumnDef[] = [
  nameColumn,
  queueStatus,
  col("controller", (o) => str(get(o, "spec", "controllerName")), { width: "minmax(160px, 2fr)" }),
  ageColumn,
];

export const priorityClassColumns: ColumnDef[] = [
  nameColumn,
  col("value", (o) => num(get(o, "value")), { width: "90px" }),
  col("description", (o) => str(get(o, "description")), { width: "minmax(160px, 2fr)" }),
  ageColumn,
];
