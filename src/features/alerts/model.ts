// Alerts on objects (#264, ADR-0119): which object an alert is about, read from its labels, and the grouping, filters
// and counts of the views. Pure functions.
//
// The labels are the ones kube-state-metrics, the kubelet/cAdvisor and the kube-prometheus rules put on alerts:
// `pod`, `deployment`, `statefulset`, `daemonset`, `replicaset`, `job_name` (kube-state-metrics' name for a Job: `job`
// is Prometheus' scrape job), `cronjob`, `horizontalpodautoscaler`, `persistentvolumeclaim` and `service`, each with
// the alert's `namespace`; `persistentvolume` and `node` (cluster-scoped); `namespace` alone names the Namespace. The
// first label of that order that is set is the alert's object (a pod before its workload, so an alert is shown once on
// what it is about; the workload's details also list the alerts of its own pods).
//
// Labels of the scrape target leak in (#264 review). kube-prometheus-stack scrapes kube-state-metrics with
// `honorLabels: true` and no relabelling (its values.yaml, `kube-state-metrics.prometheus.monitor`), and
// prometheus-operator puts the target's `namespace`, `service`, `pod`, `container` and `endpoint` on every series:
// a series of kube-state-metrics that has no `pod` of its own (`kube_deployment_*`, `kube_node_*`) carries the
// kube-state-metrics pod, and one without a `namespace` (`kube_node_*`, `kube_persistentvolume_*`) carries the
// namespace kube-state-metrics runs in. node-exporter's series (`job="node-exporter"`) never have a pod or namespace
// of their own, so theirs are always the exporter's. (kube-prometheus' own ServiceMonitor drops them:
// `labeldrop (pod|service|endpoint|namespace)`, and sets node-exporter's `instance` to the node name.) So, on alerts of
// those exporters (`job`, else `service`, naming them):
// - `pod` is skipped when it is the scrape target — node-exporter's always; kube-state-metrics' when a workload, HPA,
//   PVC, PV or node label is set, when `container` is the exporter's, or when the pod is named after the `service` —
//   unless `uid` is set (kube-state-metrics' pod series carry the pod's uid: their `pod` is their own);
// - `service` is skipped unless the alert names no pod and no instance (TargetDown is aggregated by job, namespace and
//   service: its Service is the target's own);
// - node-exporter's `namespace` is never the object's: such an alert names its Node by `node`, or by an `instance`
//   without a port (kube-prometheus' relabelling), and otherwise nothing.
// An alert whose pod was skipped and that names a node maps to the Node, never to the scraper's namespace.
import type { Alert, AlertState, KindRef, ObjectRef } from "../../api";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });
export const POD = k("", "v1", "Pod");
export const NODE = k("", "v1", "Node");
export const SERVICE = k("", "v1", "Service");
export const NAMESPACE = k("", "v1", "Namespace");
export const PVC = k("", "v1", "PersistentVolumeClaim");
export const PV = k("", "v1", "PersistentVolume");
export const DEPLOYMENT = k("apps", "v1", "Deployment");
export const STATEFULSET = k("apps", "v1", "StatefulSet");
export const DAEMONSET = k("apps", "v1", "DaemonSet");
export const REPLICASET = k("apps", "v1", "ReplicaSet");
export const JOB = k("batch", "v1", "Job");
export const CRONJOB = k("batch", "v1", "CronJob");
export const HPA = k("autoscaling", "v2", "HorizontalPodAutoscaler");

/** Label → kind of the object it names (namespaced ones need the alert's `namespace`), in order of preference. */
export const TARGET_LABELS: ReadonlyArray<readonly [string, KindRef]> = [
  ["pod", POD],
  ["deployment", DEPLOYMENT],
  ["statefulset", STATEFULSET],
  ["daemonset", DAEMONSET],
  ["replicaset", REPLICASET],
  ["job_name", JOB],
  ["cronjob", CRONJOB],
  ["horizontalpodautoscaler", HPA],
  ["persistentvolumeclaim", PVC],
  ["persistentvolume", PV],
  ["node", NODE],
  ["service", SERVICE],
];

/** The kinds that get the "Alerts" details section. */
export const ALERT_KINDS: readonly KindRef[] = [...TARGET_LABELS.map(([, kind]) => kind), NAMESPACE];

/** Cluster-scoped kinds among the targets. */
const CLUSTER_SCOPED: readonly KindRef[] = [NODE, PV];

type Exporter = "kubeStateMetrics" | "nodeExporter" | "kubelet";

