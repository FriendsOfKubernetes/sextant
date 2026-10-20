// The request health of one details object, through the metrics feature's shared pollers: one `metrics_request_health`
// call per (cluster, Prometheus settings, target) a minute, only while a section shows it, stopped when the last one
// unmounts (and forgotten soon after, `IDLE_TTL_MS`).
import { api, type ClusterId, type RequestHealth, type RequestTarget } from "../../api";
import { useMetricsSettings, usePolled, type Polled } from "../metrics/hooks";

/** The core reads the last 5 minutes and the last hour at one point a minute: a minute between reads is enough. */
export const REQUEST_HEALTH_POLL_MS = 60_000;

export function useRequestHealth(clusterId: ClusterId, target: RequestTarget | null): Polled<RequestHealth> {
  const settings = useMetricsSettings(clusterId);
  const key =
    settings && target ? `requests|${clusterId}|${JSON.stringify(settings.prometheus)}|${JSON.stringify(target)}` : null;
  return usePolled(key, () => api.metrics.requestHealth(clusterId, target!), REQUEST_HEALTH_POLL_MS);
}

/** Section marker, so another section (the Linkerd block) can bring this one into view. */
export const SECTION_ATTRIBUTE = "data-details-section";
export const SECTION_ID = "requestHealth";

/** Scrolls the "Requests" section of the details panel that holds `from` into view and focuses its heading. */
export function revealRequestHealth(from: Element): void {
  let scope: Element | null = from.parentElement;
  let section: HTMLElement | null = null;
  while (scope && !section) {
    section = scope.querySelector<HTMLElement>(`[${SECTION_ATTRIBUTE}="${SECTION_ID}"]`);
    scope = scope.parentElement;
  }
  if (!section) return;
  section.scrollIntoView?.({ block: "start", behavior: "smooth" });
  section.querySelector<HTMLElement>("h3")?.focus();
}
