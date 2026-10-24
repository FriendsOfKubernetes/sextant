// The source of the opt-in problems category `alerts` (#264): while the problems store holds it (the category is on
// and a problems screen, the Cluster counter or the notifications look at the cluster), the cluster's alerts are
// polled (shared with the Alerts page and the details, store.ts) and every firing `critical` or `warning` alert
// becomes a problem of the object its labels name, else of its namespace; an alert naming neither is left to the
// Alerts page. Pending, silenced and inhibited alerts are never problems. Only `critical` ones notify by default.
import type { Alert } from "../../api";
import { registerProblemProvider } from "../problems/store";
import type { Problem } from "../problems/model";
import { alertTarget, targetKey } from "./model";
import { acquireAlerts, getAlerts, subscribeAlerts } from "./store";

/** The severities that are problems. */
export const PROBLEM_SEVERITIES = new Set(["critical", "warning"]);

/** The problems of `alerts`; `firstSeen` keeps when each was first seen (by key) between calls. */
export function alertProblems(alerts: readonly Alert[], firstSeen: Map<string, number>, now: number): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const alert of alerts) {
    if (alert.state !== "firing" || !PROBLEM_SEVERITIES.has(alert.severity ?? "")) continue;
    const object = alertTarget(alert);
    if (!object) continue;
    const uid = `alerts:${targetKey(object)}`;
    const key = `${uid}|${alert.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    const since = alert.activeAt ? Date.parse(alert.activeAt) : Number.NaN;
    const message = alert.summary ?? alert.description ?? undefined;
    out.push({
      key,
      notifyKey: `${uid}|${alert.name}`,
      category: "alerts",
      uid,
      object,
      reason: alert.name,
      group: alert.name,
      ...(message ? { message } : {}),
      ...(alert.activeAt ? { since: alert.activeAt } : {}),
      notify: alert.severity === "critical",
      firstSeen: first,
      activeAt: Number.isNaN(since) ? first : since,
    });
  }
  for (const key of [...firstSeen.keys()]) if (!seen.has(key)) firstSeen.delete(key);
  return out;
}

registerProblemProvider("alerts", (clusterId, set) => {
  const firstSeen = new Map<string, number>();
  const look = () => {
    const state = getAlerts(clusterId);
    if (!state || state.loading) {
      set({ status: "loading", problems: [] });
      return;
    }
    if (state.error) {
      set({ status: "error", error: state.error, problems: [] });
      return;
    }
    const report = state.report;
    set({
      status: "ready",
      problems: alertProblems(report?.alerts ?? [], firstSeen, Date.now()),
      truncated: report?.truncated ?? false,
    });
  };
  const release = acquireAlerts(clusterId);
  const unsubscribe = subscribeAlerts(look);
  look();
  return () => {
    unsubscribe();
    release();
  };
});
