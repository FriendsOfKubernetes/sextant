// Columns of the Knative tables: every kind's state in words (ready / progressing / failed, colored) with the reason
// of the failing condition; Services and Configurations show their latest created and ready revisions, Routes the
// traffic split, Revisions their replicas.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import { failingCondition, HEALTH_TONE, healthOf, mappingRef, revisionFields, serviceFields, trafficSummary } from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `knative:columns.${id}`,
  value,
  ...options,
});

function Health({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const health = healthOf(obj);
  return <StatusText value={t(`knative:health.${health}`)} tone={HEALTH_TONE[health]} />;
}

function Traffic({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const text = trafficSummary(obj, t("knative:latest"));
  return text ? <span title={text}>{text}</span> : null;
}

const statusColumn = col("status", healthOf, { width: "110px", render: (o) => <Health obj={o} /> });
const reasonColumn = col("reason", (o) => failingCondition(o)?.reason, { width: "minmax(100px, 1fr)" });
const urlColumn = col("url", (o) => serviceFields(o).url, {
  width: "minmax(160px, 2fr)",
  render: (o) => {
    const url = serviceFields(o).url;
    return url ? <span title={url}>{url}</span> : null;
  },
});
const latestCreatedColumn = col("latestCreated", (o) => serviceFields(o).latestCreated, { width: "minmax(120px, 1fr)" });
const latestReadyColumn = col("latestReady", (o) => serviceFields(o).latestReady, { width: "minmax(120px, 1fr)" });
const trafficColumn = col("traffic", (o) => trafficSummary(o, ""), { width: "minmax(160px, 2fr)", render: (o) => <Traffic obj={o} /> });

export const serviceColumns: ColumnDef[] = [nameColumn, namespaceColumn, statusColumn, urlColumn, latestCreatedColumn, latestReadyColumn, reasonColumn, ageColumn];

export const configurationColumns: ColumnDef[] = [nameColumn, namespaceColumn, statusColumn, latestCreatedColumn, latestReadyColumn, reasonColumn, ageColumn];

const replicas = (o: KubeObject) => {
  const f = revisionFields(o);
  return f.actualReplicas === undefined ? undefined : `${f.actualReplicas}/${f.desiredReplicas ?? "?"}`;
};

export const revisionColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  statusColumn,
  col("configuration", (o) => revisionFields(o).configuration, { width: "minmax(120px, 1fr)" }),
  col("generation", (o) => Number(revisionFields(o).generation ?? NaN) || undefined, { width: "90px" }),
  col("replicas", replicas, { width: "90px" }),
  reasonColumn,
  ageColumn,
];

export const routeColumns: ColumnDef[] = [nameColumn, namespaceColumn, statusColumn, urlColumn, trafficColumn, reasonColumn, ageColumn];

export const domainMappingColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  statusColumn,
  urlColumn,
  col("target", (o) => mappingRef(o).name, { width: "minmax(120px, 1fr)" }),
  reasonColumn,
  ageColumn,
];
