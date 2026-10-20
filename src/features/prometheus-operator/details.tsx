// Details of Prometheus Operator objects (one section, `prometheusOperator`):
//   ServiceMonitor / PodMonitor — the namespaces it looks in and its selector, the Services (Pods) it selects right
//                                 now, whether each endpoint's port name exists on them, and which Prometheus picks
//                                 it up by its selectors ("selects nothing" and "not picked up" said in words);
//   Probe                       — prober, module, targets, who picks it up;
//   PrometheusRule              — groups with their alerting and recording rules, who picks it up;
//   Prometheus / Alertmanager   — readiness from the conditions, replicas, version; a Prometheus's selectors.
// Conditions and YAML are the panel's own sections. Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { labelSelector as selectorChips } from "../details/ui";
import { ServerStateText } from "./columns";
import { usePrometheuses, useMonitorTargets } from "./hooks";
import {
  ALERTMANAGER,
  endpointsOf,
  isKind,
  monitoringKind,
  monitorSelector,
  MONITORING_GROUP,
  pickedUpBy,
  POD_MONITOR,
  podPortNames,
  PROBE,
  PROMETHEUS,
  PROMETHEUS_RULE,
  ruleGroupsOf,
  serverReadiness,
  SERVICE_MONITOR,
  servicePortNames,
  targetNamespaces,
} from "./model";

const { arr, get, num, str } = status;
const LABELS = "prometheusoperator:fields";
const NS = "prometheusoperator";
/** Selected objects listed by name at most. */
export const MAX_LISTED_TARGETS = 30;

const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
const PROMETHEUS_TYPE = {
  apiVersion: `${MONITORING_GROUP}/v1`,
  kind: "Prometheus",
};
const ENDPOINTS_WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap", undefined];
const GROUPS_WRAP: ColumnWrap[] = [undefined, "nowrap", "nowrap", "nowrap"];
const SELECTORS_WRAP: ColumnWrap[] = ["nowrap", undefined, undefined];
const POD: KindRef = { group: "", version: "v1", kind: "Pod" };

function Note({ text, tone }: { text: string; tone: "warning" | "danger" | "muted" }) {
  return <p className={`promop-note promop-note--${tone}`}>{text}</p>;
}

