// A Workload's details: what its state means and the condition Kueue wrote (why it waits, was evicted, deactivated or
// failed), the job it belongs to, its queues, its pod sets with their requests and assigned flavors, its admission
// checks and evictions. `WorkloadSummary` is the same story in short, for the "Queue" section of a job.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ObjectLink, status, StatusText } from "../../resources";
import { Block, chips, Fields, link, table, type ColumnWrap, type FieldRow } from "../details";
import { WorkloadStateText } from "./columns";
import { date, Muted, Note, TYPES } from "./ui";
import { evictionsOf, failedDeactivation, ownerOf, workloadInfo, type WorkloadInfo } from "./model";

const { arr, get, num, record, str } = status;
const LABELS = "kueue:fields";

const DANGER = new Set(["inadmissible", "failed"]);

/** The state in words and the condition's own reason and message. */
export function WorkloadWhy({ obj, info }: { obj: KubeObject; info: WorkloadInfo }) {
  const { t } = useTranslation();
  if (info.state === "admitted" || info.state === "finished") return null;
  const failure = DANGER.has(info.state) || (info.state === "deactivated" && failedDeactivation(obj));
  const text = [info.why?.reason, info.why?.message].filter(Boolean).join(": ");
  return (
    <>
      <Muted text={t(`kueue:explain.${info.state}`)} />
      {text && <Note text={text} tone={failure ? "danger" : "warning"} />}
    </>
  );
}

function ownerLink(obj: KubeObject): ReactNode {
  const owner = ownerOf(obj);
  if (!owner) return null;
  return (
    <ObjectLink target={owner} namespace={obj.metadata?.namespace ?? null}>
      {`${owner.kind}/${owner.name}`}
    </ObjectLink>
  );
}

const quantities = (value: unknown) => chips(Object.entries(record(value)).map(([k, v]) => `${k}: ${String(v)}`));

const PODSET_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined, undefined];
const CHECK_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined, "nowrap"];
const EVICTION_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap"];

export function WorkloadView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const info = workloadInfo(obj);
  const requeueAt = str(get(obj, "status", "requeueState", "requeueAt"));
  const rows: FieldRow[] = [
    ["status", <WorkloadStateText key="s" obj={obj} />],
    ["owner", ownerLink(obj)],
    ["queue", link(TYPES.localQueue, info.queue, ns)],
    ["clusterQueue", link(TYPES.clusterQueue, info.clusterQueue)],
    ["priority", info.priority?.toString()],
    ["priorityClass", info.priorityClass],
    ["evictions", info.evictions > 0 ? String(info.evictions) : null],
    ["requeueAt", date(requeueAt)],
    ["maxExecution", num(get(obj, "spec", "maximumExecutionTimeSeconds"))?.toString()],
  ];
  const requests = new Map(arr(get(obj, "status", "resourceRequests")).map((r) => [str(get(r, "name")) ?? "", get(r, "resources")]));
  const assignments = new Map(arr(get(obj, "status", "admission", "podSetAssignments")).map((a) => [str(get(a, "name")) ?? "", a]));
  const podSets = arr(get(obj, "spec", "podSets")).map((p) => {
    const name = str(get(p, "name")) ?? "main";
    const count = num(get(p, "count")) ?? 1;
    const min = num(get(p, "minCount"));
    const assigned = assignments.get(name);
    return [
      name,
      min === undefined ? String(count) : t("kueue:podSets.minCount", { count, min }),
      quantities(requests.get(name) ?? get(assigned, "resourceUsage")),
      quantities(get(assigned, "flavors")),
    ];
  });
  const checks = arr(get(obj, "status", "admissionChecks")).map((c) => {
    const state = str(get(c, "state")) ?? "";
    const tone = state === "Ready" ? "success" : state === "Rejected" ? "danger" : "warning";
    return [link(TYPES.admissionCheck, str(get(c, "name"))), <StatusText key="s" value={state} tone={tone} />, str(get(c, "message")) ?? "", date(str(get(c, "lastTransitionTime")))];
  });
  const evictions = evictionsOf(obj).map((e) => [e.reason, e.cause ?? "", String(e.count)]);
  const podSetTable = table("kueuePodSets", [t("kueue:podSets.name"), t("kueue:podSets.count"), t("kueue:podSets.requests"), t("kueue:podSets.flavors")], podSets, PODSET_WRAP);
  const checkTable = table("kueueChecks", [t("kueue:checks.name"), t("kueue:checks.state"), t("kueue:checks.message"), t("kueue:checks.since")], checks, CHECK_WRAP);
  const evictionTable = table("kueueEvictions", [t("kueue:evictions.reason"), t("kueue:evictions.cause"), t("kueue:evictions.count")], evictions, EVICTION_WRAP);
  return (
    <>
      <WorkloadWhy obj={obj} info={info} />
      <Fields rows={rows} labelPrefix={LABELS} />
      {podSets.length > 0 && (
        <Block id="kueue:podSets.title" title={t("kueue:podSets.title")}>
          {podSetTable}
        </Block>
      )}
      {checks.length > 0 && (
        <Block id="kueue:checks.title" title={t("kueue:checks.title")}>
          {checkTable}
        </Block>
      )}
      {evictions.length > 0 && (
        <Block id="kueue:evictions.title" title={t("kueue:evictions.title")}>
          {evictionTable}
        </Block>
      )}
    </>
  );
}

/** One Workload of a job in short: its link and state, why, and its queues. */
export function WorkloadSummary({ obj }: { obj: KubeObject }) {
  const ns = obj.metadata?.namespace ?? null;
  const info = workloadInfo(obj);
  const rows: FieldRow[] = [
    ["workload", link(TYPES.workload, obj.metadata?.name, ns)],
    ["status", <WorkloadStateText key="s" obj={obj} />],
    ["queue", link(TYPES.localQueue, info.queue, ns)],
    ["clusterQueue", link(TYPES.clusterQueue, info.clusterQueue)],
    ["evictions", info.evictions > 0 ? String(info.evictions) : null],
  ];
  return (
    <>
      <WorkloadWhy obj={obj} info={info} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}
