// The "Autoscaling" details of a HorizontalPodAutoscaler — why it is where it is: the verdict, causes read from the
// conditions, the target and its pod template's requests, each metric's current value against its target and the
// replicas it asks for, the conditions in plain words, the behavior (stabilization, policies, tolerance) and the
// recent scaling events — and the compact form (`HpaSummary`) the workload and ScaledObject details show.
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { Age } from "../../components";
import { formatList } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { kindFromApiVersion, StatusText } from "../../resources";
import { Block, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import { analyzeHpa, isScalingEvent, requestChecks, templateOf, type DirectionBehavior, type HpaAnalysis, type MetricRow, type RequestCheck } from "./hpa";
import { useObject, useObjectEvents, useServed } from "./hooks";
import { HPA, phrase, type Phrase } from "./model";
import { EventsTable, Note, PhraseLine, Phrases } from "./ui";

const FIELDS = "autoscaling:fields";
const METRIC_WRAP: readonly ColumnWrap[] = [undefined, "nowrap", "nowrap", "nowrap"];
const CONDITION_WRAP: readonly ColumnWrap[] = ["nowrap", "nowrap", undefined];
const HPA_TYPE = { apiVersion: "autoscaling/v2", kind: "HorizontalPodAutoscaler" };

export function HpaSection({ clusterId, obj }: DetailsSectionProps) {
  if (!obj) return null;
  return <HpaDetails clusterId={clusterId} hpa={obj} />;
}

function metricName(m: MetricRow): string {
  const parts = [`${m.source} ${m.name}`.trim()];
  if (m.container) parts.push(`(${m.container})`);
  if (m.object) parts.push(`(${m.object})`);
  if (m.selector) parts.push(`{${m.selector}}`);
  return parts.join(" ");
}

function MetricsTable({ metrics }: { metrics: readonly MetricRow[] }) {
  const { t } = useTranslation();
  if (metrics.length === 0) return <Note>{t("autoscaling:hpa.noMetrics")}</Note>;
  const proposes = (m: MetricRow): ReactNode => {
    if (m.proposes === undefined) return <span className="as-warning">{t("autoscaling:hpa.noValue")}</span>;
    return m.withinTolerance ? t("autoscaling:hpa.withinTolerance", { replicas: m.proposes }) : String(m.proposes);
  };
  return (
    <>
      {table(
        [t("autoscaling:hpa.metric"), t("autoscaling:hpa.current"), t("autoscaling:hpa.target"), t("autoscaling:hpa.proposes")],
        metrics.map((m) => [
          metricName(m),
          m.currentText ?? <span className="as-warning">{t("autoscaling:hpa.noValue")}</span>,
          m.targetType ? `${m.targetText ?? "?"} (${m.targetType})` : (m.targetText ?? "?"),
          proposes(m),
        ]),
        METRIC_WRAP,
      )}
    </>
  );
}

function behaviorLines(b: DirectionBehavior, t: (key: string, values?: Record<string, unknown>) => string): ReactNode {
  if (b.selectPolicy === "Disabled") return t("autoscaling:behavior.disabled");
  const policies = formatList(
    b.policies.map((p) =>
      p.type === "Pods"
        ? t("autoscaling:behavior.pods", { count: p.value, period: p.periodSeconds })
        : p.type === "Percent"
          ? t("autoscaling:behavior.percent", { percent: p.value, period: p.periodSeconds })
          : `${p.type} ${p.value}/${p.periodSeconds}`,
    ),
  );
  const lines = [
    b.windowSeconds > 0 ? t("autoscaling:behavior.window", { count: b.windowSeconds }) : t("autoscaling:behavior.noWindow"),
    t(b.selectPolicy === "Min" ? "autoscaling:behavior.selectMin" : "autoscaling:behavior.selectMax", { policies }),
    t("autoscaling:behavior.tolerance", { percent: Math.round(b.tolerance * 1000) / 10 }),
  ];
  return (
    <span className="as-lines">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </span>
  );
}

function requestPhrases(checks: readonly RequestCheck[], hasTemplate: boolean): Phrase[] {
  if (checks.length === 0) return [];
  if (!hasTemplate) return [phrase("requests.noTemplate", undefined, "muted")];
  return checks.map((c) => {
    if (c.without.length === 0) return phrase("requests.ok", { resource: c.resource }, "success");
    if (c.container) return phrase("requests.missingContainer", { resource: c.resource, container: c.container }, "danger");
    return phrase("requests.missing", { resource: c.resource, containers: formatList(c.without) }, "danger");
  });
}

function ConditionsTable({ a }: { a: HpaAnalysis }) {
  const { t } = useTranslation();
  if (a.conditions.length === 0) return null;
  return (
    <>
      {table(
        [t("autoscaling:hpa.condition"), t("autoscaling:hpa.status"), t("autoscaling:hpa.meaning")],
        a.conditions.map((c) => [
          c.type,
          <StatusText value={c.reason ?? c.status} tone={c.tone} />,
          <span className="as-lines">
            {c.explanation && <span>{t(`autoscaling:${c.explanation.key}`)}</span>}
            {c.message && <span className="as-muted">{c.message}</span>}
          </span>,
        ]),
        CONDITION_WRAP,
      )}
    </>
  );
}

function replicaRows(a: HpaAnalysis, t: (key: string, values?: Record<string, unknown>) => string): FieldRow[] {
  const estimate = a.estimate;
  let byMetrics: ReactNode = null;
  if (estimate) {
    const parts = [t("autoscaling:hpa.replicas", { count: estimate.wanted })];
    if (estimate.limitedBy) parts.push(t(`autoscaling:hpa.limited.${estimate.limitedBy}`, { count: estimate.replicas }));
    if (estimate.heldByMissing) parts.push(t("autoscaling:hpa.heldByMissing"));
    byMetrics = (
      <span className="as-lines">
        {parts.map((p) => (
          <span key={p}>{p}</span>
        ))}
      </span>
    );
  }
  return [
    ["replicas", t("autoscaling:hpa.replicasNow", { current: a.current, desired: a.desired ?? a.current })],
    ["range", `${a.min}–${a.max}`],
    ["estimate", byMetrics],
    ["lastScale", a.lastScaleTime ? <Age timestamp={a.lastScaleTime} /> : null],
  ];
}

function HpaDetails({ clusterId, hpa }: { clusterId: ClusterId; hpa: KubeObject }) {
  const { t } = useTranslation();
  const a = useMemo(() => analyzeHpa(hpa), [hpa]);
  const namespace = hpa.metadata?.namespace ?? null;
  const targetRef = a.target ? kindFromApiVersion(a.target.apiVersion, a.target.kind) : HPA;
  const served = useServed(clusterId, targetRef);
  const target = useObject(clusterId, a.target ? served : null, namespace, a.target?.name);
  const events = useObjectEvents(clusterId, hpa, "HorizontalPodAutoscaler");
  const scaling = useMemo(() => events.filter(isScalingEvent), [events]);
  const template = templateOf(target);
  const checks = requestPhrases(requestChecks(hpa, template), template !== undefined);

  const fields: FieldRow[] = [
    ["target", a.target ? link({ apiVersion: a.target.apiVersion, kind: a.target.kind }, a.target.name, namespace, `${a.target.kind}/${a.target.name}`) : null],
    ...replicaRows(a, t),
  ];
  const behavior: FieldRow[] = [
    ["scaleUp", behaviorLines(a.up, t)],
    ["scaleDown", behaviorLines(a.down, t)],
  ];

  return (
    <Block title={t("autoscaling:hpa.title")}>
      <PhraseLine phrase={a.verdict} />
      <Phrases phrases={a.causes} />
      <Fields labelPrefix={FIELDS} rows={fields} />
      <h4 className="as-subtitle">{t("autoscaling:hpa.metrics")}</h4>
      <MetricsTable metrics={a.metrics} />
      {a.estimate && <Note>{t("autoscaling:hpa.estimateNote")}</Note>}
      {checks.length > 0 && (
        <>
          <h4 className="as-subtitle">{t("autoscaling:hpa.requests")}</h4>
          <Phrases phrases={checks} />
        </>
      )}
      <h4 className="as-subtitle">{t("autoscaling:hpa.conditions")}</h4>
      <ConditionsTable a={a} />
      <h4 className="as-subtitle">{t("autoscaling:hpa.behavior")}</h4>
      <Fields labelPrefix={FIELDS} rows={behavior} />
      {scaling.length > 0 && (
        <>
          <h4 className="as-subtitle">{t("autoscaling:hpa.events")}</h4>
          <EventsTable events={scaling} />
        </>
      )}
    </Block>
  );
}

/** One HPA in a line or two: a link, the verdict and the metrics (workload and ScaledObject details). */
export function HpaSummary({ hpa, metrics = false }: { hpa: KubeObject; metrics?: boolean }) {
  const { t } = useTranslation();
  const a = useMemo(() => analyzeHpa(hpa), [hpa]);
  const name = hpa.metadata?.name ?? "";
  const fields: FieldRow[] = [
    ["hpa", link(HPA_TYPE, name, hpa.metadata?.namespace ?? null)],
    ["replicas", t("autoscaling:hpa.replicasNow", { current: a.current, desired: a.desired ?? a.current })],
    ["range", `${a.min}–${a.max}`],
  ];
  return (
    <div className="as-summary">
      <Fields labelPrefix={FIELDS} rows={fields} />
      <PhraseLine phrase={a.verdict} />
      <Phrases phrases={a.causes} />
      {metrics && <MetricsTable metrics={a.metrics} />}
    </div>
  );
}
