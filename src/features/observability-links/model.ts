// Which links an object or a traffic edge gets (#266): the cluster's settings (`clusters[id].observabilityLinks`), the
// values of the object, and the filled templates. Pure; the links are opened by the caller through `api.shell.openUrl`.
import type { AppSettings, ClusterId, KindRef, KubeObject, TrafficPeer } from "../../api";
import type { ObservabilityLinks } from "../../api/generated/ObservabilityLinks";
import { checkBaseUrl, fillTemplate, type DashboardTarget, type Values } from "./template";

/** How far back a link's time window reaches. */
export const WINDOW_MS = 60 * 60 * 1000;

const WORKLOADS = new Map<string, string>([
  ["apps/Deployment", "deployment"],
  ["apps/StatefulSet", "statefulset"],
  ["apps/DaemonSet", "daemonset"],
  ["apps/ReplicaSet", "replicaset"],
  ["batch/Job", "job"],
  ["batch/CronJob", "cronjob"],
]);

/** The dashboard target of a kind, or null for a kind without links. */
export function targetOf(kind: KindRef): DashboardTarget | null {
  if (WORKLOADS.has(`${kind.group}/${kind.kind}`)) return "workload";
  if (kind.group !== "") return null;
  if (kind.kind === "Pod") return "pod";
  if (kind.kind === "Node") return "node";
  if (kind.kind === "Namespace") return "namespace";
  return null;
}

export function linksOf(settings: AppSettings | null, clusterId: ClusterId): ObservabilityLinks | null {
  return settings?.clusters[clusterId]?.observabilityLinks ?? null;
}

function base(text: string | null | undefined): string | null {
  if (!text) return null;
  const checked = checkBaseUrl(text);
  return "url" in checked ? checked.url : null;
}

/** The time window ending at `now`, in milliseconds since the epoch (as Grafana's `from`/`to` take it). */
export function windowValues(now: number): Values {
  return { from: String(now - WINDOW_MS), to: String(now) };
}

type Labels = Record<string, string> | undefined;

function serviceFrom(labels: Labels, fallback: string): string {
  return labels?.["app.kubernetes.io/name"] ?? labels?.app ?? fallback;
}

/** The values an object fills: its names, its kind in lower case (as the mixin's `workload_type`), its window. */
export function objectValues(kind: KindRef, obj: KubeObject, target: DashboardTarget, now: number): Values {
  const meta = obj.metadata ?? {};
  const name = typeof meta.name === "string" ? meta.name : "";
  const values: Values = { name, ...windowValues(now) };
  const spec = (obj as { spec?: Record<string, unknown> }).spec;
  if (target === "workload") {
    values.namespace = meta.namespace;
    values.kind = WORKLOADS.get(`${kind.group}/${kind.kind}`);
    const template = spec?.template as { metadata?: { labels?: Labels } } | undefined;
    values.service = serviceFrom(template?.metadata?.labels ?? (meta.labels as Labels), name);
  } else if (target === "pod") {
    values.namespace = meta.namespace;
    values.kind = "pod";
    values.pod = name;
    values.service = serviceFrom(meta.labels as Labels, name);
    const containers = (spec?.containers as { name?: string }[] | undefined) ?? [];
    if (containers.length === 1 && containers[0]?.name) values.container = containers[0].name;
    if (typeof spec?.nodeName === "string") values.node = spec.nodeName;
  } else if (target === "node") {
    values.kind = "node";
    values.node = name;
  } else if (target === "namespace") {
    values.kind = "namespace";
    values.namespace = name;
  }
  return values;
}

/** The values of a traffic edge: both ends' names, the destination's namespace and name as the service. */
export function edgeValues(from: TrafficPeer, to: TrafficPeer, now: number): Values {
  const values: Values = windowValues(now);
  if (from.name) values.source = from.name;
  if (to.name) {
    values.destination = to.name;
    values.service = to.name;
  }
  if (to.namespace) values.namespace = to.namespace;
  return values;
}

export interface ObjectLinks {
  dashboard: string | null;
  traces: string | null;
}

/** The dashboard and trace links of a target with these values; each null when not configured or not fillable. */
export function buildLinks(links: ObservabilityLinks | null, target: DashboardTarget, values: Values): ObjectLinks {
  if (!links) return { dashboard: null, traces: null };
  const grafana = base(links.grafanaUrl);
  const dashboard = fillTemplate(grafana, links.dashboards?.[target], target, values);
  // Node and namespace links have no service to search traces by.
  const tracesBase = base(links.tracesUrl) ?? grafana;
  const traces = target === "node" || target === "namespace" ? null : fillTemplate(tracesBase, links.traces, "traces", values);
  return { dashboard, traces };
}