/** Which Prometheus picks the object up, or a warning that none does. */
function PickedUp({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const { loading, servers, namespaceLabels } = usePrometheuses(clusterId);
  let body: ReactNode;
  if (loading) body = <Note text={t(`${NS}:loading`)} tone="muted" />;
  else if (servers.length === 0) body = <Note text={t(`${NS}:pickup.noPrometheus`)} tone="muted" />;
  else {
    const picked = pickedUpBy(servers, kind, obj, namespaceLabels);
    if (picked.by.length > 0) {
      body = (
        <span className="dt-links">
          {picked.by.map((p) =>
            link(
              p.apiVersion && p.kind ? { apiVersion: p.apiVersion, kind: p.kind } : PROMETHEUS_TYPE,
              p.metadata?.name,
              p.metadata?.namespace ?? null,
              `${p.metadata?.namespace}/${p.metadata?.name}`,
            ),
          )}
        </span>
      );
    } else body = <Note text={t(picked.unknown ? `${NS}:pickup.unknown` : `${NS}:pickup.none`)} tone="warning" />;
  }
  return <Block title={t(`${NS}:pickup.title`)}>{body}</Block>;
}

function MonitorTargets({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const pods = isKind(kind, POD_MONITOR);
  const where = targetNamespaces(obj);
  const targets = useMonitorTargets(clusterId, pods ? POD : SERVICE, where, monitorSelector(obj));
  const what = pods ? "pods" : "services";
  let body: ReactNode;
  if (targets.status === "loading") body = <Note text={t(`${NS}:loading`)} tone="muted" />;
  else if (targets.status === "error") body = <Note text={t(`${NS}:targets.error`)} tone="warning" />;
  else if (targets.status === "nothing") body = <Note text={t(`${NS}:targets.invalidSelector`)} tone="danger" />;
  else if (targets.status === "everything") body = <Note text={t(`${NS}:targets.everything.${what}`)} tone="muted" />;
  else if (targets.status === "tooManyNamespaces")
    body = <Note text={t(`${NS}:targets.tooMany`, { count: targets.count })} tone="muted" />;
  else {
    const objects = [...targets.objects].sort((a, b) =>
      `${a.metadata?.namespace}/${a.metadata?.name}`.localeCompare(`${b.metadata?.namespace}/${b.metadata?.name}`),
    );
    if (objects.length === 0) body = <Note text={t(`${NS}:targets.none.${what}`)} tone="danger" />;
    else {
      const ports = endpointsOf(obj, kind);
      const names = objects.map((o) => new Set(pods ? podPortNames(o) : servicePortNames(o)));
      const portRows = ports.map((e) => {
        const found = e.port ? names.filter((s) => s.has(e.port!)).length : undefined;
        const portText = e.port ?? (e.number !== undefined ? String(e.number) : (e.targetPort ?? ""));
        return [
          portText,
          e.path ?? "/metrics",
          e.interval ?? "",
          found === undefined ? (
            ""
          ) : (
            <span key="f" className={found === 0 ? "promop-bad" : found < objects.length ? "promop-warn" : undefined}>
              {t(`${NS}:targets.portFound`, { found, total: objects.length })}
            </span>
          ),
        ];
      });
      const shown = objects.slice(0, MAX_LISTED_TARGETS);
      const endpointsTable = table(
        "promopEndpoints",
        [t(`${NS}:endpoints.port`), t(`${NS}:endpoints.path`), t(`${NS}:endpoints.interval`), t(`${NS}:endpoints.found`)],
        portRows,
        ENDPOINTS_WRAP,
      );
      body = (
        <>
          <p className="promop-summary">{t(`${NS}:targets.selected.${what}`, { count: objects.length })}</p>
          <span className="dt-links">
            {shown.map((o) =>
              link(
                pods ? KINDS.pod : KINDS.service,
                o.metadata?.name,
                o.metadata?.namespace ?? null,
                `${o.metadata?.namespace}/${o.metadata?.name}`,
              ),
            )}
          </span>
          {objects.length > shown.length && (
            <Note
              text={t(`${NS}:targets.more`, {
                count: objects.length - shown.length,
              })}
              tone="muted"
            />
          )}
          {endpointsTable}
        </>
      );
    }
  }
  return <Block title={t(`${NS}:targets.title`)}>{body}</Block>;
}

function MonitorView({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const where = targetNamespaces(obj);
  const rows: FieldRow[] = [
    ["namespaces", where.type === "any" ? t(`${NS}:anyNamespace`) : chips(where.names)],
    ["selector", selectorChips(get(obj, "spec", "selector")) ?? t(`${NS}:selectsAll`)],
    ["jobLabel", str(get(obj, "spec", "jobLabel"))],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <MonitorTargets clusterId={clusterId} kind={kind} obj={obj} />
      <PickedUp clusterId={clusterId} kind={kind} obj={obj} />
    </>
  );
}

function ProbeView({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const statics = arr(get(obj, "spec", "targets", "staticConfig", "static")).map(String);
  const rows: FieldRow[] = [
    ["prober", str(get(obj, "spec", "prober", "url"))],
    ["module", str(get(obj, "spec", "module"))],
    ["interval", str(get(obj, "spec", "interval"))],
    ["staticTargets", chips(statics)],
    ["ingressSelector", selectorChips(get(obj, "spec", "targets", "ingress", "selector"))],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <PickedUp clusterId={clusterId} kind={kind} obj={obj} />
    </>
  );
}

function RuleView({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const groups = ruleGroupsOf(obj);
  const groupsTable = table(
    "promopGroups",
    [t(`${NS}:groups.name`), t(`${NS}:groups.interval`), t(`${NS}:groups.alerts`), t(`${NS}:groups.records`)],
    groups.map((g) => [g.name, g.interval ?? "", String(g.alerts), String(g.records)]),
    GROUPS_WRAP,
  );
  return (
    <>
      <Block title={t(`${NS}:groups.title`)}>
        {groups.length === 0 ? <Note text={t(`${NS}:groups.none`)} tone="muted" /> : groupsTable}
      </Block>
      <PickedUp clusterId={clusterId} kind={kind} obj={obj} />
    </>
  );
}

/** A Prometheus selector in words: none (null), all (empty) or its terms. */
function selectorValue(value: unknown, t: (key: string) => string): ReactNode {
  if (value === undefined || value === null) return t(`${NS}:selectors.none`);
  return selectorChips(value) ?? t(`${NS}:selectors.all`);
}

function namespacesValue(value: unknown, t: (key: string) => string): ReactNode {
  if (value === undefined || value === null) return t(`${NS}:selectors.ownNamespace`);
  return selectorChips(value) ?? t(`${NS}:selectors.allNamespaces`);
}

const SELECTORS: [label: string, selector: string, namespaces: string][] = [
  ["serviceMonitors", "serviceMonitorSelector", "serviceMonitorNamespaceSelector"],
  ["podMonitors", "podMonitorSelector", "podMonitorNamespaceSelector"],
  ["probes", "probeSelector", "probeNamespaceSelector"],
  ["rules", "ruleSelector", "ruleNamespaceSelector"],
];

function ServerView({ kind, obj }: { kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const r = serverReadiness(obj);
  const spec = get(obj, "spec");
  const rows: FieldRow[] = [
    ["status", <ServerStateText key="s" obj={obj} />],
    ["reason", r.reason],
    [
      "replicas",
      t(`${NS}:replicasAvailable`, {
        available: r.available ?? 0,
        total: r.desired,
      }),
    ],
    ["shards", num(get(spec, "shards"))?.toString()],
    ["version", str(get(spec, "version"))],
    ["retention", str(get(spec, "retention"))],
    ["paused", get(spec, "paused") === true ? t(`${NS}:yes`) : undefined],
  ];
  const selectors = isKind(kind, PROMETHEUS)
    ? SELECTORS.map(([label, sel, nsSel]) => [
        t(`${NS}:selectors.${label}`),
        selectorValue(get(spec, sel), t),
        namespacesValue(get(spec, nsSel), t),
      ])
    : [];
  const selectorsTable = table(
    "promopSelectors",
    [t(`${NS}:selectors.what`), t(`${NS}:selectors.selector`), t(`${NS}:selectors.namespaces`)],
    selectors,
    SELECTORS_WRAP,
  );
  return (
    <>
      {(r.state === "failed" || r.state === "degraded") && r.message && <Note text={r.message} tone="danger" />}
      <Fields rows={rows} labelPrefix={LABELS} />
      {selectors.length > 0 && <Block title={t(`${NS}:selectors.title`)}>{selectorsTable}</Block>}
    </>
  );
}

export function PrometheusOperatorSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, SERVICE_MONITOR, POD_MONITOR)) return <MonitorView clusterId={clusterId} kind={kind} obj={obj} />;
  if (isKind(kind, PROBE)) return <ProbeView clusterId={clusterId} kind={kind} obj={obj} />;
  if (isKind(kind, PROMETHEUS_RULE)) return <RuleView clusterId={clusterId} kind={kind} obj={obj} />;
  if (isKind(kind, PROMETHEUS, ALERTMANAGER)) return <ServerView kind={kind} obj={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof monitoringKind>[0]): boolean => monitoringKind(kind) !== undefined;
