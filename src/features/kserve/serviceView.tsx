// An InferenceService's details: its state and why (the failing condition or the model's last failure), URL and
// address, the deployment mode, each component (predictor, transformer, explainer) with its model format, runtime,
// storage URI (never with credentials or a query), replicas, revisions, traffic split and what KServe made for it
// (Knative Service, Deployment, Service), the model status, and the runtime KServe chooses for the predictor.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { status } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { ServiceStateText } from "./columns";
import { useUnderlying, type Listed } from "./hooks";
import {
  COMPONENT_LABEL,
  componentStatusOf,
  componentsOf,
  deploymentModeOf,
  modelFailed,
  modelStatusOf,
  recordedRuntimeOf,
  serviceReason,
  serviceState,
  type ComponentSpec,
} from "./model";
import { date, DEPLOYMENT_TYPE, KSVC_TYPE, LABELS, Muted, Note, REVISION_TYPE, runtimeType, uri } from "./parts";
import { RuntimeChoice } from "./runtimeChoice";

const { get, record, str } = status;

const TRAFFIC_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap"];

/** Several links in a wrapping row; `null` when there are none. */
const links = (nodes: ReactNode[]): ReactNode => (nodes.length > 0 ? <span className="dt-links">{nodes}</span> : null);

const ofComponent = (list: Listed, name: string): KubeObject[] =>
  list.items.filter((o) => str(record(o.metadata?.labels)[COMPONENT_LABEL]) === name);

function ComponentBlock({ obj, spec, made }: { obj: KubeObject; spec: ComponentSpec; made: ReturnType<typeof useUnderlying> }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const s = componentStatusOf(obj, spec.name);
  const rows: FieldRow[] = [
    ["modelFormat", spec.format ? [spec.format.name, spec.format.version].filter(Boolean).join(":") : null],
    ["runtime", spec.runtime],
    ["storageUri", uri(spec.storageUri)],
    ["protocolVersion", spec.protocolVersion],
    ["images", chips(spec.images)],
    [
      "replicas",
      spec.maxReplicas
        ? t("kserve:bounds", { min: spec.minReplicas ?? 1, max: spec.maxReplicas })
        : spec.minReplicas !== undefined
          ? String(spec.minReplicas)
          : null,
    ],
    ["canaryTrafficPercent", spec.canaryTrafficPercent === undefined ? null : t("kserve:percent", { value: spec.canaryTrafficPercent })],
    ["workers", spec.workers ? t("kserve:yes") : null],
    ["componentUrl", uri(s?.url)],
    ["latestReadyRevision", link(REVISION_TYPE, s?.latestReadyRevision, ns)],
    ["latestCreatedRevision", s?.latestCreatedRevision !== s?.latestReadyRevision ? link(REVISION_TYPE, s?.latestCreatedRevision, ns) : null],
    ["previousRolledoutRevision", s?.previousRolledoutRevision],
    ["knativeService", links(ofComponent(made.knative, spec.name).map((o) => link(KSVC_TYPE, o.metadata?.name, ns)))],
    ["deployment", links(ofComponent(made.deployments, spec.name).map((o) => link(DEPLOYMENT_TYPE, o.metadata?.name, ns)))],
    ["service", links(ofComponent(made.services, spec.name).map((o) => link(KINDS.service, o.metadata?.name, ns)))],
  ];
  const traffic = (s?.traffic ?? []).map((tr) => [
    link(REVISION_TYPE, tr.revision, ns) ?? "",
    tr.percent === undefined ? "" : t("kserve:percent", { value: tr.percent }),
    tr.tag ?? "",
    tr.latest ? t("kserve:yes") : t("kserve:no"),
  ]);
  const trafficTable = table(
    "kserveTraffic",
    [t("kserve:traffic.revision"), t("kserve:traffic.percent"), t("kserve:traffic.tag"), t("kserve:traffic.latest")],
    traffic,
    TRAFFIC_WRAP,
  );
  return (
    <Block title={t(`kserve:component.${spec.name}`)}>
      <Fields rows={rows} labelPrefix={LABELS} />
      {trafficTable}
    </Block>
  );
}

function ModelStatusBlock({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const m = modelStatusOf(obj);
  if (!m.transitionStatus && !m.activeModelState && !m.targetModelState && !m.failure) return null;
  const rows: FieldRow[] = [
    ["transitionStatus", m.transitionStatus],
    ["activeModelState", m.activeModelState],
    ["targetModelState", m.targetModelState],
    ["failureReason", m.failure?.reason],
    ["failureLocation", m.failure?.location],
    ["failureTime", date(m.failure?.time)],
    ["exitCode", m.failure?.exitCode?.toString()],
    ["copies", m.copies?.total !== undefined ? t("kserve:copies", { failed: m.copies.failed ?? 0, total: m.copies.total }) : null],
  ];
  return (
    <Block title={t("kserve:modelStatus")}>
      <Fields rows={rows} labelPrefix={LABELS} />
      {m.failure?.message && <Note text={m.failure.message} tone={modelFailed(m) ? "danger" : "warning"} />}
    </Block>
  );
}

export function ServiceView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const state = serviceState(obj);
  const reason = serviceReason(obj);
  const mode = deploymentModeOf(obj);
  const recorded = recordedRuntimeOf(obj);
  const made = useUnderlying(clusterId, ns, obj.metadata?.name);
  const components = componentsOf(obj);
  const predictor = components.find((c) => c.name === "predictor");
  const rows: FieldRow[] = [
    ["status", <ServiceStateText key="s" obj={obj} />],
    ["url", uri(str(get(obj, "status", "url")))],
    ["address", uri(str(get(obj, "status", "address", "url")))],
    ["deploymentMode", mode ? t(`kserve:mode.${mode.mode}`, { value: mode.raw }) : t("kserve:mode.default")],
    ["recordedRuntime", recorded ? link(runtimeType(recorded), recorded.name, recorded.cluster ? null : ns) : null],
  ];
  return (
    <>
      {(state === "failed" || state === "notReady") && reason && <Note text={reason} tone={state === "failed" ? "danger" : "warning"} />}
      {state === "stopped" && <Muted text={t("kserve:stoppedNote")} />}
      <Fields rows={rows} labelPrefix={LABELS} />
      {components.map((c) => (
        <ComponentBlock key={c.name} obj={obj} spec={c} made={made} />
      ))}
      <ModelStatusBlock obj={obj} />
      {predictor && <RuntimeChoice clusterId={clusterId} obj={obj} predictor={predictor} modelMesh={mode?.mode === "modelMesh"} />}
    </>
  );
}
