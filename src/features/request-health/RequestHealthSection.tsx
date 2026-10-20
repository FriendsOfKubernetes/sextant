// "Requests" section of the details panel (#212) for Deployments, StatefulSets, DaemonSets and Pods, right after the
// CPU/memory metrics: request rate, error rate and latency from each request-metric source Prometheus has (Istio,
// Linkerd, ingress-nginx, Grafana Beyla, Cilium Hubble), the last hour as small charts, and CPU throttling per
// container with a hint when the CPU limit is the likely cause. Read-only; polled once a minute while shown.
import type { TFunction } from "i18next";
import type { MouseEvent } from "react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, GoldenMetrics, HistoryScope, KubeObject, ObjectRef, RequestHealth } from "../../api";
import { ErrorState } from "../../components";
import { formatList } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { openClusterSettings } from "../clusters/clustersStore";
import { Chart } from "../metrics/Chart";
import { formatCpu } from "../metrics/format";
import { buildRows } from "../rightsizing/group";
import { useRightsizingSource } from "../rightsizing/hooks";
import { useWorkloadPods } from "../rightsizing/workloadPods";
import { SECTION_ATTRIBUTE, SECTION_ID, useRequestHealth } from "./hooks";
import {
  containerAmounts,
  formatLatency,
  formatRate,
  formatShare,
  SOURCE_KEY,
  targetOf,
  throttleRows,
  type ThrottleRow,
} from "./model";
import "./requesthealth.css";

const SPARKLINE_HEIGHT = 64;
// Theme tokens checked by the contrast test (a chart line keeps 3:1 against the panel in both themes).
const RATE_COLOR = "--color-chart-cpu";
const ERROR_COLOR = "--color-danger";

function sourceName(t: TFunction, kind: GoldenMetrics["source"]): string {
  return t(`requesthealth:source.${SOURCE_KEY[kind]}`);
}

function SettingsLink({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    openClusterSettings(clusterId);
  };
  return (
    <button type="button" className="mx-link" onClick={open}>
      {t("requesthealth:openSettings")}
    </button>
  );
}

