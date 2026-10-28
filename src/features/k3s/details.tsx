import { useDetailsDisclosure } from "../../layout/details/disclosure";
// Details of the helm-controller and k3s kinds (one section, `k3s`), and the "k3s" / "RKE2" block of Nodes:
//   HelmChart        — the state with its Job (helm-controller's conditions, else the Job's outcome), what it installs
//                      and where, the Addon that deployed it, its HelmChartConfig, the install Job with its attempts
//                      and "Logs" (the pods labelled `helmcharts.helm.cattle.io/chart=<name>`, in one merged tab), the
//                      Secrets its values come from (names and key names only) and its values, masked (mask.ts) and
//                      folded;
//   HelmChartConfig  — the HelmChart it overrides (the one of its name) and its values, masked and folded;
//   Addon            — the manifest file and its checksum (a manifest k3s could not apply is a Warning Event of it);
//   ETCDSnapshotFile — node, storage, location without credentials, size, times, the error;
//   Node             — the distribution, version, role, what told it, the addresses k3s recorded, and the node's
//                      arguments with every secret value hidden (mask.ts).
// Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { stringify } from "yaml";
import type { ClusterId, KubeObject } from "../../api";
import { Button } from "../../components";
import { formatDateTime } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { openSelectorLogsTab } from "../logs";
import { ChartStateText, sizeText } from "./columns";
import { useJobsOfChart, useNamed } from "./hooks";
import { maskedSet, maskedValuesContent, maskValues } from "./mask";
import {
  ADDON,
  addonChecksumOf,
  addonOwnerOf,
  addonSourceOf,
  CHART_LABEL,
  chartFailureOf,
  chartInfoOf,
  chartReferencesOf,
  chartStateOf,
  configTargetOf,
  ETCD_SNAPSHOT,
  HELM_CHART,
  HELM_CHART_CONFIG,
  isKind,
  jobInfoOf,
  jobOfChart,
  NODE,
  nodeDistributionOf,
  SNAPSHOT_TONE,
  snapshotOf,
  snapshotStateOf,
  valuesSecretsOf,
  type JobState,
} from "./model";

const LABELS = "k3s:fields";
const ADDON_TYPE = { apiVersion: "k3s.cattle.io/v1", kind: "Addon" };
const CHART_TYPE = { apiVersion: "helm.cattle.io/v1", kind: "HelmChart" };
const CONFIG_TYPE = { apiVersion: "helm.cattle.io/v1", kind: "HelmChartConfig" };
const ARGS_TABLE = "k3sNodeArgs";
const ARGS_WRAP: ColumnWrap[] = ["nowrap", undefined];
const SECRETS_WRAP: ColumnWrap[] = ["nowrap", undefined];

/** Text from the cluster longer than this is cut in a details view (the YAML section has all of it). */
export const MAX_TEXT = 20_000;
const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

export function Muted({ text }: { text: string }) {
  return <p className="k3s-muted">{text}</p>;
}

export function Note({ text, tone }: { text: string; tone: "warning" | "danger" }) {
  return <p className={`k3s-note k3s-note--${tone}`}>{text}</p>;
}

const JOB_TONE: Record<JobState, "success" | "warning" | "danger" | "muted"> = { complete: "success", running: "warning", failed: "danger", pending: "muted" };

