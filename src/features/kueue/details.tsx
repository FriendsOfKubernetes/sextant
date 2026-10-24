// Details of Kueue objects (one section, `kueue`):
//   ClusterQueue — its state and why it admits nothing, the quota against what is reserved and in use per flavor and
//                  resource, its cohort, policies and admission checks, the LocalQueues pointing at it and the
//                  Workloads waiting in them with the reason each waits;
//   LocalQueue   — its ClusterQueue, its usage and its waiting Workloads;
//   Workload     — why it waits, was evicted or deactivated (the condition Kueue wrote), the job it belongs to, its
//                  queues, pod sets with requests and assigned flavors, admission checks and evictions;
//   ResourceFlavor, Cohort, AdmissionCheck, WorkloadPriorityClass — their fields and the ClusterQueues using them.
// Conditions, events and YAML are the panel's own sections. Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { Age } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, link, mapChips, table, type ColumnWrap, type FieldRow } from "../details";
import { labelSelector, tolerations } from "../details/ui";
import { percentKey } from "../metrics/format";
import { useClusterQueues, useLocalQueues, useWorkloadRows, type WorkloadRows } from "./hooks";
import { QueueStateText } from "./columns";
import {
  admissionChecksOf,
  ADMISSION_CHECK,
  CLUSTER_QUEUE,
  clusterQueueOf,
  COHORT,
  cohortOf,
  conditionOf,
  flavorsOf,
  isKind,
  isWaiting,
  kueueKind,
  LOCAL_QUEUE,
  localQueueUsage,
  parentCohortOf,
  queueCounts,
  queueState,
  quotaRows,
  RESOURCE_FLAVOR,
  waitingFor,
  WORKLOAD,
  WORKLOAD_PRIORITY_CLASS,
  type QuotaRow,
  type WorkloadRow,
} from "./model";
import { Muted, Note, TYPES } from "./ui";
import { WorkloadView } from "./workloadView";

const { get, num, str } = status;
const LABELS = "kueue:fields";
/** Workloads listed in a queue's details at most (oldest first). */
export const MAX_LISTED = 50;

const QUOTA_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", "nowrap", "nowrap", "nowrap"];

/** The quota table: flavor, resource, quota, reserved (with the borrowed part and the share of the quota), in use, limits. */
function QuotaTable({ rows, usage }: { rows: QuotaRow[]; usage: boolean }) {
  const { t } = useTranslation();
  const reservedText = (r: QuotaRow) => {
    if (!r.reserved) return "";
    const base =
      r.percent === undefined
        ? r.reserved
        : t(percentKey("kueue:quota.ofQuota", r.percent), { value: r.reserved, percent: r.percent });
    return r.borrowed ? t("kueue:quota.borrowed", { value: base, borrowed: r.borrowed }) : base;
  };
  const headers = [t("kueue:quota.flavor"), t("kueue:quota.resource"), t("kueue:quota.nominal")];
  if (usage) headers.push(t("kueue:quota.reserved"), t("kueue:quota.used"));
  headers.push(t("kueue:quota.borrowingLimit"), t("kueue:quota.lendingLimit"));
  const cells = rows.map((r) => {
    const row: ReactNode[] = [link(TYPES.resourceFlavor, r.flavor), r.resource, r.nominal ?? ""];
    if (usage) {
      const tone = r.percent !== undefined && r.percent >= 100 ? "warning" : undefined;
      row.push(tone ? <StatusText key="r" value={reservedText(r)} tone={tone} /> : reservedText(r), r.used ?? "");
    }
    row.push(r.borrowingLimit ?? "", r.lendingLimit ?? "");
    return row;
  });
  const id = usage ? "kueueQuota" : "kueueCohortQuota";
  return <>{table(id, headers, cells, QUOTA_WRAP)}</>;
}

const WAITING_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined];

/** The waiting Workloads of a queue: link, LocalQueue, how long, and why (the reason and message Kueue wrote). */
function WaitingList({ list, data, showQueue }: { list: WorkloadRow[]; data: WorkloadRows; showQueue: boolean }) {
  const { t } = useTranslation();
  if (data.loading) return <Muted text={t("kueue:loading")} />;
  if (data.failed) return <Muted text={t("kueue:waitingUnknown")} />;
  const shown = list.slice(0, MAX_LISTED);
  const rows = shown.map((r) => [
    link(TYPES.workload, r.name, r.namespace),
    showQueue ? link(TYPES.localQueue, r.queue, r.namespace) : r.namespace,
    <Age key="a" timestamp={r.since ?? r.created} />,
    [r.reason, r.message].filter(Boolean).join(": "),
  ]);
  const headers = [t("kueue:waiting.workload"), showQueue ? t("kueue:waiting.queue") : t("kueue:waiting.namespace"), t("kueue:waiting.since"), t("kueue:waiting.why")];
  const waitingTable = table("kueueWaiting", headers, rows, WAITING_WRAP);
  return (
    <>
      {list.length === 0 ? <Muted text={t("kueue:noneWaiting")} /> : waitingTable}
      {list.length > shown.length && <Muted text={t("kueue:moreWaiting", { shown: shown.length, total: list.length })} />}
      {data.truncated && <Muted text={t("kueue:workloadsTruncated")} />}
    </>
  );
}

