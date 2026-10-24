// Cluster overview — the default page of a connected cluster (sidebar section "Cluster"): nodes and pods, workload
// statuses, CPU/memory of the cluster against allocatable capacity, charts of the last hour (with Prometheus) and
// the latest warning events. Pods, workloads and events follow the namespace filter; nodes are cluster-wide.
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec, type WatchState } from "../../api";
import { Age, ErrorState, LoadingIndicator } from "../../components";
import type { PageProps } from "../../layout/pages";
import { status } from "../../resources";
import { byNewest, EVENT_KIND, InvolvedObjectLink } from "../events";
import { eventTimestamp } from "../events/model";
import {
  ChartGrid,
  formatBytes,
  formatCpu,
  MetricsUnavailable,
  nodeAllocatable,
  nothingAvailable,
  percentKey,
  percentOf,
  UsageBar,
  usageUnavailable,
  useMetricsStatus,
  type MetricName,
  useNodeUsage,
} from "../metrics";
import { useSelectedNamespaces } from "../namespaces";
import "./overview.css";

const { arr, get, num, str } = status;

const NODE: KindRef = { group: "", version: "v1", kind: "Node" };
const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const STATEFULSET: KindRef = { group: "apps", version: "v1", kind: "StatefulSet" };
const DAEMONSET: KindRef = { group: "apps", version: "v1", kind: "DaemonSet" };
const JOB: KindRef = { group: "batch", version: "v1", kind: "Job" };

const CLUSTER_CHARTS: MetricName[] = ["cpu", "memory", "pods", "disk"];

/** How many warnings are listed. */
export const WARNING_LIMIT = 10;

const PHASES = ["Running", "Pending", "Succeeded", "Failed", "Unknown"] as const;
type Phase = (typeof PHASES)[number];
type State = "ready" | "pending" | "running" | "succeeded" | "failed";

const TONES: Record<Phase | State, string> = {
  Running: "success",
  ready: "success",
  running: "info",
  Succeeded: "info",
  succeeded: "success",
  Pending: "warning",
  pending: "warning",
  Failed: "danger",
  failed: "danger",
  Unknown: "neutral",
};

function spec(kind: KindRef, namespaces: string[] | null, fieldSelector: string | null = null): WatchSpec {
  return { kind, namespaces: namespaces && namespaces.length > 0 ? namespaces : null, labelSelector: null, fieldSelector };
}

export function podPhase(pod: KubeObject): Phase {
  const phase = str(get(pod, "status", "phase"));
  return (PHASES as readonly string[]).includes(phase ?? "") ? (phase as Phase) : "Unknown";
}

/** Deployments and StatefulSets: all desired replicas ready; DaemonSets: on every scheduled node. */
export function workloadState(obj: KubeObject, kind: string): State {
  if (kind === "Job") {
    const conditions = arr(get(obj, "status", "conditions"));
    const holds = (type: string) => conditions.some((c) => get(c, "type") === type && get(c, "status") === "True");
    if (holds("Complete")) return "succeeded";
    if (holds("Failed")) return "failed";
    return "running";
  }
  if (kind === "DaemonSet") {
    const desired = num(get(obj, "status", "desiredNumberScheduled")) ?? 0;
    return (num(get(obj, "status", "numberReady")) ?? 0) >= desired ? "ready" : "pending";
  }
  const desired = num(get(obj, "spec", "replicas")) ?? 1;
  return (num(get(obj, "status", "readyReplicas")) ?? 0) >= desired ? "ready" : "pending";
}

function nodeReady(node: KubeObject): boolean {
  return arr(get(node, "status", "conditions")).some((c) => get(c, "type") === "Ready" && get(c, "status") === "True");
}

function count<K extends string>(items: KubeObject[], key: (o: KubeObject) => K): Map<K, number> {
  const counts = new Map<K, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

export function OverviewPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const namespaces = useSelectedNamespaces(clusterId);
  if (namespaces === undefined) {
    return (
      <div className="ov">
        <LoadingIndicator className="ov__loading" text={t("metrics:overview.loadingPage")} />
      </div>
    );
  }
  return <Overview clusterId={clusterId} namespaces={namespaces} />;
}

