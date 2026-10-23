// Columns of the KubeRay tables: a RayCluster's state in words with the operator's reason as its tooltip, ready worker
// pods of desired, the head pod's IP and the Ray version; a RayJob's state, Ray's job status, KubeRay's deployment
// status and its RayCluster; a RayService's state, its Serve applications running of all and the active RayCluster.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { Age } from "../../components";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import {
  activeOf,
  CLUSTER_TONE,
  clusterReason,
  clusterState,
  deploymentStatusOf,
  headOf,
  JOB_TONE,
  jobState,
  jobStatusOf,
  SERVICE_TONE,
  serviceReason,
  serviceState,
  workersOf,
} from "./model";

const { get, num, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `kuberay:columns.${id}`,
  value,
  ...options,
});

export function ClusterStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = clusterState(obj);
  return (
    <span title={clusterReason(obj)}>
      <StatusText value={t(`kuberay:clusterState.${state}`)} tone={CLUSTER_TONE[state]} />
    </span>
  );
}

export function JobStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = jobState(obj);
  const message = str(get(obj, "status", "message"));
  return (
    <span title={message}>
      <StatusText value={t(`kuberay:jobState.${state}`)} tone={JOB_TONE[state]} />
    </span>
  );
}

export function ServiceStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = serviceState(obj);
  return (
    <span title={serviceReason(obj)}>
      <StatusText value={t(`kuberay:serviceState.${state}`)} tone={SERVICE_TONE[state]} />
    </span>
  );
}

const startedAt = (o: KubeObject) => str(get(o, "status", "startTime"));

export const clusterColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", clusterState, { width: "130px", render: (o) => <ClusterStateText obj={o} /> }),
  col(
    "workers",
    (o) => {
      const w = workersOf(o);
      return `${w.ready}/${w.desired}`;
    },
    { width: "90px" },
  ),
  col("headIP", (o) => headOf(o).podIP, { width: "minmax(110px, 1fr)" }),
  col("rayVersion", (o) => str(get(o, "spec", "rayVersion")), { width: "100px" }),
  ageColumn,
];

export const jobColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", jobState, { width: "110px", render: (o) => <JobStateText obj={o} /> }),
  col("jobStatus", jobStatusOf, { width: "110px" }),
  col("deploymentStatus", deploymentStatusOf, { width: "130px" }),
  col("cluster", (o) => str(get(o, "status", "rayClusterName")), { width: "minmax(140px, 1.5fr)" }),
  col("started", startedAt, { width: "100px", render: (o, ctx) => <Age timestamp={startedAt(o)} now={ctx.now} /> }),
  ageColumn,
];

export const serviceColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", serviceState, { width: "120px", render: (o) => <ServiceStateText obj={o} /> }),
  col(
    "applications",
    (o) => {
      const apps = activeOf(o).apps;
      return apps.length === 0 ? undefined : `${apps.filter((a) => a.status === "RUNNING").length}/${apps.length}`;
    },
    { width: "110px" },
  ),
  col("endpoints", (o) => num(get(o, "status", "numServeEndpoints")), { width: "90px" }),
  col("activeCluster", (o) => activeOf(o).rayClusterName, { width: "minmax(160px, 1.5fr)" }),
  ageColumn,
];
