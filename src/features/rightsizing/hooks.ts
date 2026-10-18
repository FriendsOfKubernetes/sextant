// Data of the right-sizing views: which source there is (Prometheus history, a metrics-server snapshot, nothing) and
// its values, through the metrics feature's shared pollers. History is fetched only when Prometheus answers and is
// refreshed every five minutes while shown; the snapshot is fetched only when there is no history.
import { useMemo } from "react";
import type { ClusterId, HistoryScope, HistoryWindow, UsageHistory } from "../../api";
import { api, type ApiError } from "../../api";
import { useMetricsSettings, useMetricsStatus, usePodUsage, usePolled, type Polled } from "../metrics/hooks";
import type { UsageSourceData } from "./group";

/** At most this many containers come with a history (`MAX_HISTORY_CONTAINERS` in the core). */
export const MAX_HISTORY_CONTAINERS = 5000;
/** History changes slowly: refreshed this often while shown. */
export const HISTORY_POLL_MS = 5 * 60_000;

export function useUsageHistory(
  clusterId: ClusterId,
  scope: HistoryScope | null,
  window: HistoryWindow,
  enabled: boolean,
): Polled<UsageHistory> {
  const settings = useMetricsSettings(clusterId);
  const key =
    enabled && settings && scope
      ? `rightsizing|${clusterId}|${JSON.stringify(settings.prometheus)}|${JSON.stringify(scope)}|${window}`
      : null;
  return usePolled(key, () => api.metrics.usageHistory(clusterId, scope!, window), HISTORY_POLL_MS);
}

export type SourceMode = "history" | "snapshot" | "none";

export interface RightsizingSource {
  /** `undefined` while the metrics status is not known. */
  mode: SourceMode | undefined;
  data: UsageSourceData;
  loading: boolean;
  /** The history failed (the rows fall back to the snapshot when metrics-server is there). */
  error: ApiError | null;
  truncated: boolean;
}

const NONE: UsageSourceData = { kind: "none" };

/**
 * The usage to set the rows against. `scope` is the history's scope; the snapshot is the selected namespaces' current
 * usage (`usePodUsage`). `data` keeps its identity while the values do not change.
 */
export function useRightsizingSource(clusterId: ClusterId, scope: HistoryScope | null, window: HistoryWindow): RightsizingSource {
  const status = useMetricsStatus(clusterId);
  const s = status.data;
  const hasHistory = !!s?.prometheus;
  const history = useUsageHistory(clusterId, scope, window, hasHistory);
  const snapshotWanted = !!s && !!s.effectiveUsageSource && (!hasHistory || history.error !== null);
  const snapshot = usePodUsage(clusterId, snapshotWanted);
  const historyData = hasHistory && !history.error ? history.data : null;
  const snapshotData = snapshotWanted ? snapshot.data : null;
  const data = useMemo<UsageSourceData>(() => {
    if (historyData) return { kind: "history", history: historyData };
    if (snapshotData) return { kind: "snapshot", pods: snapshotData };
    return NONE;
  }, [historyData, snapshotData]);

  if (!s) return { mode: status.error ? "none" : undefined, data, loading: status.loading, error: null, truncated: false };
  if (historyData) return { mode: "history", data, loading: false, error: null, truncated: historyData.truncated };
  if (hasHistory && history.loading) return { mode: "history", data, loading: true, error: null, truncated: false };
  const error = hasHistory ? history.error : null;
  if (snapshotWanted) return { mode: "snapshot", data, loading: snapshot.loading, error, truncated: false };
  return { mode: hasHistory ? "history" : "none", data, loading: false, error, truncated: false };
}