/** A HelmChart's or HelmChartConfig's values (`valuesContent`, `values`, `set`), masked, folded behind a toggle. */
function ValuesBlock({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const spec = (obj.spec ?? {}) as Record<string, unknown>;
  const content = typeof spec.valuesContent === "string" ? maskedValuesContent(spec.valuesContent) : "";
  const values = spec.values && typeof spec.values === "object" && !Array.isArray(spec.values) ? stringify(maskValues(spec.values), { lineWidth: 0 }) : "";
  const set = maskedSet(spec.set);
  const nothing = content === "" && values === "" && set.length === 0;
  return (
    <Block id="k3s:values.title" title={t("k3s:values.title")}>
      {nothing ? (
        <Muted text={t("k3s:values.none")} />
      ) : (
        <>
          <Muted text={t("k3s:values.note")} />
          {content === undefined && <Muted text={t("k3s:values.unreadable")} />}
          {content && (
            <details className="k3s-values">
              <summary>{t("k3s:values.showContent")}</summary>
              <pre className="k3s-pre">{clip(content)}</pre>
            </details>
          )}
          {values && (
            <details className="k3s-values">
              <summary>{t("k3s:values.showValues")}</summary>
              <pre className="k3s-pre">{clip(values)}</pre>
            </details>
          )}
          {set.length > 0 && (
            <details className="k3s-values">
              <summary>{t("k3s:values.showSet")}</summary>
              <pre className="k3s-pre">{clip(set.join("\n"))}</pre>
            </details>
          )}
        </>
      )}
    </Block>
  );
}

/** The Secrets `valuesSecrets` names, with the keys read from each (never a value). */
function ValuesSecrets({ obj, id }: { obj: KubeObject; id: string }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const rows = valuesSecretsOf(obj).map((s) => [link(KINDS.secret, s.name, ns), chips(s.keys) ?? t("k3s:values.allKeys")]);
  if (rows.length === 0) return null;
  return <Block id="k3s:values.secrets" title={t("k3s:values.secrets")}>{table(id, [t("k3s:values.secret"), t("k3s:values.keys")], rows, SECRETS_WRAP)}</Block>;
}

function JobBlock({ clusterId, chart }: { clusterId: ClusterId; chart: KubeObject }) {
  const { t } = useTranslation();
  const ns = chart.metadata?.namespace ?? undefined;
  const name = chart.metadata?.name ?? undefined;
  const open = useDetailsDisclosure("k3s:job.title")?.open ?? true;
  const jobs = useJobsOfChart(clusterId, ns, open ? name : undefined);
  const job = jobOfChart(chart, jobs.items);
  const info = job ? jobInfoOf(job) : undefined;
  const selector = `${CHART_LABEL}=${name ?? ""}`;
  const rows: FieldRow[] = info
    ? [
        ["job", link(KINDS.job, info.name, info.namespace)],
        ["jobState", <StatusText key="s" value={t(`k3s:jobState.${info.state}`)} tone={JOB_TONE[info.state]} />],
        ["failedPods", info.failed > 0 ? String(info.failed) : null],
        ["started", date(info.startedAt)],
        ["completed", date(info.completedAt)],
        ["failedAt", date(info.failedAt)],
      ]
    : [];
  return (
    <Block id="k3s:job.title"
      title={t("k3s:job.title")}
      actions={
        ns && name ? (
          <Button size="compact" icon="logs" onClick={() => void openSelectorLogsTab(clusterId, ns, selector, chartInfoOf(chart).jobName)}>
            {t("k3s:job.logs")}
          </Button>
        ) : undefined
      }
    >
      {info ? <Fields rows={rows} labelPrefix={LABELS} /> : jobs.loading ? <Muted text={t("k3s:loading")} /> : <Muted text={t("k3s:job.none", { job: chartInfoOf(chart).jobName })} />}
      {jobs.unavailable && !jobs.loading && <Muted text={t("k3s:job.unavailable")} />}
    </Block>
  );
}

function ChartView({ clusterId, chart }: { clusterId: ClusterId; chart: KubeObject }) {
  const { t } = useTranslation();
  const ns = chart.metadata?.namespace ?? null;
  const name = chart.metadata?.name ?? undefined;
  const jobs = useJobsOfChart(clusterId, ns ?? undefined, name);
  const job = jobOfChart(chart, jobs.items);
  const config = useNamed(clusterId, HELM_CHART_CONFIG, ns ?? undefined, name);
  const info = chartInfoOf(chart);
  const refs = chartReferencesOf(chart);
  const owner = addonOwnerOf(chart);
  const state = chartStateOf(chart, job);
  const failure = chartFailureOf(chart, job);
  const rows: FieldRow[] = [
    ["state", <ChartStateText key="s" obj={chart} job={job} />],
    ["chart", info.chart ?? null],
    ["repo", info.repo ?? null],
    ["version", info.version ?? null],
    ["targetNamespace", link(KINDS.namespace, info.targetNamespace)],
    ["createNamespace", info.createNamespace ? t("k3s:yes") : null],
    ["bootstrap", info.bootstrap ? t("k3s:yes") : null],
    ["failurePolicy", info.failurePolicy ?? null],
    ["backOffLimit", String(info.backOffLimit)],
    ["timeout", info.timeout ?? null],
    ["jobImage", info.jobImage ?? null],
    ["authSecret", link(KINDS.secret, refs.authSecret, ns)],
    ["repoCA", link(KINDS.configMap, refs.repoCaConfigMap, ns)],
    ["registrySecret", link(KINDS.secret, refs.registrySecret, ns)],
    ["addon", owner ? link(ADDON_TYPE, owner.name, owner.namespace) : null],
    ["helmChartConfig", config.obj ? link(CONFIG_TYPE, name, ns) : null],
  ];
  return (
    <>
      {state === "failed" && failure && <Note text={clip(failure)} tone="danger" />}
      {state === "retrying" && <Note text={t("k3s:hint.retrying")} tone="warning" />}
      {state === "applied" && <Muted text={t("k3s:hint.applied")} />}
      {state === "unknown" && <Muted text={t("k3s:hint.unknown")} />}
      <Fields rows={rows} labelPrefix={LABELS} />
      {owner && <Muted text={t("k3s:hint.bundled", { addon: owner.name })} />}
      <JobBlock clusterId={clusterId} chart={chart} />
      <ValuesSecrets obj={chart} id="k3sChartValuesSecrets" />
      <ValuesBlock obj={chart} />
    </>
  );
}

function ConfigView({ clusterId, config }: { clusterId: ClusterId; config: KubeObject }) {
  const { t } = useTranslation();
  const target = configTargetOf(config);
  const chart = useNamed(clusterId, HELM_CHART, target.namespace, target.name);
  const failurePolicy = status.str(status.get(config, "spec", "failurePolicy")) || null;
  const rows: FieldRow[] = [
    ["helmChart", chart.obj ? link(CHART_TYPE, target.name, target.namespace) : null],
    ["failurePolicy", failurePolicy],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      {!chart.loading && !chart.obj && <Note text={t("k3s:config.noChart", { name: target.name, namespace: target.namespace })} tone="warning" />}
      <Muted text={t("k3s:config.hint")} />
      <ValuesSecrets obj={config} id="k3sConfigValuesSecrets" />
      <ValuesBlock obj={config} />
    </>
  );
}

function AddonView({ addon }: { addon: KubeObject }) {
  const { t } = useTranslation();
  const rows: FieldRow[] = [
    ["source", addonSourceOf(addon) ?? null],
    ["checksum", addonChecksumOf(addon) ?? null],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <Muted text={t("k3s:addon.hint")} />
    </>
  );
}

function SnapshotView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const s = snapshotOf(obj);
  const state = snapshotStateOf(s);
  const rows: FieldRow[] = [
    ["snapshotState", <StatusText key="s" value={t(`k3s:snapshotState.${state}`)} tone={SNAPSHOT_TONE[state]} />],
    ["snapshotName", s.snapshotName ?? null],
    ["node", link(KINDS.node, s.node)],
    ["storage", t(`k3s:storage.${s.storage}`)],
    ["bucket", s.bucket ?? null],
    ["location", s.location ?? null],
    ["size", sizeText(s.size) || null],
    ["created", date(s.createdAt)],
    ["errorAt", date(s.errorAt)],
  ];
  return (
    <>
      {s.error && <Note text={clip(s.error)} tone="danger" />}
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

export function K3sSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, HELM_CHART)) return <ChartView clusterId={clusterId} chart={obj} />;
  if (isKind(kind, HELM_CHART_CONFIG)) return <ConfigView clusterId={clusterId} config={obj} />;
  if (isKind(kind, ADDON)) return <AddonView addon={obj} />;
  if (isKind(kind, ETCD_SNAPSHOT)) return <SnapshotView obj={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof isKind>[0]): boolean =>
  isKind(kind, HELM_CHART) || isKind(kind, HELM_CHART_CONFIG) || isKind(kind, ADDON) || isKind(kind, ETCD_SNAPSHOT);

