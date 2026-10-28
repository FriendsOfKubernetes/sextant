// A RayJob's details: its state, Ray's job status and KubeRay's deployment status, why it failed (`reason`,
// `message`), the entrypoint as text with secret-looking flags and variables masked (mask.ts), its RayCluster, the
// submitter Job with its logs, times and attempts.
// A RayService's details: its state and why it is not ready, the serve Service and endpoints, the active RayCluster
// and the pending one of an upgrade with their Serve applications, and `serveConfigV2` as YAML with every
// environment value and secret-looking value masked (mask.ts), or not at all when it cannot be read safely.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { status } from "../../resources";
import { safeUriText } from "../../resources/uri";
import { Block, Fields, KINDS, link, mapChips, type FieldRow } from "../details";
import { JobStateText, ServiceStateText } from "./columns";
import {
  activeOf,
  conditionOf,
  deploymentStatusOf,
  jobMessageOf,
  jobState,
  jobStatusOf,
  pendingOf,
  serveServiceOf,
  serviceReason,
  serviceState,
  submissionModeOf,
  submitterJobOf,
  type ServeCluster,
} from "./model";
import { maskedEntrypoint, maskedServeConfig } from "./mask";
import { AppsTable, clip, code, date, LABELS, Muted, Note, RAY_CLUSTER_TYPE, SelectorLogsButton } from "./parts";

const { get, num, str } = status;

export function JobView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const state = jobState(obj);
  const submitter = submitterJobOf(obj);
  const message = jobMessageOf(obj);
  const reason = str(get(obj, "status", "reason"));
  const submitterSelector = `job-name=${submitter ?? ""}`;
  const command = str(get(obj, "spec", "entrypoint"));
  const entrypoint = code(command === undefined ? undefined : maskedEntrypoint(command));
  const rows: FieldRow[] = [
    ["status", <JobStateText key="s" obj={obj} />],
    ["jobStatus", jobStatusOf(obj)],
    ["deploymentStatus", deploymentStatusOf(obj)],
    ["reason", reason],
    ["rayCluster", link(RAY_CLUSTER_TYPE, str(get(obj, "status", "rayClusterName")), ns)],
    ["clusterSelector", mapChips(get(obj, "spec", "clusterSelector"))],
    ["submissionMode", submissionModeOf(obj)],
    ["submitter", link(KINDS.job, submitter, ns)],
    ["jobId", str(get(obj, "status", "jobId"))],
    ["dashboardURL", safeUriText(str(get(obj, "status", "dashboardURL")))],
    ["startTime", date(str(get(obj, "status", "startTime")))],
    ["endTime", date(str(get(obj, "status", "endTime")))],
    ["succeeded", num(get(obj, "status", "succeeded"))?.toString()],
    ["failed", num(get(obj, "status", "failed"))?.toString()],
    ["shutdown", get(obj, "spec", "shutdownAfterJobFinishes") === true ? t("kuberay:yes") : null],
  ];
  return (
    <>
      {message && (state === "failed" || state === "retrying") && <Note text={clip(message)} tone={state === "failed" ? "danger" : "warning"} />}
      {message && state !== "failed" && state !== "retrying" && <Muted text={clip(message)} />}
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block id="kuberay:entrypoint" title={t("kuberay:entrypoint")}>{entrypoint ?? <Muted text={t("kuberay:noEntrypoint")} />}</Block>
      {ns && submitter && (
        <SelectorLogsButton
          clusterId={clusterId}
          namespace={ns}
          selector={submitterSelector}
          title={submitterSelector}
          text={t("kuberay:submitterLogs")}
        />
      )}
    </>
  );
}

function ServeClusterBlock({ id, title, cluster, ns }: { id: string; title: string; cluster: ServeCluster; ns: string | null }) {
  const { t } = useTranslation();
  if (!cluster.rayClusterName && cluster.apps.length === 0) return null;
  const rows: FieldRow[] = [
    ["rayCluster", link(RAY_CLUSTER_TYPE, cluster.rayClusterName, ns)],
    ["trafficPercent", cluster.trafficPercent === undefined ? null : t("kuberay:percent", { value: cluster.trafficPercent })],
    ["targetCapacity", cluster.targetCapacity === undefined ? null : t("kuberay:percent", { value: cluster.targetCapacity })],
  ];
  return (
    <Block id={id} title={title}>
      <Fields rows={rows} labelPrefix={LABELS} />
      <AppsTable id={id} apps={cluster.apps} />
    </Block>
  );
}

export function ServiceView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const state = serviceState(obj);
  const reason = serviceReason(obj);
  const upgrade = conditionOf(obj, "UpgradeInProgress");
  const rollback = conditionOf(obj, "RollbackInProgress");
  const configText = str(get(obj, "spec", "serveConfigV2"));
  const masked = configText ? maskedServeConfig(configText) : undefined;
  const serveConfig = !configText ? (
    <Muted text={t("kuberay:noServeConfig")} />
  ) : masked === undefined ? (
    <Muted text={t("kuberay:serveConfigUnreadable")} />
  ) : (
    code(masked)
  );
  const rows: FieldRow[] = [
    ["status", <ServiceStateText key="s" obj={obj} />],
    ["serviceStatus", str(get(obj, "status", "serviceStatus"))],
    ["serveService", link(KINDS.service, serveServiceOf(obj), ns)],
    ["serveEndpoints", num(get(obj, "status", "numServeEndpoints"))?.toString()],
    ["upgradeStrategy", str(get(obj, "spec", "upgradeStrategy", "type"))],
    ["upgrade", upgrade?.status === "True" ? upgrade.message || upgrade.reason : null],
    ["rollback", rollback?.status === "True" ? rollback.message || rollback.reason || t("kuberay:yes") : null],
  ];
  return (
    <>
      {state !== "ready" && state !== "suspended" && reason && <Note text={clip(reason)} tone={state === "failed" ? "danger" : "warning"} />}
      {state === "suspended" && <Muted text={t("kuberay:suspendedNote.service")} />}
      <Fields rows={rows} labelPrefix={LABELS} />
      <ServeClusterBlock id="rayActiveApps" title={t("kuberay:activeCluster")} cluster={activeOf(obj)} ns={ns} />
      <ServeClusterBlock id="rayPendingApps" title={t("kuberay:pendingCluster")} cluster={pendingOf(obj)} ns={ns} />
      <Block id="kuberay:serveConfig" title={t("kuberay:serveConfig")}>{serveConfig}</Block>
    </>
  );
}
