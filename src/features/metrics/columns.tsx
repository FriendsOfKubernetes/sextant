// CPU and Memory columns of the Pods and Nodes tables (as in Lens: pods after "Containers", nodes after "Name").
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject, NodeUsage, PodUsage } from "../../api";
import { useAppStore } from "../../app/store";
import { status, type ColumnDef } from "../../resources";
import type { CellContext } from "../../resources/registry";
import { UnavailableCell, UsageBar, usageUnavailable } from "./components";
import { formatBytes, formatCpu, parseQuantity, percentKey, percentOf } from "./format";
import {
  hasLatestUsage,
  latestNodeUsage,
  latestPodUsage,
  podKey,
  useMetricsStatus,
  useNodeUsage,
  usePodUsage,
} from "./hooks";

type Metric = "cpu" | "memory";

const activeCluster = () => useAppStore.getState().activeClusterId;
const CPU: Metric = "cpu";
const MEMORY: Metric = "memory";

function keyOf(pod: KubeObject): string {
  return podKey(pod.metadata?.namespace, pod.metadata?.name);
}

// Filter-only leases of the existing poller's current snapshot, including unavailable data. No maps are copied,
// and the reference disappears with its last observer; sorting keeps its existing last-successful cache.
const podFilterSnapshots = new Map<ClusterId, Set<{ data: Map<string, PodUsage> | null }>>();
const nodeFilterSnapshots = new Map<ClusterId, Set<{ data: Map<string, NodeUsage> | null }>>();
function useFilterSnapshot<T>(snapshots: Map<ClusterId, Set<{ data: Map<string, T> | null }>>, clusterId: ClusterId,
  data: Map<string, T> | null, onChange: () => void) {
  useEffect(() => {
    const leases = snapshots.get(clusterId) ?? new Set<{ data: Map<string, T> | null }>();
    snapshots.set(clusterId, leases);
    const lease = { data };
    leases.add(lease);
    onChange();
    return () => { leases.delete(lease); if (!leases.size) snapshots.delete(clusterId); };
  }, [snapshots, clusterId, data, onChange]);
}
function filterSnapshot<T>(snapshots: Map<ClusterId, Set<{ data: Map<string, T> | null }>>, clusterId: ClusterId): Map<string, T> | null {
  const leases = snapshots.get(clusterId);
  if (!leases) return null;
  let data: Map<string, T> | null = null;
  for (const lease of leases) data = lease.data;
  return data;
}

// While a poll loads or after it failed, a filter reads the last successful answer, as sorting does; with none at all
// the column is not ready and its filters keep every row (paused) instead of hiding them all.
function podFilterUsage(o: KubeObject, ctx: CellContext): PodUsage | undefined {
  const snapshot = filterSnapshot(podFilterSnapshots, ctx.clusterId);
  return snapshot ? snapshot.get(keyOf(o)) : latestPodUsage(ctx.clusterId, keyOf(o));
}
function nodeFilterUsage(o: KubeObject, ctx: CellContext): NodeUsage | undefined {
  const snapshot = filterSnapshot(nodeFilterSnapshots, ctx.clusterId);
  const name = o.metadata?.name ?? "";
  return snapshot ? snapshot.get(name) : latestNodeUsage(ctx.clusterId, name);
}
const podsReady = (ctx: CellContext) => filterSnapshot(podFilterSnapshots, ctx.clusterId) !== null || hasLatestUsage(ctx.clusterId, "pods");
const nodesReady = (ctx: CellContext) => filterSnapshot(nodeFilterSnapshots, ctx.clusterId) !== null || hasLatestUsage(ctx.clusterId, "nodes");

function PodFilterObserver({ context, onChange }: { context: CellContext; onChange: () => void }) {
  const { data } = usePodUsage(context.clusterId);
  useFilterSnapshot(podFilterSnapshots, context.clusterId, data, onChange);
  return null;
}

function NodeFilterObserver({ context, onChange }: { context: CellContext; onChange: () => void }) {
  const { data } = useNodeUsage(context.clusterId);
  useFilterSnapshot(nodeFilterSnapshots, context.clusterId, data, onChange);
  return null;
}