/** Why a queue admits nothing, or that it was stopped. */
function QueueNote({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = queueState(obj);
  const active = conditionOf(obj, "Active");
  if (state === "inactive") return <Note text={[active?.reason, active?.message].filter(Boolean).join(": ")} tone="danger" />;
  if (state === "stopped") return <Muted text={t("kueue:stopped", { policy: str(get(obj, "spec", "stopPolicy")) ?? "Hold" })} />;
  return null;
}

function countRows(obj: KubeObject): FieldRow[] {
  const c = queueCounts(obj);
  return [
    ["pending", String(c.pending)],
    ["reserving", String(c.reserving)],
    ["admitted", String(c.admitted)],
  ];
}

const LQ_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap"];

function ClusterQueueView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const name = obj.metadata?.name ?? "";
  const localQueues = useLocalQueues(clusterId);
  const workloads = useWorkloadRows(clusterId, true);
  const mine = localQueues.items.filter((lq) => clusterQueueOf(lq) === name);
  const keys = new Set(mine.map((lq) => `${lq.metadata?.namespace ?? ""}/${lq.metadata?.name ?? ""}`));
  const preemption = get(obj, "spec", "preemption");
  const selector = get(obj, "spec", "namespaceSelector");
  const rows: FieldRow[] = [
    ["status", <QueueStateText key="s" obj={obj} />],
    ["cohort", link(TYPES.cohort, cohortOf(obj))],
    ["strategy", str(get(obj, "spec", "queueingStrategy")) ?? "BestEffortFIFO"],
    // No selector selects no namespace; an empty one selects all (ClusterQueueSpec.namespaceSelector).
    ["namespaces", selector == null ? t("kueue:noNamespaces") : (labelSelector(selector) ?? t("kueue:allNamespaces"))],
    ["stopPolicy", str(get(obj, "spec", "stopPolicy"))],
    ["withinClusterQueue", str(get(preemption, "withinClusterQueue"))],
    ["reclaimWithinCohort", str(get(preemption, "reclaimWithinCohort"))],
    ["borrowWithinCohort", str(get(preemption, "borrowWithinCohort", "policy"))],
    ["admissionChecks", chips(admissionChecksOf(obj))],
    ...countRows(obj),
  ];
  const quota = quotaRows(obj);
  const lqRows = mine.map((lq) => {
    const c = queueCounts(lq);
    return [link(TYPES.localQueue, lq.metadata?.name, lq.metadata?.namespace ?? null), lq.metadata?.namespace ?? "", String(c.pending), String(c.admitted)];
  });
  const waiting = waitingFor(workloads.rows, keys);
  const lqHeaders = [t("kueue:columns.name"), t("kueue:columns.namespace"), t("kueue:columns.pending"), t("kueue:columns.admitted")];
  const lqTable = table("kueueLocalQueues", lqHeaders, lqRows, LQ_WRAP);
  return (
    <>
      <QueueNote obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block title={t("kueue:quota.title")}>
        {quota.length > 0 ? <QuotaTable rows={quota} usage /> : <Muted text={t("kueue:quota.none")} />}
      </Block>
      <Block title={t("kueue:localQueues")}>
        {localQueues.loading ? (
          <Muted text={t("kueue:loading")} />
        ) : lqRows.length > 0 ? (
          lqTable
        ) : (
          <Muted text={localQueues.failed ? t("kueue:listUnknown") : t("kueue:noLocalQueues")} />
        )}
      </Block>
      <Block title={t("kueue:waiting.title")}>
        <WaitingList list={waiting} data={workloads} showQueue />
      </Block>
    </>
  );
}

const USAGE_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap"];

