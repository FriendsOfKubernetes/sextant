// The traffic graph of the namespaces in view, through the metrics feature's shared pollers: one
// `metrics_traffic_graph` call per (cluster, Prometheus settings, namespaces, window) every `TRAFFIC_POLL_MS`, only
// while the "Traffic" mode is shown and the window is visible (a hidden window stops polling; showing it again asks
// at once when the value is older than the interval), stopped when the mode is left.
import { useSyncExternalStore } from "react";
import { api, type ClusterId, type TrafficGraph, type TrafficWindow } from "../../../api";
import { useMetricsSettings, usePolled, type Polled } from "../../metrics/hooks";

/** Rates over 5 minutes are worth reading twice a minute; hourly averages once a minute. */
export const TRAFFIC_POLL_MS: Record<TrafficWindow, number> = { minutes5: 30_000, hour1: 60_000 };

function subscribeVisibility(notify: () => void): () => void {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}

const visibleNow = () => document.visibilityState !== "hidden";

/** Whether the window is visible (not minimized, not behind another tab of the OS, not hidden to the tray). */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, visibleNow, () => true);
}

export function useTrafficGraph(
  clusterId: ClusterId,
  namespaces: readonly string[],
  window: TrafficWindow,
): Polled<TrafficGraph> {
  const settings = useMetricsSettings(clusterId);
  const visible = useDocumentVisible();
  const list = [...namespaces];
  const key =
    settings && visible && list.length > 0
      ? `traffic|${clusterId}|${JSON.stringify(settings.prometheus)}|${list.join(",")}|${window}`
      : null;
  return usePolled(key, () => api.metrics.trafficGraph(clusterId, list, window), TRAFFIC_POLL_MS[window]);
}
