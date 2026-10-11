// "Metrics" section of the details panel: current CPU/memory of a pod (per container) or a node (of allocatable),
// and charts of the last hour for pods, nodes and Deployments/StatefulSets/DaemonSets (the sum of their pods).
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ChartTarget, ClusterId, KindRef, KubeObject, MetricsStatus, ObjectRef } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { nodeAllocatable } from "./columns";
import { ChartGrid, MetricsUnavailable, nothingAvailable, UsageBar, usageUnavailable, type MetricName } from "./components";
import { formatBytes, formatCpu, percentOf } from "./format";
import { podKey, useMetricsStatus, useNodeUsage, usePodUsage } from "./hooks";

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);
const NODE_CHARTS: MetricName[] = ["cpu", "memory", "pods", "disk"];
const POD_CHARTS: MetricName[] = ["cpu", "memory"];

export function metricsApplyTo(kind: KindRef): boolean {
  if (kind.group === "") return kind.kind === "Pod" || kind.kind === "Node";
  return kind.group === "apps" && WORKLOADS.has(kind.kind);
}

function chartTarget(ref: ObjectRef): ChartTarget | null {
  const { kind } = ref.kind;
  if (kind === "Pod" && ref.namespace) return { type: "pod", namespace: ref.namespace, name: ref.name };
  if (kind === "Node") return { type: "node", name: ref.name };
  if (WORKLOADS.has(kind) && ref.namespace) return { type: "workload", namespace: ref.namespace, kind, name: ref.name };
  return null;
}

export function MetricsDetailsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const metricsStatus = useMetricsStatus(clusterId);
  const target = chartTarget(objectRef);
  if (!target) return null;
  const isNode = target.type === "node";
  const charts = isNode ? NODE_CHARTS : POD_CHARTS;

  let body: ReactNode;
  if (nothingAvailable(metricsStatus)) body = <MetricsUnavailable clusterId={clusterId} />;
  else if (!metricsStatus.data) body = <div className="mx-note">{t("metrics:loading")}</div>;
  else
    body = (
      <>
        {target.type === "pod" && <PodCurrent clusterId={clusterId} target={target} status={metricsStatus.data} />}
        {isNode && obj && <NodeCurrent clusterId={clusterId} node={obj} status={metricsStatus.data} />}
        <ChartGrid clusterId={clusterId} target={target} status={metricsStatus.data} metrics={charts} />
      </>
    );

  return (
    <section className="mx-section" aria-label={t("metrics:title")}>
      <h3 className="mx-section__title">{t("metrics:title")}</h3>
      {body}
    </section>
  );
}

function PodCurrent({
  clusterId,
  target,
  status,
}: {
  clusterId: ClusterId;
  target: { namespace: string; name: string };
  status: MetricsStatus;
}) {
  const { t } = useTranslation();
  const usage = usePodUsage(clusterId);
  if (usageUnavailable({ data: status, error: null, loading: false }, usage) || usage.loading) return null;
  const pod = usage.data?.get(podKey(target.namespace, target.name));
  if (!pod) return null;
  return (
    <dl className="mx-current">
      <dt>{t("metrics:columns.cpu")}</dt>
      <dd>{formatCpu(pod.usage.cpuMillicores)}</dd>
      <dt>{t("metrics:columns.memory")}</dt>
      <dd>{formatBytes(pod.usage.memoryBytes)}</dd>
      {pod.containers.length > 1 &&
        pod.containers.map(([name, u]) => (
          <ContainerRow key={name} name={name} value={t("metrics:containerUsage", { cpu: formatCpu(u.cpuMillicores), memory: formatBytes(u.memoryBytes) })} />
        ))}
    </dl>
  );
}

function ContainerRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt className="mx-current__container">{name}</dt>
      <dd>{value}</dd>
    </>
  );
}

function NodeCurrent({ clusterId, node, status }: { clusterId: ClusterId; node: KubeObject; status: MetricsStatus }) {
  const { t } = useTranslation();
  const usage = useNodeUsage(clusterId);
  if (usageUnavailable({ data: status, error: null, loading: false }, usage) || usage.loading) return null;
  const value = usage.data?.get(node.metadata?.name ?? "")?.usage;
  if (!value) return null;
  const alloc = nodeAllocatable(node);
  const row = (used: number, total: number | undefined, format: (v: number) => string) => {
    const percent = percentOf(used, total);
    const text = total === undefined ? format(used) : t("metrics:usedOf", { used: format(used), total: format(total) });
    return <UsageBar percent={percent} label={percent === undefined ? text : t("metrics:percentOf", { value: percent, text })} />;
  };
  return (
    <dl className="mx-current">
      <dt>{t("metrics:columns.cpu")}</dt>
      <dd>{row(value.cpuMillicores, alloc.cpu, formatCpu)}</dd>
      <dt>{t("metrics:columns.memory")}</dt>
      <dd>{row(value.memoryBytes, alloc.memory, formatBytes)}</dd>
    </dl>
  );
}
