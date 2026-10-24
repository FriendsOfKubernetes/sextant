// "Metrics" section of the details panel: current CPU/memory of a pod (per container) or a node (of allocatable),
// and charts of the last hour for pods, nodes and Deployments/StatefulSets/DaemonSets (the sum of their pods).
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ChartTarget, ClusterId, KindRef, KubeObject, MetricsStatus, ObjectRef, PodUsage } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { formatList, formatParts } from "../../i18n";
import { nodeAllocatable } from "./columns";
import {
  ChartGrid,
  MetricsUnavailable,
  nothingAvailable,
  UsageBar,
  usageUnavailable,
  type MetricName,
} from "./components";
import { formatBytes, formatCpu, percentKey, percentOf, shareOf } from "./format";
import { podKey, useMetricsStatus, useNodeUsage, usePodUsage, type Polled } from "./hooks";
import { podResourceAmounts, type ResourceAmounts } from "./requests";

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
        {isNode && obj && <NodeCurrent clusterId={clusterId} node={obj} status={metricsStatus.data} />}
        <ChartGrid clusterId={clusterId} target={target} status={metricsStatus.data} metrics={charts} />
      </>
    );
  // Requests and limits come from the pod itself, so they are there whether or not metrics are.
  if (target.type === "pod")
    body = (
      <>
        <PodCurrent clusterId={clusterId} target={target} obj={obj} status={metricsStatus} />
        {body}
      </>
    );

  return (
    <section className="mx-section" aria-label={t("metrics:title")}>
      <h3 className="mx-section__title">{t("metrics:title")}</h3>
      {body}
    </section>
  );
}

/** Current values of a pod and what its containers requested and may use at most (from the spec, so also without metrics). */
function PodCurrent({
  clusterId,
  target,
  obj,
  status,
}: {
  clusterId: ClusterId;
  target: { namespace: string; name: string };
  obj: KubeObject | null;
  status: Polled<MetricsStatus>;
}) {
  const live = status.error === null && status.data !== null && status.data.effectiveUsageSource !== null;
  if (!live) return <PodRows obj={obj} usage={undefined} />;
  return <LivePodRows clusterId={clusterId} target={target} obj={obj} />;
}

function LivePodRows({
  clusterId,
  target,
  obj,
}: {
  clusterId: ClusterId;
  target: { namespace: string; name: string };
  obj: KubeObject | null;
}) {
  const usage = usePodUsage(clusterId);
  const pod = usage.error || usage.loading ? undefined : usage.data?.get(podKey(target.namespace, target.name));
  return <PodRows obj={obj} usage={pod} />;
}

type ContainerUsage = PodUsage["containers"][number][1];

function PodRows({ obj, usage }: { obj: KubeObject | null; usage: PodUsage | undefined }) {
  const { t } = useTranslation();
  const amounts = podResourceAmounts(obj);
  const usageByName = new Map<string, ContainerUsage>(usage?.containers ?? []);
  const names = [...new Set([...amounts.byContainer.keys(), ...usageByName.keys()])];
  const shown = (a: ResourceAmounts, value: number | undefined) =>
    value !== undefined || a.requestSetOn > 0 || a.limitSetOn > 0;
  const cpu = shown(amounts.cpu, usage?.usage.cpuMillicores);
  const memory = shown(amounts.memory, usage?.usage.memoryBytes);
  if (!cpu && !memory) return null;
  return (
    <dl className="mx-current">
      {cpu && (
        <>
          <dt>{t("metrics:columns.cpu")}</dt>
          <dd>
            <PodAmount used={usage?.usage.cpuMillicores} amounts={amounts.cpu} format={formatCpu} />
          </dd>
        </>
      )}
      {memory && (
        <>
          <dt>{t("metrics:columns.memory")}</dt>
          <dd>
            <PodAmount used={usage?.usage.memoryBytes} amounts={amounts.memory} format={formatBytes} />
          </dd>
        </>
      )}
      {names.length > 1 &&
        names.map((name) => {
          const u = usageByName.get(name);
          const own = amounts.byContainer.get(name);
          const specText = [
            own &&
              containerAmounts(own.cpu, formatCpu, (amounts) => t("metrics:requests.containerCpu", { amounts }), t),
            own &&
              containerAmounts(
                own.memory,
                formatBytes,
                (amounts) => t("metrics:requests.containerMemory", { amounts }),
                t,
              ),
          ].filter((part): part is string => Boolean(part));
          return (
            <ContainerRow
              key={name}
              name={name}
              usage={
                u &&
                t("metrics:containerUsage", {
                  cpu: formatCpu(u.cpuMillicores),
                  memory: formatBytes(u.memoryBytes),
                })
              }
              spec={formatParts(specText)}
            />
          );
        })}
    </dl>
  );
}