// ---------- Nodes ----------

/** A node's arguments: flag and value, a hidden one as "hidden". */
function ArgsTable({ node }: { node: KubeObject }) {
  const { t } = useTranslation();
  const d = nodeDistributionOf(node);
  if (d.args === undefined) return null;
  if (d.args === null) return <Muted text={t("k3s:node.argsUnreadable")} />;
  const hidden = <span className="k3s-muted">{t("k3s:node.hidden")}</span>;
  const rows = d.args.map((a) => [a.flag ?? "", a.hidden ? hidden : (a.value ?? "")]);
  const view = table(ARGS_TABLE, [t("k3s:node.flag"), t("k3s:node.value")], rows, ARGS_WRAP);
  return (
    <>
      {view}
      <Muted text={t("k3s:node.argsNote")} />
    </>
  );
}

export function NodeSection({ obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const d = nodeDistributionOf(obj);
  if (!d.distribution) return null;
  const roles = d.roles.map((r) => t(`k3s:role.${r}`));
  const rows: FieldRow[] = [
    ["distribution", t(`k3s:distribution.${d.distribution}`)],
    ["version", d.version ?? null],
    ["nodeRole", t(d.server ? "k3s:node.server" : "k3s:node.agent")],
    ["roles", chips(roles)],
    ["signals", chips(d.signals.map((s) => t(`k3s:signal.${s}`)))],
    ["hostname", d.hostname ?? null],
    ["internalIp", d.internalIp ?? null],
    ["externalIp", d.externalIp ?? null],
    ["etcdMember", d.etcdMember ?? null],
  ];
  return (
    <Block id="distribution" title={t(`k3s:distribution.${d.distribution}`)}>
      <Fields rows={rows} labelPrefix={LABELS} />
      {d.args !== undefined && (
        <Block id="k3s:node.args" title={t("k3s:node.args")}>
          <ArgsTable node={obj} />
        </Block>
      )}
    </Block>
  );
}

export const nodeApplies = (kind: Parameters<typeof isKind>[0]): boolean => isKind(kind, NODE);