function PodUsageCell({ clusterId, pod, metric }: { clusterId: ClusterId; pod: KubeObject; metric: Metric }) {
  const metricsStatus = useMetricsStatus(clusterId);
  const usage = usePodUsage(clusterId);
  if (usageUnavailable(metricsStatus, usage)) return <UnavailableCell clusterId={clusterId} />;
  const value = usage.data?.get(keyOf(pod))?.usage;
  if (!value) return null;
  return <span className="mx-value">{metric === "cpu" ? formatCpu(value.cpuMillicores) : formatBytes(value.memoryBytes)}</span>;
}

/** Allocatable CPU (millicores) and memory (bytes) of a node. */
export function nodeAllocatable(node: KubeObject): { cpu?: number; memory?: number } {
  const alloc = status.get(node, "status", "allocatable");
  const cpu = parseQuantity(status.get(alloc, "cpu"));
  return { cpu: cpu === undefined ? undefined : cpu * 1000, memory: parseQuantity(status.get(alloc, "memory")) };
}

function NodeUsageCell({ clusterId, node, metric }: { clusterId: ClusterId; node: KubeObject; metric: Metric }) {
  const { t } = useTranslation();
  const metricsStatus = useMetricsStatus(clusterId);
  const usage = useNodeUsage(clusterId);
  if (usageUnavailable(metricsStatus, usage)) return <UnavailableCell clusterId={clusterId} />;
  const value = usage.data?.get(node.metadata?.name ?? "")?.usage;
  if (!value) return null;
  const alloc = nodeAllocatable(node);
  const used = metric === "cpu" ? value.cpuMillicores : value.memoryBytes;
  const total = metric === "cpu" ? alloc.cpu : alloc.memory;
  const format = metric === "cpu" ? formatCpu : formatBytes;
  const percent = percentOf(used, total);
  const absolute = total === undefined ? format(used) : t("metrics:usedOf", { used: format(used), total: format(total) });
  return (
    <UsageBar
      percent={percent}
      label={percent === undefined ? format(used) : t(percentKey("metrics:percent", percent), { value: percent })}
      title={absolute}
    />
  );
}

export const podColumns: ColumnDef[] = [
  {
    id: "cpu",
    titleKey: "metrics:columns.cpu",
    width: "80px",
    after: "containers",
    value: (o) => latestPodUsage(activeCluster(), keyOf(o))?.usage.cpuMillicores,
    filter: { type: "number", unit: "cpu", value: (o, ctx) => podFilterUsage(o, ctx)?.usage.cpuMillicores, observer: PodFilterObserver, ready: podsReady },
    render: (o, ctx) => <PodUsageCell clusterId={ctx.clusterId} pod={o} metric={CPU} />,
  },
  {
    id: "memory",
    titleKey: "metrics:columns.memory",
    width: "90px",
    after: "cpu",
    value: (o) => latestPodUsage(activeCluster(), keyOf(o))?.usage.memoryBytes,
    filter: { type: "number", unit: "bytes", value: (o, ctx) => podFilterUsage(o, ctx)?.usage.memoryBytes, observer: PodFilterObserver, ready: podsReady },
    render: (o, ctx) => <PodUsageCell clusterId={ctx.clusterId} pod={o} metric={MEMORY} />,
  },
];

export const nodeColumns: ColumnDef[] = [
  {
    id: "cpu",
    titleKey: "metrics:columns.cpu",
    width: "110px",
    after: "name",
    value: (o) => latestNodeUsage(activeCluster(), o.metadata?.name ?? "")?.usage.cpuMillicores,
    filter: { type: "number", unit: "cpu", value: (o, ctx) => nodeFilterUsage(o, ctx)?.usage.cpuMillicores, observer: NodeFilterObserver, ready: nodesReady },
    render: (o, ctx) => <NodeUsageCell clusterId={ctx.clusterId} node={o} metric={CPU} />,
  },
  {
    id: "memory",
    titleKey: "metrics:columns.memory",
    width: "110px",
    after: "cpu",
    value: (o) => latestNodeUsage(activeCluster(), o.metadata?.name ?? "")?.usage.memoryBytes,
    filter: { type: "number", unit: "bytes", value: (o, ctx) => nodeFilterUsage(o, ctx)?.usage.memoryBytes, observer: NodeFilterObserver, ready: nodesReady },
    render: (o, ctx) => <NodeUsageCell clusterId={ctx.clusterId} node={o} metric={MEMORY} />,
  },
];