function Overview({ clusterId, namespaces }: { clusterId: ClusterId; namespaces: string[] | null }) {
  const { t } = useTranslation();
  const specs = useMemo(
    () => ({
      nodes: spec(NODE, null),
      pods: spec(POD, namespaces),
      deployments: spec(DEPLOYMENT, namespaces),
      statefulsets: spec(STATEFULSET, namespaces),
      daemonsets: spec(DAEMONSET, namespaces),
      jobs: spec(JOB, namespaces),
      warnings: spec(EVENT_KIND, namespaces, "type=Warning"),
    }),
    [namespaces],
  );
  const nodes = useWatch(clusterId, specs.nodes);
  const pods = useWatch(clusterId, specs.pods);
  const deployments = useWatch(clusterId, specs.deployments);
  const statefulsets = useWatch(clusterId, specs.statefulsets);
  const daemonsets = useWatch(clusterId, specs.daemonsets);
  const jobs = useWatch(clusterId, specs.jobs);
  const warnings = useWatch(clusterId, specs.warnings);

  const nodeList = useMemo(() => [...nodes.items.values()], [nodes.items]);
  const podList = useMemo(() => [...pods.items.values()], [pods.items]);
  const phases = useMemo(() => count(podList, podPhase), [podList]);
  const ready = nodeList.filter(nodeReady).length;

  const workloadRows: { id: string; watch: WatchState; counts: Map<string, number>; states: readonly string[] }[] = [
    { id: "pods", watch: pods, counts: phases, states: PHASES },
    ...(
      [
        ["deployments", deployments, "Deployment"],
        ["statefulsets", statefulsets, "StatefulSet"],
        ["daemonsets", daemonsets, "DaemonSet"],
        ["jobs", jobs, "Job"],
      ] as const
    ).map(([id, watch, kind]) => ({
      id,
      watch,
      counts: count([...watch.items.values()], (o) => workloadState(o, kind)),
      states: kind === "Job" ? (["running", "succeeded", "failed"] as const) : (["ready", "pending"] as const),
    })),
  ];

  return (
    <div className="ov">
      <h2 className="ov__title">{t("metrics:overview.title")}</h2>

      <div className="ov__cards">
        <Card title={t("metrics:overview.nodes")} watch={nodes}>
          <div className="ov__big" data-testid="ov-nodes">
            {nodeList.length}
          </div>
          <div className="ov__sub">{t("metrics:overview.nodesReady", { ready, count: nodeList.length })}</div>
        </Card>
        <Card title={t("metrics:overview.pods")} watch={pods}>
          <div className="ov__big" data-testid="ov-pods">
            {podList.length}
          </div>
          <StateList counts={phases} states={PHASES} label={(s) => t(`metrics:overview.phase.${s}`)} />
        </Card>
        <UsageCard clusterId={clusterId} nodes={nodeList} />
      </div>

      <section className="ov__section" aria-label={t("metrics:overview.workloads")}>
        <h3 className="ov__heading">{t("metrics:overview.workloads")}</h3>
        <table className="ov__workloads">
          <tbody>
            {workloadRows.map((row) => (
              <tr key={row.id} data-kind={row.id}>
                <th scope="row">{t(`metrics:overview.kinds.${row.id}`)}</th>
                <td className="ov__total">{row.watch.status === "ready" || row.watch.status === "reconnecting" ? row.watch.items.size : null}</td>
                <td>
                  {row.watch.status === "error" ? (
                    <ErrorState error={row.watch.error} />
                  ) : (
                    <StateList
                      counts={row.counts}
                      states={row.states}
                      label={(s) =>
                        row.id === "pods" ? t(`metrics:overview.phase.${s}`) : t(`metrics:overview.state.${s}`)
                      }
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <ClusterCharts clusterId={clusterId} />

      <section className="ov__section" aria-label={t("metrics:overview.warnings")}>
        <h3 className="ov__heading">{t("metrics:overview.warnings")}</h3>
        <Warnings watch={warnings} />
      </section>
    </div>
  );
}

function Card({ title, watch, children }: { title: string; watch?: WatchState; children: ReactNode }) {
  const { t } = useTranslation();
  let body = children;
  if (watch?.status === "error") body = <ErrorState error={watch.error} />;
  else if (watch?.status === "loading") body = <LoadingIndicator text={t("resources:loading.kind", { kind: title })} />;
  return (
    <section className="ov__card" aria-label={title}>
      <h3 className="ov__heading">{title}</h3>
      {body}
    </section>
  );
}

function StateList({
  counts,
  states,
  label,
}: {
  counts: Map<string, number>;
  states: readonly string[];
  label: (state: string) => string;
}) {
  const { t } = useTranslation();
  const shown = states.filter((s) => (counts.get(s) ?? 0) > 0);
  return (
    <ul className="ov__states">
      {shown.map((s) => (
        <li key={s} className={`ov__state ov__state--${TONES[s as Phase | State] ?? "neutral"}`} data-state={s}>
          <span className="ov__state-label">{label(s)}</span>
          <span className="ov__state-count">{t("metrics:overview.count", { count: counts.get(s) ?? 0 })}</span>
        </li>
      ))}
    </ul>
  );
}

/** CPU and memory of all nodes against their allocatable capacity. */
function UsageCard({ clusterId, nodes }: { clusterId: ClusterId; nodes: KubeObject[] }) {
  const { t } = useTranslation();
  const metricsStatus = useMetricsStatus(clusterId);
  const usage = useNodeUsage(clusterId);

  let body: ReactNode;
  if (usageUnavailable(metricsStatus, usage)) body = <MetricsUnavailable clusterId={clusterId} />;
  else if (!usage.data) body = <LoadingIndicator text={t("metrics:loading")} />;
  else {
    let cpu = 0;
    let memory = 0;
    for (const u of usage.data.values()) {
      cpu += u.usage.cpuMillicores;
      memory += u.usage.memoryBytes;
    }
    let cpuTotal = 0;
    let memoryTotal = 0;
    for (const node of nodes) {
      const alloc = nodeAllocatable(node);
      cpuTotal += alloc.cpu ?? 0;
      memoryTotal += alloc.memory ?? 0;
    }
    const row = (title: string, used: number, total: number, format: (v: number) => string) => {
      const percent = percentOf(used, total);
      const text = total > 0 ? t("metrics:overview.usageOf", { used: format(used), total: format(total) }) : format(used);
      return (
        <div className="ov__usage">
          <div className="ov__usage-head">
            <span>{title}</span>
            <span className="ov__usage-percent">{percent === undefined ? null : t(percentKey("metrics:percent", percent), { value: percent })}</span>
          </div>
          <UsageBar percent={percent} label={text} />
        </div>
      );
    };
    body = (
      <>
        {row(t("metrics:overview.cpu"), cpu, cpuTotal, formatCpu)}
        {row(t("metrics:overview.memory"), memory, memoryTotal, formatBytes)}
      </>
    );
  }
  return (
    <section className="ov__card ov__card--wide" aria-label={t("metrics:overview.usage")}>
      <h3 className="ov__heading">{t("metrics:overview.usage")}</h3>
      {body}
    </section>
  );
}

function ClusterCharts({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const metricsStatus = useMetricsStatus(clusterId);
  if (!metricsStatus.data || nothingAvailable(metricsStatus)) return null;
  return (
    <section className="ov__section" aria-label={t("metrics:overview.charts")}>
      <h3 className="ov__heading">{t("metrics:overview.charts")}</h3>
      <ChartGrid
        clusterId={clusterId}
        target={{ type: "cluster" }}
        status={metricsStatus.data}
        metrics={CLUSTER_CHARTS}
      />
    </section>
  );
}

function Warnings({ watch }: { watch: WatchState }) {
  const { t } = useTranslation();
  const latest = useMemo(() => [...watch.items.values()].sort(byNewest).slice(0, WARNING_LIMIT), [watch.items]);
  if (watch.status === "error") return <ErrorState error={watch.error} />;
  if (watch.status === "loading") return <LoadingIndicator text={t("metrics:overview.loadingWarnings")} />;
  if (latest.length === 0) return <div className="ov__sub">{t("metrics:overview.noWarnings")}</div>;
  return (
    <ul className="events-list ov__warnings">
      {latest.map((e) => (
        <li key={e.metadata?.uid ?? e.metadata?.name} className="events-item events-warning">
          <div className="events-item__head">
            <span className="events-item__reason">{String(e.reason ?? "")}</span>
            <InvolvedObjectLink event={e} />
            <span className="events-item__meta">
              <Age timestamp={eventTimestamp(e)} />
            </span>
          </div>
          <div className="events-item__message">{String(e.message ?? "")}</div>
        </li>
      ))}
    </ul>
  );
}
