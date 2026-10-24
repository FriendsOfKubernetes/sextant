// CPU and Memory columns of the Pods and Nodes tables (as in Lens: pods after "Containers", nodes after "Name").
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { useAppStore } from "../../app/store";
import { status, type ColumnDef } from "../../resources";
import { UnavailableCell, UsageBar, usageUnavailable } from "./components";
import { formatBytes, formatCpu, parseQuantity, percentKey, percentOf } from "./format";
import {
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
    render: (o, ctx) => <PodUsageCell clusterId={ctx.clusterId} pod={o} metric={CPU} />,
  },
  {
    id: "memory",
    titleKey: "metrics:columns.memory",
    width: "90px",
    after: "cpu",
    value: (o) => latestPodUsage(activeCluster(), keyOf(o))?.usage.memoryBytes,
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
    render: (o, ctx) => <NodeUsageCell clusterId={ctx.clusterId} node={o} metric={CPU} />,
  },
  {
    id: "memory",
    titleKey: "metrics:columns.memory",
    width: "110px",
    after: "cpu",
    value: (o) => latestNodeUsage(activeCluster(), o.metadata?.name ?? "")?.usage.memoryBytes,
    render: (o, ctx) => <NodeUsageCell clusterId={ctx.clusterId} node={o} metric={MEMORY} />,
  },
];