/** "CPU request 100m, limit 200m" for one container and resource; `undefined` when it sets neither. */
function containerAmounts(
  own: { request?: number; limit?: number },
  format: (v: number) => string,
  wrap: (amounts: string) => string,
  t: TFunction,
): string | undefined {
  if (own.request === undefined && own.limit === undefined) return undefined;
  const parts = [
    own.request !== undefined && t("metrics:requests.request", { value: format(own.request) }),
    own.limit !== undefined ? t("metrics:requests.limit", { value: format(own.limit) }) : t("metrics:requests.noLimit"),
  ].filter((part): part is string => Boolean(part));
  return wrap(formatList(parts));
}

/** One resource of a pod: its usage, the usage against the limit (else the request) as a bar, and request/limit. */
function PodAmount({
  used,
  amounts,
  format,
}: {
  used: number | undefined;
  amounts: ResourceAmounts;
  format: (v: number) => string;
}) {
  const { t } = useTranslation();
  const everywhere = (setOn: number) => amounts.containers > 0 && setOn === amounts.containers;
  // A share of a value that only some containers have would say nothing about the pod.
  const against =
    amounts.limit !== undefined && everywhere(amounts.limitSetOn)
      ? { value: amounts.limit, key: "shareOfLimit" }
      : amounts.request !== undefined && everywhere(amounts.requestSetOn)
        ? { value: amounts.request, key: "shareOfRequest" }
        : undefined;
  // A share below 1 % reads "<1% of request", not "1%" (#276).
  const share = used !== undefined && against ? shareOf(used, against.value) : undefined;
  const notes: ReactNode[] = [];
  // "(set on 1 of 2 containers)": said right after the value that is only the sum of some of the containers. The
  // noun agrees with the number of all containers (`count`); the gap before the note is the stylesheet's.
  const partial = (key: "requestSetOn" | "limitSetOn", set: number) => (
    <span className="mx-amount__note">{t(`metrics:requests.${key}`, { set, count: amounts.containers })}</span>
  );
  const requestPartial = !everywhere(amounts.requestSetOn) ? partial("requestSetOn", amounts.requestSetOn) : null;
  const limitPartial = amounts.limit !== undefined ? partial("limitSetOn", amounts.limitSetOn) : null;
  if (amounts.request !== undefined)
    notes.push(
      <span key="request">
        {t("metrics:requests.request", { value: format(amounts.request) })}
        {requestPartial}
      </span>,
    );
  if (amounts.limit !== undefined && everywhere(amounts.limitSetOn))
    notes.push(<span key="limit">{t("metrics:requests.limit", { value: format(amounts.limit) })}</span>);
  else if (amounts.request !== undefined || amounts.limit !== undefined)
    notes.push(
      <span key="noLimit">
        {t("metrics:requests.noLimit")}
        {limitPartial}
      </span>,
    );
  return (
    <span className="mx-amount">
      {used !== undefined && <span className="mx-amount__value">{format(used)}</span>}
      {share !== undefined && against && (
        <UsageBar
          percent={Math.min(100, share)}
          label={t(percentKey(`metrics:requests.${against.key}`, share), { value: share })}
        />
      )}
      {notes.length > 0 && <span className="mx-amount__spec">{notes}</span>}
    </span>
  );
}

function ContainerRow({ name, usage, spec }: { name: string; usage: string | undefined; spec: string }) {
  return (
    <>
      <dt className="mx-current__container">{name}</dt>
      <dd>
        {usage && <div>{usage}</div>}
        {spec && <div className="mx-amount__spec">{spec}</div>}
      </dd>
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
    return (
      <UsageBar
        percent={percent}
        label={percent === undefined ? text : t(percentKey("metrics:percentOf", percent), { value: percent, text })}
      />
    );
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
