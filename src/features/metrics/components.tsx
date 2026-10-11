// Building blocks shared by the table columns, the details section and the cluster overview.
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ChartTarget, ClusterId, MetricsStatus, Series } from "../../api";
import { ErrorState } from "../../components";
import { openClusterSettings } from "../clusters/clustersStore";
import { Chart } from "./Chart";
import { formatBytes, formatCount, formatCpu } from "./format";
import { useCharts, type Polled } from "./hooks";
import "./metrics.css";

export type MetricName = "cpu" | "memory" | "pods" | "disk";

const COLORS: Record<MetricName, string> = {
  cpu: "#3d90ce",
  memory: "#a05ad0",
  pods: "#48a868",
  disk: "#d6a01e",
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
    openClusterSettings(clusterId);
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

/** Charts of the last hour for `target`; a note when there is no Prometheus. */
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