/** The exporter whose series the alert was computed from, by its scrape `job`, else by its `service`. */
function exporterOf(labels: Record<string, string>): Exporter | null {
  const of = (text: string | undefined): Exporter | null => {
    if (!text) return null;
    if (/kube-state-metrics/.test(text)) return "kubeStateMetrics";
    if (/node-exporter/.test(text)) return "nodeExporter";
    if (/^kubelet$|-kubelet$/.test(text)) return "kubelet";
    return null;
  };
  return of(labels.job) ?? of(labels.service);
}

/** Labels that name an object other than a pod (a kube-state-metrics series with one of them has no pod of its own). */
const OBJECT_LABELS = TARGET_LABELS.filter(([, kind]) => kind !== POD && kind !== SERVICE).map(([label]) => label);

const SCRAPER_CONTAINER = /^(kube-state-metrics|node-exporter)$/;

/** Whether the alert's `pod` is the scrape target's, not what the alert is about (see the header). */
function podIsScraper(labels: Record<string, string>, exporter: Exporter | null): boolean {
  const pod = labels.pod?.trim();
  if (!pod) return false;
  if (exporter === "nodeExporter") return true;
  if (exporter !== "kubeStateMetrics" || labels.uid?.trim()) return false;
  if (OBJECT_LABELS.some((label) => labels[label]?.trim())) return true;
  if (SCRAPER_CONTAINER.test(labels.container?.trim() ?? "")) return true;
  const service = labels.service?.trim();
  return !!service && pod.startsWith(`${service}-`);
}

/** A node name in node-exporter's `instance` (kube-prometheus sets it so): a DNS name without a port. */
function nodeOfInstance(instance: string | undefined): string | null {
  const name = instance?.trim() ?? "";
  return name.length <= 253 && /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(name) ? name : null;
}

/** The pod an alert is about, `null` when it names none or only the scrape target's (see the header). */
export function alertPod(alert: Pick<Alert, "labels">): string | null {
  const { labels } = alert;
  const pod = labels.pod?.trim();
  if (!pod || !labels.namespace?.trim() || podIsScraper(labels, exporterOf(labels))) return null;
  return pod;
}

/** The object an alert is about (see the header); `null` when its labels name none. */
export function alertTarget(alert: Pick<Alert, "labels">): ObjectRef | null {
  const { labels } = alert;
  const exporter = exporterOf(labels);
  const skipPod = podIsScraper(labels, exporter);
  // node-exporter's namespace is always its own.
  const namespace = exporter === "nodeExporter" ? null : labels.namespace?.trim() || null;
  const keepService = !exporter || (!labels.pod?.trim() && !labels.instance?.trim());
  for (const [label, kind] of TARGET_LABELS) {
    const name = labels[label]?.trim();
    if (!name) continue;
    if (kind === POD && skipPod) continue;
    if (CLUSTER_SCOPED.includes(kind)) return { kind, namespace: null, name };
    if (!namespace) continue;
    if (kind === SERVICE && !keepService) continue;
    return { kind, namespace, name };
  }
  if (exporter === "nodeExporter") {
    const node = nodeOfInstance(labels.instance);
    return node ? { kind: NODE, namespace: null, name: node } : null;
  }
  return namespace ? { kind: NAMESPACE, namespace: null, name: namespace } : null;
}

/**
 * React keys for a list of alerts: origin and id, made unique by a counter where two alerts share them (the core makes
 * ids unique within a report; this keeps a list correct whatever it is given).
 */
