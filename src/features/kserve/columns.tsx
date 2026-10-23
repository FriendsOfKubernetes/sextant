// Columns of the KServe tables: an InferenceService's state in words with the failing condition as its tooltip, its
// URL (without credentials or query), the predictor's model format and runtime, the deployment mode and the canary
// share; runtimes' model formats, protocols and flags; an InferenceGraph's readiness, URL and node count; a
// TrainedModel's readiness, InferenceService and framework.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, status, StatusText, type ColumnDef } from "../../resources";
import {
  canaryPercent,
  componentsOf,
  conditionOf,
  deploymentModeOf,
  recordedRuntimeOf,
  safeUri,
  SERVICE_TONE,
  serviceReason,
  serviceState,
} from "./model";
import { formatsOf, isDisabled, protocolsOf } from "./runtimes";

const { get, record, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `kserve:columns.${id}`,
  value,
  ...options,
});

export function ServiceStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = serviceState(obj);
  return (
    <span title={serviceReason(obj)}>
      <StatusText value={t(`kserve:state.${state}`)} tone={SERVICE_TONE[state]} />
    </span>
  );
}

/** Ready / Not ready / Unknown from a `Ready` condition (InferenceGraph, TrainedModel). */
export function ReadyText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ready = conditionOf(obj, "Ready");
  const value = ready?.status === "True" ? "ready" : ready?.status === "False" ? "notReady" : "progressing";
  return (
    <span title={ready?.status === "False" ? ready.message || ready.reason : undefined}>
      <StatusText value={t(`kserve:state.${value}`)} tone={SERVICE_TONE[value]} />
    </span>
  );
}

const readyValue = (o: KubeObject) => conditionOf(o, "Ready")?.status;
const urlOf = (o: KubeObject) => safeUri(str(get(o, "status", "url")))?.text;
const predictor = (o: KubeObject) => componentsOf(o).find((c) => c.name === "predictor");

export const serviceColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", serviceState, { width: "110px", render: (o) => <ServiceStateText obj={o} /> }),
  col("url", urlOf, { width: "minmax(180px, 2fr)" }),
  col(
    "modelFormat",
    (o) => {
      const f = predictor(o)?.format;
      return f ? [f.name, f.version].filter(Boolean).join(":") : undefined;
    },
    { width: "minmax(100px, 1fr)" },
  ),
  col("runtime", (o) => predictor(o)?.runtime ?? recordedRuntimeOf(o)?.name, { width: "minmax(120px, 1fr)" }),
  col("mode", (o) => deploymentModeOf(o)?.raw, { width: "110px" }),
  col("canary", (o) => canaryPercent(o), { width: "80px" }),
  ageColumn,
];

const runtimeColumns = (namespaced: boolean): ColumnDef[] => [
  nameColumn,
  ...(namespaced ? [namespaceColumn] : []),
  col("formats", (o) => formatsOf(o).map((f) => f.name).filter(Boolean).join(", "), { width: "minmax(160px, 2fr)" }),
  col("protocols", (o) => protocolsOf(o).join(", "), { width: "minmax(100px, 1fr)" }),
  col("disabled", (o) => (isDisabled(o) ? "True" : "False"), { width: "90px" }),
  col("multiModel", (o) => (get(o, "spec", "multiModel") === true ? "True" : "False"), { width: "100px" }),
  ageColumn,
];

export const servingRuntimeColumns = runtimeColumns(true);
export const clusterServingRuntimeColumns = runtimeColumns(false);

export const graphColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", readyValue, { width: "110px", render: (o) => <ReadyText obj={o} /> }),
  col("url", urlOf, { width: "minmax(180px, 2fr)" }),
  col("nodes", (o) => Object.keys(record(get(o, "spec", "nodes"))).length, { width: "80px" }),
  ageColumn,
];

export const trainedModelColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", readyValue, { width: "110px", render: (o) => <ReadyText obj={o} /> }),
  col("inferenceService", (o) => str(get(o, "spec", "inferenceService")), { width: "minmax(140px, 1.5fr)" }),
  col("framework", (o) => str(get(o, "spec", "model", "framework")), { width: "110px" }),
  ageColumn,
];
