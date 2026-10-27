// Building blocks shared by the table columns, the details section and the cluster overview.
import { useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ChartTarget, ClusterId, MetricsStatus, Series } from "../../api";
import { ErrorState } from "../../components";
import { openClusterSettings } from "../clusters/clustersStore";
import { Chart } from "./Chart";
import { formatBytes, formatCount, formatCpu } from "./format";
import { acquireHistory, hasHistory, recordSample, targetUsage, useHistoryEpoch, useHistorySeries } from "./history";
import { useCharts, useNodeUsage, usePodUsageIn, type Polled } from "./hooks";
import "./metrics.css";

export type MetricName = "cpu" | "memory" | "pods" | "disk";

// Theme tokens (src/styles/global.css): each line keeps 3:1 against the panel in both themes.
const COLORS: Record<MetricName, string> = {
  cpu: "--color-chart-cpu",
  memory: "--color-chart-memory",
  pods: "--color-chart-pods",
  disk: "--color-chart-disk",
};

const FORMATS: Record<MetricName, (v: number) => string> = {
  cpu: formatCpu,
  memory: formatBytes,
  pods: formatCount,
  disk: formatBytes,
};

/** Current values are unavailable: no source in the status, or the last request failed. */
export function usageUnavailable(status: Polled<MetricsStatus>, usage: Polled<unknown>): boolean {
  return (status.data !== null && status.data.effectiveUsageSource === null) || status.error !== null || usage.error !== null;
}

/** Nothing at all: neither current values nor Prometheus. */
export function nothingAvailable(status: Polled<MetricsStatus>): boolean {
  return status.error !== null || (status.data !== null && status.data.effectiveUsageSource === null && status.data.prometheus === null);
}

function openSettings(clusterId: ClusterId) {
  return (e: MouseEvent) => {
    e.stopPropagation();
    openClusterSettings(clusterId, "metrics");
  };
}

/** "Metrics are unavailable" with a link to the cluster settings. */
export function MetricsUnavailable({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  return (
    <div className="mx-unavailable" role="status">
      <span>{t("metrics:unavailable")}</span>
      <button type="button" className="mx-link" onClick={openSettings(clusterId)}>
        {t("metrics:openSettings")}
      </button>
    </div>
  );
}

/** A table cell without a value: "n/a", which opens the cluster settings. */
export function UnavailableCell({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="mx-link mx-na" title={t("metrics:unavailable")} onClick={openSettings(clusterId)}>
      {t("metrics:na")}
    </button>
  );
}

/** A horizontal bar with a percentage. */
export function UsageBar({ percent, label, title }: { percent: number | undefined; label: string; title?: string }) {
  return (
    <span className="mx-usage" title={title}>
      <span className="mx-bar" aria-hidden>
        <span className="mx-bar__fill" style={{ width: `${percent ?? 0}%` }} />
      </span>
      <span className="mx-usage__text">{label}</span>
    </span>
  );
}

/**
 * Charts of the last hour for `target` from the Prometheus-compatible source; without one, a pod's, a workload's or a
 * node's from metrics-server since the chart was opened (`HistoryCharts`); a note when neither is there.
 */
export function ChartGrid({
  clusterId,
  target,
  status,
  metrics,
}: {
  clusterId: ClusterId;
  target: ChartTarget;
  status: MetricsStatus;
  metrics: MetricName[];
}) {
  const { t } = useTranslation();
  const prometheus = status.prometheus !== null;
  const charts = useCharts(clusterId, target, prometheus);

  // The cluster overview keeps asking for Prometheus: its charts sum every node, and its usage card shows the present.
  if (!prometheus && status.effectiveUsageSource === "metricsServer" && target.type !== "cluster") {
    return <HistoryCharts clusterId={clusterId} target={target} metrics={metrics} />;
  }
  if (!prometheus) {
    return (
      <div className="mx-note">
        <span>{t("metrics:charts.needPrometheus")}</span>
        <button type="button" className="mx-link" onClick={openSettings(clusterId)}>
          {t("metrics:openSettings")}
        </button>
      </div>
    );
  }
  if (charts.error) return <ErrorState error={charts.error} />;
  if (charts.loading || !charts.data) return <div className="mx-note">{t("metrics:charts.loading")}</div>;
  const shown = metrics
    .map((m) => [m, charts.data!.find((s: Series) => s.metric === m)] as const)
    .filter((entry): entry is readonly [MetricName, Series] => entry[1] !== undefined && entry[1].points.length > 0);
  if (shown.length === 0) return <div className="mx-note">{t("metrics:charts.noData")}</div>;
  return (
    <div className="mx-charts">
      {shown.map(([metric, series]) => (
        <Chart
          key={metric}
          title={t(`metrics:charts.${metric}`)}
          points={series.points}
          format={FORMATS[metric]}
          color={COLORS[metric]}
        />
      ))}
    </div>
  );
}

/** Metrics metrics-server reports, the only ones a chart without Prometheus can draw. */
const SAMPLED: readonly MetricName[] = ["cpu", "memory"];

/**
 * Charts of `target` from metrics-server (#280, ADR-0125): the current values the window polls anyway, sampled into a
 * bounded ring (`history.ts`) while the chart is shown, so they start when the view is opened (or a little earlier, when
 * it was shown recently). CPU and memory only: metrics-server reports nothing else.
 */
export function HistoryCharts({
  clusterId,
  target,
  metrics,
}: {
  clusterId: ClusterId;
  target: ChartTarget;
  metrics: MetricName[];
}) {
  const { t } = useTranslation();
  const key = JSON.stringify(target);
  const ofPods = target.type === "pod" || target.type === "workload";
  const namespaces = ofPods ? [target.namespace] : null;
  const pods = usePodUsageIn(clusterId, namespaces, ofPods);
  const nodes = useNodeUsage(clusterId, !ofPods);
  const [room, setRoom] = useState(true);
  // A connection that came or went dropped the cluster's rings (and moved the epoch): hold a new one.
  const epoch = useHistoryEpoch(clusterId);
  useEffect(() => {
    const release = acquireHistory(clusterId, key);
    setRoom(hasHistory(clusterId, key));
    return release;
  }, [clusterId, key, epoch]);
  const answer = ofPods ? pods.data : nodes.data;
  useEffect(() => {
    if (!answer) return;
    recordSample(clusterId, key, answer, targetUsage(target, pods.data, nodes.data));
    // `target` is `key`; the answer is what moves.
  }, [clusterId, key, answer]);
  const series = useHistorySeries(clusterId, key);
  const error = ofPods ? pods.error : nodes.error;

  const shown = metrics.filter((m) => SAMPLED.includes(m));
  const note = (
    <div className="mx-note" data-testid="mx-history-note">
      {t("metrics:history.note")}
    </div>
  );
  if (error) return <ErrorState error={error} />;
  if (!room) return <div className="mx-note">{t("metrics:history.full")}</div>;
  if (series.cpu.length === 0) return <div className="mx-note">{t("metrics:history.waiting")}</div>;
  return (
    <>
      {note}
      <div className="mx-charts">
        {shown.map((metric) => (
          <Chart
            key={metric}
            title={t(`metrics:charts.${metric}`)}
            points={metric === "cpu" ? series.cpu : series.memory}
            format={FORMATS[metric]}
            color={COLORS[metric]}
          />
        ))}
      </div>
    </>
  );
}