function LocalQueueView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? "";
  const name = obj.metadata?.name ?? "";
  const workloads = useWorkloadRows(clusterId, true);
  const rows: FieldRow[] = [
    ["status", <QueueStateText key="s" obj={obj} />],
    ["clusterQueue", link(TYPES.clusterQueue, clusterQueueOf(obj))],
    ["stopPolicy", str(get(obj, "spec", "stopPolicy"))],
    ...countRows(obj),
  ];
  const usage = localQueueUsage(obj).map((r) => [link(TYPES.resourceFlavor, r.flavor), r.resource, r.reserved ?? "", r.used ?? ""]);
  const waiting = workloads.rows
    .filter((r) => isWaiting(r) && r.namespace === ns && r.queue === name)
    .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""));
  const usageHeaders = [t("kueue:quota.flavor"), t("kueue:quota.resource"), t("kueue:quota.reserved"), t("kueue:quota.used")];
  const usageTable = table("kueueUsage", usageHeaders, usage, USAGE_WRAP);
  return (
    <>
      <QueueNote obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
      {usage.length > 0 && (
        <Block title={t("kueue:usage")}>
          {usageTable}
        </Block>
      )}
      <Block title={t("kueue:waiting.title")}>
        <WaitingList list={waiting} data={workloads} showQueue={false} />
      </Block>
    </>
  );
}

/** Links to the ClusterQueues `pick` keeps, or a note while they load or cannot be read. */
function ClusterQueueLinks({ clusterId, pick }: { clusterId: ClusterId; pick: (cq: KubeObject) => boolean }) {
  const { t } = useTranslation();
  const queues = useClusterQueues(clusterId);
  if (queues.loading) return <Muted text={t("kueue:loading")} />;
  if (queues.failed) return <Muted text={t("kueue:listUnknown")} />;
  const names = queues.items
    .filter(pick)
    .map((cq) => cq.metadata?.name ?? "")
    .sort();
  if (names.length === 0) return <Muted text={t("kueue:noClusterQueues")} />;
  return <span className="dt-links">{names.map((n) => link(TYPES.clusterQueue, n))}</span>;
}

function ResourceFlavorView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const name = obj.metadata?.name ?? "";
  const taints = status.arr(get(obj, "spec", "nodeTaints")).map((x) => `${str(get(x, "key")) ?? ""}${str(get(x, "value")) ? `=${str(get(x, "value"))}` : ""}:${str(get(x, "effect")) ?? ""}`);
  const rows: FieldRow[] = [
    ["nodeLabels", mapChips(get(obj, "spec", "nodeLabels"))],
    ["nodeTaints", chips(taints)],
    ["tolerations", chips(tolerations(get(obj, "spec", "tolerations")))],
    ["topology", str(get(obj, "spec", "topologyName"))],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block title={t("kueue:usedBy")}>
        <ClusterQueueLinks clusterId={clusterId} pick={(cq) => flavorsOf(cq).includes(name)} />
      </Block>
    </>
  );
}

function CohortView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const name = obj.metadata?.name ?? "";
  const quota = quotaRows(obj);
  const parentRows: FieldRow[] = [["parent", link(TYPES.cohort, parentCohortOf(obj))]];
  return (
    <>
      <Fields rows={parentRows} labelPrefix={LABELS} />
      <Block title={t("kueue:members")}>
        <ClusterQueueLinks clusterId={clusterId} pick={(cq) => cohortOf(cq) === name} />
      </Block>
      {quota.length > 0 && (
        <Block title={t("kueue:quota.title")}>
          <QuotaTable rows={quota} usage={false} />
        </Block>
      )}
    </>
  );
}

function AdmissionCheckView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const name = obj.metadata?.name ?? "";
  const params = get(obj, "spec", "parameters");
  const paramsText = str(get(params, "name")) ? `${str(get(params, "kind")) ?? ""}/${str(get(params, "name"))}` : undefined;
  const rows: FieldRow[] = [
    ["status", <QueueStateText key="s" obj={obj} />],
    ["controller", str(get(obj, "spec", "controllerName"))],
    ["parameters", paramsText],
  ];
  return (
    <>
      <QueueNote obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
      <Block title={t("kueue:usedBy")}>
        <ClusterQueueLinks clusterId={clusterId} pick={(cq) => admissionChecksOf(cq).includes(name)} />
      </Block>
    </>
  );
}

function PriorityClassView({ obj }: { obj: KubeObject }) {
  const rows: FieldRow[] = [
    ["value", num(get(obj, "value"))?.toString()],
    ["description", str(get(obj, "description"))],
  ];
  return <Fields rows={rows} labelPrefix={LABELS} />;
}

export function KueueSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, CLUSTER_QUEUE)) return <ClusterQueueView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, LOCAL_QUEUE)) return <LocalQueueView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, WORKLOAD)) return <WorkloadView obj={obj} />;
  if (isKind(kind, RESOURCE_FLAVOR)) return <ResourceFlavorView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, COHORT)) return <CohortView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, ADMISSION_CHECK)) return <AdmissionCheckView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, WORKLOAD_PRIORITY_CLASS)) return <PriorityClassView obj={obj} />;
  return null;
}

export const appliesTo = (kind: Parameters<typeof kueueKind>[0]): boolean => kueueKind(kind) !== undefined;