export function alertKeys(alerts: readonly Pick<Alert, "origin" | "id">[]): string[] {
  const seen = new Map<string, number>();
  return alerts.map((a) => {
    const base = `${a.origin}|${a.id}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

/** The key of an object in an index of alerts. */
export function targetKey(ref: Pick<ObjectRef, "namespace" | "name"> & { kind: Pick<KindRef, "group" | "kind"> }): string {
  return `${ref.kind.group}/${ref.kind.kind}|${ref.namespace ?? ""}|${ref.name}`;
}

/** Where to find alerts fast: by their object, and by the pod they name (for a workload's own pods). */
export interface AlertIndex {
  byTarget: ReadonlyMap<string, readonly Alert[]>;
  /** `namespace/pod`. */
  byPod: ReadonlyMap<string, readonly Alert[]>;
}

export function indexAlerts(alerts: readonly Alert[]): AlertIndex {
  const byTarget = new Map<string, Alert[]>();
  const byPod = new Map<string, Alert[]>();
  const push = (map: Map<string, Alert[]>, key: string, alert: Alert) => {
    const list = map.get(key);
    if (list) list.push(alert);
    else map.set(key, [alert]);
  };
  for (const alert of alerts) {
    const target = alertTarget(alert);
    if (target) push(byTarget, targetKey(target), alert);
    const pod = alertPod(alert);
    if (pod) push(byPod, `${alert.labels.namespace!.trim()}/${pod}`, alert);
  }
  return { byTarget, byPod };
}

/** The alerts of `ref`, and for a workload also those of `podNames` (its own pods), each once. */
export function alertsOf(index: AlertIndex, ref: ObjectRef, podNames: readonly string[] = []): Alert[] {
  const own = index.byTarget.get(targetKey(ref)) ?? [];
  if (podNames.length === 0) return [...own];
  const seen = new Set<Alert>(own);
  const out = [...own];
  for (const pod of podNames) {
    for (const alert of index.byPod.get(`${ref.namespace ?? ""}/${pod}`) ?? []) {
      if (seen.has(alert)) continue;
      seen.add(alert);
      out.push(alert);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Severities, grouping and filters

/** The order of severities, as the core sorts them: the usual names first, then any other, then none. */
export function severityRank(severity: string | null): number {
  switch (severity) {
    case "critical":
      return 0;
    case "error":
    case "high":
      return 1;
    case "warning":
    case "medium":
      return 2;
    case "info":
    case "low":
      return 3;
    case "none":
    case null:
      return 5;
    default:
      return 4;
  }
}

/** The severity as a group key: `""` for none. */
export const severityOf = (alert: Pick<Alert, "severity">): string => alert.severity ?? "";

export const STATES: readonly AlertState[] = ["firing", "pending", "silenced", "inhibited"];

export interface AlertFilter {
  /** `null`: every severity; `""`: alerts without one. */
  severity: string | null;
  namespace: string | null;
  state: AlertState | null;
  search: string;
}

export const NO_FILTER: AlertFilter = { severity: null, namespace: null, state: null, search: "" };

export function matches(alert: Alert, filter: AlertFilter): boolean {
  if (filter.severity !== null && severityOf(alert) !== filter.severity) return false;
  if (filter.namespace !== null && (alert.labels.namespace ?? "") !== filter.namespace) return false;
  if (filter.state !== null && alert.state !== filter.state) return false;
  const words = filter.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [alert.name, alert.summary ?? "", alert.description ?? "", ...Object.entries(alert.labels).map(([k, v]) => `${k}=${v}`)]
    .join("\n")
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}

export interface NameGroup {
  name: string;
  alerts: Alert[];
}

export interface SeverityGroup {
  severity: string;
  count: number;
  names: NameGroup[];
}

/** Alerts grouped by severity (most severe first), then by alert name; each list in the order given. */
export function groupAlerts(alerts: readonly Alert[]): SeverityGroup[] {
  const groups = new Map<string, Map<string, Alert[]>>();
  for (const alert of alerts) {
    const severity = severityOf(alert);
    let names = groups.get(severity);
    if (!names) groups.set(severity, (names = new Map()));
    const list = names.get(alert.name);
    if (list) list.push(alert);
    else names.set(alert.name, [alert]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => severityRank(a || null) - severityRank(b || null) || a.localeCompare(b))
    .map(([severity, names]) => ({
      severity,
      count: [...names.values()].reduce((n, list) => n + list.length, 0),
      names: [...names.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, list]) => ({ name, alerts: list })),
    }));
}

/** The severities and namespaces present, for the filters. */
export function choices(alerts: readonly Alert[]): { severities: string[]; namespaces: string[] } {
  const severities = new Set<string>();
  const namespaces = new Set<string>();
  for (const alert of alerts) {
    severities.add(severityOf(alert));
    if (alert.labels.namespace) namespaces.add(alert.labels.namespace);
  }
  return {
    severities: [...severities].sort((a, b) => severityRank(a || null) - severityRank(b || null) || a.localeCompare(b)),
    namespaces: [...namespaces].sort((a, b) => a.localeCompare(b)),
  };
}

/** The labels worth showing on a row: all but the name and severity, which the grouping shows. */
export function shownLabels(alert: Pick<Alert, "labels">): Array<[string, string]> {
  return Object.entries(alert.labels).filter(([k]) => k !== "alertname" && k !== "severity");
}

/** Whether an alert is still active for the views' counts (firing or pending). */
export const isActive = (alert: Pick<Alert, "state">): boolean => alert.state === "firing" || alert.state === "pending";
