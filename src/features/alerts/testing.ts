// Test helpers of the alerts feature: alerts and reports shaped as `alerts_list` returns them for the core's fixtures
// (kube-prometheus rules as Prometheus and Alertmanager report them).
import type { Alert, AlertsReport } from "../../api";

export function alert(patch: Partial<Alert> = {}): Alert {
  return {
    id: "1a2b3c4d5e6f7081",
    name: "KubePodCrashLooping",
    state: "firing",
    severity: "warning",
    labels: {
      alertname: "KubePodCrashLooping",
      container: "api",
      job: "kube-state-metrics",
      namespace: "shop",
      pod: "api-7d9c8b6f5d-x2x4q",
      service: "kps-kube-state-metrics",
      severity: "warning",
    },
    summary: "Pod is crash looping.",
    description: "Pod shop/api-7d9c8b6f5d-x2x4q (api) is in waiting state.",
    annotations: [],
    links: [{ key: "runbook_url", url: "https://runbooks.prometheus-operator.dev/runbooks/kubernetes/kubepodcrashlooping", cleaned: false }],
    activeAt: "2026-10-24T08:00:30.000Z",
    origin: "alertmanager",
    silencedBy: [],
    inhibitedBy: [],
    ...patch,
  };
}

export const NODE_ALERT = alert({
  id: "p0000000000000001",
  name: "KubeNodeNotReady",
  severity: "critical",
  labels: { alertname: "KubeNodeNotReady", node: "worker-2", severity: "critical" },
  summary: "worker-2 has been unready for more than 15 minutes.",
  description: null,
  links: [],
  origin: "prometheus",
});

export const PENDING_ALERT = alert({
  id: "p0000000000000002",
  name: "KubeDeploymentReplicasMismatch",
  state: "pending",
  labels: { alertname: "KubeDeploymentReplicasMismatch", deployment: "web", namespace: "shop", severity: "warning" },
  summary: "Deployment has not matched the expected number of replicas.",
  origin: "prometheus",
});

export const SILENCED_ALERT = alert({
  id: "2b3c4d5e6f708192",
  name: "TargetDown",
  state: "silenced",
  labels: { alertname: "TargetDown", job: "metrics", namespace: "shop", service: "metrics", severity: "warning" },
  summary: "One or more targets are unreachable.",
  description: null,
  links: [],
  silencedBy: ["5f1c0a2e"],
});

export const WATCHDOG = alert({
  id: "4d5e6f708192a3b4",
  name: "Watchdog",
  severity: "none",
  labels: { alertname: "Watchdog", severity: "none" },
  summary: null,
  description: null,
  links: [],
});

export function report(patch: Partial<AlertsReport> = {}): AlertsReport {
  const alerts = [NODE_ALERT, PENDING_ALERT, alert(), SILENCED_ALERT, WATCHDOG];
  return {
    prometheus: { status: "ok", target: "monitoring/prometheus-operated:9090", kind: "prometheus", error: null },
    alertmanager: { status: "ok", target: "monitoring/alertmanager-operated:9093", error: null },
    alerts,
    totalAlerts: alerts.length,
    truncated: false,
    silences: [
      {
        id: "5f1c0a2e",
        state: "active",
        matchers: [
          { name: "alertname", value: "TargetDown", isRegex: false, isEqual: true },
          { name: "namespace", value: "shop|cart", isRegex: true, isEqual: true },
        ],
        startsAt: "2026-10-24T08:00:00.000Z",
        endsAt: "2026-10-24T12:00:00.000Z",
        createdBy: "alice",
        comment: "Maintenance of the metrics exporter",
      },
    ],
    expiredSilences: 1,
    ...patch,
  };
}