function Golden({ golden }: { golden: GoldenMetrics }) {
  const { t } = useTranslation();
  const key = SOURCE_KEY[golden.source];
  const rate = golden.requestRate;
  const { p50, p95, p99 } = golden.latencyMs;
  const hasLatency = p50 !== null || p95 !== null || p99 !== null;
  // Stable, so a chart is not redrawn on every render.
  const rateFormat = useCallback((v: number) => formatRate(t, v), [t]);
  return (
    <div className="rh-source">
      <h4 className="rh-source__title">{t("requesthealth:fromSource", { source: sourceName(t, golden.source) })}</h4>
      <p className="rh-note">{t(`requesthealth:scope.${key}`)}</p>
      {golden.via === "linkerdViz" && <p className="rh-note">{t("requesthealth:viaLinkerdViz")}</p>}
      <dl className="mx-current">
        <dt>{t("requesthealth:fields.rate")}</dt>
        <dd>{rate === null ? t("requesthealth:noRequestsNow") : formatRate(t, rate)}</dd>
        <dt>{t("requesthealth:fields.errors")}</dt>
        <dd>
          {golden.errorRatio === null
            ? t("requesthealth:noErrorsWithoutRequests")
            : formatShare(t, golden.errorRatio)}
        </dd>
        <dt>{t("requesthealth:fields.latency")}</dt>
        <dd>
          {hasLatency
            ? t("requesthealth:value.latency", {
                p50: formatLatency(t, p50),
                p95: formatLatency(t, p95),
                p99: formatLatency(t, p99),
              })
            : t("requesthealth:noLatency")}
        </dd>
      </dl>
      {golden.rateSeries.length > 0 && (
        <div className="mx-charts">
          <Chart
            title={t("requesthealth:chart.rate")}
            points={golden.rateSeries}
            format={rateFormat}
            color={RATE_COLOR}
            height={SPARKLINE_HEIGHT}
          />
          {golden.errorSeries.length > 0 && (
            <Chart
              title={t("requesthealth:chart.errors")}
              points={golden.errorSeries}
              format={rateFormat}
              color={ERROR_COLOR}
              height={SPARKLINE_HEIGHT}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** No golden metrics: why, and what would provide them. */
function Missing({ clusterId, health }: { clusterId: ClusterId; health: RequestHealth }) {
  const { t } = useTranslation();
  if (!health.prometheus && health.sources.length === 0)
    return (
      <div className="rh-missing" role="status">
        <p>
          {t("requesthealth:noPrometheus")} <SettingsLink clusterId={clusterId} />
        </p>
        <p className="rh-note">{t("requesthealth:wouldProvide")}</p>
      </div>
    );
  if (health.sources.length === 0)
    return (
      <div className="rh-missing" role="status">
        <p>{t("requesthealth:noSource")}</p>
        <p className="rh-note">{t("requesthealth:wouldProvide")}</p>
      </div>
    );
  const names = health.sources.filter((s) => !health.failed.includes(s.kind)).map((s) => sourceName(t, s.kind));
  if (names.length === 0) return null;
  return (
    <p className="rh-note" role="status">
      {t("requesthealth:noDataHere", { sources: formatList(names) })}
    </p>
  );
}

/** What right-sizing recommends for a throttled container's CPU limit (shares its pollers and pod watch). */
function ThrottleSuggestion({
  clusterId,
  objectRef,
  obj,
  container,
}: {
  clusterId: ClusterId;
  objectRef: ObjectRef;
  obj: KubeObject | null;
  container: string;
}) {
  const { t } = useTranslation();
  const isPod = objectRef.kind.kind === "Pod";
  const namespace = objectRef.namespace ?? "";
  const scope: HistoryScope = isPod
    ? { type: "pod", namespace, name: objectRef.name }
    : { type: "workload", namespace, kind: objectRef.kind.kind, name: objectRef.name };
  // The right-sizing section's default window, so both share one poller.
  const source = useRightsizingSource(clusterId, scope, "week");
  const watched = useWorkloadPods(clusterId, objectRef, obj, !isPod);
  const pods = useMemo(() => (isPod ? (obj ? [obj] : []) : watched.pods), [isPod, obj, watched.pods]);
  const rows = useMemo(() => buildRows(pods, source.data, Date.now()), [pods, source.data]);
  const limit = rows.find((r) => r.container === container)?.assessment.recommendation?.cpuLimit;
  return (
    <p className="rh-note">
      {limit !== undefined
        ? t("requesthealth:throttling.suggested", { limit: formatCpu(limit) })
        : t("requesthealth:throttling.seeRightsizing")}
    </p>
  );
}

function Throttling({ health, rows, ...props }: { health: RequestHealth; rows: ThrottleRow[] } & DetailsSectionProps) {
  const { t } = useTranslation();
  if (!health.prometheus) return null;
  let body;
  if (!health.throttlingKnown) body = <p className="rh-note">{t("requesthealth:throttling.unknown")}</p>;
  else if (rows.length === 0) body = <p className="rh-note">{t("requesthealth:throttling.none")}</p>;
  else
    body = (
      <>
        <p className="rh-note">{t("requesthealth:throttling.about")}</p>
        <dl className="mx-current">
          {rows.map((row) => (
            <ThrottleItem key={row.container} row={row} {...props} />
          ))}
        </dl>
      </>
    );
  return (
    <div className="rh-source">
      <h4 className="rh-source__title">{t("requesthealth:throttling.title")}</h4>
      {body}
    </div>
  );
}

function ThrottleItem({ row, ...props }: { row: ThrottleRow } & DetailsSectionProps) {
  const { t } = useTranslation();
  const percent = formatShare(t, row.ratio, "requesthealth:throttling.percent");
  return (
    <>
      <dt className="mx-current__container">{row.container}</dt>
      <dd>
        <div className={row.limitIsCause ? "rh-throttled" : undefined}>{percent}</div>
        {row.limitIsCause && row.limit !== undefined && (
          <>
            <p className="rh-hint">
              {t("requesthealth:throttling.limitCause", { percent, limit: formatCpu(row.limit) })}
            </p>
            <ThrottleSuggestion {...props} container={row.container} />
          </>
        )}
      </dd>
    </>
  );
}

export function RequestHealthSection(props: DetailsSectionProps) {
  const { clusterId, objectRef, obj } = props;
  const { t } = useTranslation();
  const target = targetOf(objectRef);
  const health = useRequestHealth(clusterId, target);
  const isPod = objectRef.kind.kind === "Pod";
  const amounts = useMemo(() => containerAmounts(obj, isPod), [obj, isPod]);
  const rows = useMemo(() => throttleRows(health.data?.throttling ?? [], amounts), [health.data, amounts]);
  if (!target) return null;

  let body;
  if (health.error) body = <ErrorState error={health.error} />;
  else if (!health.data) body = <p className="rh-note">{t("requesthealth:loading")}</p>;
  else {
    const data = health.data;
    const failed = data.failed.map((kind) => sourceName(t, kind));
    body = (
      <>
        {data.golden.length === 0 && <Missing clusterId={clusterId} health={data} />}
        {data.golden.map((golden) => (
          <Golden key={golden.source} golden={golden} />
        ))}
        {failed.length > 0 && (
          <p className="rh-note" role="status">
            {t("requesthealth:failed", { sources: formatList(failed) })}
          </p>
        )}
        <Throttling health={data} rows={rows} {...props} />
      </>
    );
  }
  return (
    <section className="rh-section" aria-label={t("requesthealth:title")} {...{ [SECTION_ATTRIBUTE]: SECTION_ID }}>
      <h3 className="rh-section__title" tabIndex={-1}>
        {t("requesthealth:title")}
      </h3>
      {body}
    </section>
  );
}
