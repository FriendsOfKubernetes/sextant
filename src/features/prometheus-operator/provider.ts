// The cross-object part of the problems category "Prometheus Operator" (opt-in: monitors and their targets are listed
// only while the user has it on): while the problems store holds its source (the
// problems screen, the section counter or the notifications look at a cluster that serves ServiceMonitors), the
// monitors are held (store.ts) and each one that selects nothing, or that no Prometheus picks up, becomes a problem of
// that monitor. Prometheus and Alertmanager readiness come from the category's watched sources (problems/model.ts).
import type { Problem } from "../problems/model";
import { registerProblemProvider } from "../problems/store";
import { acquireMonitoring, getMonitoring, subscribeMonitoring, type MonitorFinding } from "./store";

/** The store's problems of the findings; `firstSeen` keeps when each was first seen. */
export function toProblems(findings: readonly MonitorFinding[], firstSeen: Map<string, number>, now: number): Problem[] {
  const keys = new Set<string>();
  const out: Problem[] = [];
  const add = (f: MonitorFinding, reason: string, messageKey: string, notify: boolean, lists?: Record<string, string[]>) => {
    const key = `${f.uid}|${reason}`;
    keys.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    out.push({
      key,
      notifyKey: key,
      category: "prometheusOperator",
      uid: f.uid,
      object: f.ref,
      reason,
      messageKey,
      messageLists: lists,
      notify,
      firstSeen: first,
      activeAt: first,
    });
  };
  for (const f of findings) {
    if (f.selected === 0) {
      const service = f.ref.kind.kind === "ServiceMonitor";
      add(f, "SelectsNothing", service ? "messages.serviceMonitorSelectsNothing" : "messages.podMonitorSelectsNothing", true, {
        namespaces: f.namespaces ?? [],
      });
    }
    // A warning: the monitor may be meant for another collector (a PrometheusAgent elsewhere, VictoriaMetrics, …).
    if (f.pickedBy && f.pickedBy.length === 0) add(f, "NotPickedUp", "messages.monitorNotPickedUp", false);
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
}

registerProblemProvider("prometheusOperator", (clusterId, set) => {
  const firstSeen = new Map<string, number>();
  const release = acquireMonitoring(clusterId);
  let last: unknown;
  const look = () => {
    // The store keeps one state object until its inputs change: the same object is the same findings.
    const state = getMonitoring(clusterId);
    if (state === last) return;
    last = state;
    if (state.loading) set({ status: "loading", problems: [] });
    else
      set({
        status: "ready",
        problems: toProblems(state.findings, firstSeen, Date.now()),
      });
  };
  const unsubscribe = subscribeMonitoring(look);
  look();
  return () => {
    unsubscribe();
    release();
  };
});
