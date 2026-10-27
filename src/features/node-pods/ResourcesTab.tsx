// The "Resources" tab of a Node's details (#280), like `kubectl describe node`: "Allocated resources" — the requests
// and limits of the node's non-terminated pods summed against its allocatable, next to its current usage — and a table
// of those pods with each one's CPU and memory request, limit and usage (sortable, searchable, virtualized).
import type { TFunction } from "i18next";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ResourceTable } from "../../components/Table";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { ageColumn, column, nameColumn, namespaceColumn, status as statusOf, StatusText } from "../../resources";
import { Block, table } from "../details";
import { formatBytes, formatCpu, percentKey } from "../metrics";
import { shareOf } from "../metrics/format";
import { amountColumns, usageColumns } from "./columns";
import { useNodePodUsage, useNodePods } from "./hooks";
import { allocatedResources, isTerminated, nodePodsSelector, POD, type AllocatedResource } from "./model";
import { PartialUsageNote, SearchBox } from "./PodsTab";
import "./node-pods.css";

const running = (pod: KubeObject) => !isTerminated(pod);
/** Where the column widths of the tab's table and of its summary are kept. */
const WIDTHS_ID = "nodeResources";
const SUMMARY_TABLE = "nodeAllocated";
const statusColumn = column("status", statusOf.podStatus, {
  width: "110px",
  render: (o) => <StatusText value={statusOf.podStatus(o)} />,
});

export function NodeResourcesTab({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const node = objectRef.name;
  const { pods } = useNodePods(clusterId, node);
  const usage = useNodePodUsage(clusterId, pods);
  const nodeUsage = usage.unavailable ? undefined : usage.node.data?.get(node)?.usage;
  const allocated = useMemo(() => allocatedResources(obj, pods, nodeUsage), [obj, pods, nodeUsage]);
  const columns = useMemo(() => {
    const [cpuUsage, memoryUsage] = usageColumns(clusterId, usage.pods.data, usage.unavailable, { cpu: "minmax(80px, 1fr)", memory: "minmax(90px, 1fr)" });
    return [
      nameColumn,
      namespaceColumn,
      ...amountColumns("cpu", t),
      cpuUsage!,
      ...amountColumns("memory", t),
      memoryUsage!,
      statusColumn,
      ageColumn,
    ];
  }, [clusterId, usage.pods.data, usage.unavailable, t]);
  const [search, setSearch] = useState("");
  return (
    <div className="np-tab">
      <div className="np-summary">
        <AllocatedBlock allocated={allocated} />
        <PartialUsageNote partial={usage.pods.partial} />
      </div>
      <div className="np-table">
        <ResourceTable
          key={node}
          clusterId={clusterId}
          kind={POD}
          title={t("nodepods:resources.podsTitle")}
          columns={columns}
          namespaces={null}
          fieldSelector={nodePodsSelector(node)}
          rowFilter={running}
          search={search}
          toolbar={<SearchBox value={search} onChange={setSearch} />}
          widthsId={WIDTHS_ID}
        />
      </div>
    </div>
  );
}

/** `value` and its share of `whole` ("250m (13%)"); the value alone without a whole. */
function withShare(value: number, whole: number | undefined, format: (v: number) => string, t: TFunction): string {
  const share = shareOf(value, whole);
  if (share === undefined) return format(value);
  return t(percentKey("nodepods:resources.share", share), { value: format(value), percent: share });
}

function resourceRow(
  label: string,
  r: AllocatedResource,
  format: (v: number) => string,
  t: TFunction,
): string[] {
  return [
    label,
    withShare(r.requests, r.allocatable, format, t),
    withShare(r.limits, r.allocatable, format, t),
    r.usage === undefined ? t("metrics:na") : withShare(r.usage, r.allocatable, format, t),
    r.allocatable === undefined ? "" : format(r.allocatable),
  ];
}

function AllocatedBlock({ allocated }: { allocated: ReturnType<typeof allocatedResources> }) {
  const { t } = useTranslation();
  const rows = [
    resourceRow(t("metrics:columns.cpu"), allocated.cpu, formatCpu, t),
    resourceRow(t("metrics:columns.memory"), allocated.memory, formatBytes, t),
  ];
  const withoutLimit = Math.max(allocated.cpu.podsWithoutLimit, allocated.memory.podsWithoutLimit);
  const { count, allocatable } = allocated.pods;
  return (
    <Block title={t("nodepods:resources.allocated")}>
      {table(
        SUMMARY_TABLE,
        [
          t("nodepods:resources.resource"),
          t("nodepods:resources.requests"),
          t("nodepods:resources.limits"),
          t("nodepods:resources.usage"),
          t("nodepods:resources.allocatable"),
        ],
        rows,
      )}
      <p className="np-note">
        {allocatable === undefined
          ? t("nodepods:resources.podCount", { count })
          : t("nodepods:resources.podsOf", { count, allocatable })}
      </p>
      {withoutLimit > 0 && (
        <p className="np-note">{t("nodepods:resources.withoutLimit", { count: withoutLimit })}</p>
      )}
    </Block>
  );
}
