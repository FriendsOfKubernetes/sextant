import { useDetailsDisclosure } from "../../layout/details/disclosure";
// Details of a JobSet (section `jobset`): its state, and when it failed the controller's reason and message with the
// first failed Job and that Job's own failure reason; restarts against `failurePolicy.maxRestarts`; the success,
// failure and startup policies; the replicated jobs with their counts; its Jobs and their pods (links). Conditions,
// events and YAML are the panel's own sections. Read-only.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { formatDateTime, formatList } from "../../i18n";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { JobSetStateText } from "./columns";
import { MAX_CHILDREN, useJobSetJobs, useJobSetPods, type Children } from "./hooks";
import {
  conditionOf,
  failureRules,
  firstFailedJob,
  isJobSet,
  JOB_INDEX_LABEL,
  JOB_TONE,
  jobSetState,
  jobState,
  labelOf,
  REPLICATED_JOB_LABEL,
  replicatedJobs,
  RESTART_ATTEMPT_LABEL,
  restartsOf,
  successPolicyOf,
} from "./model";

const { get, num, str } = status;
const LABELS = "jobset:fields";
/** Pods listed at most (not running first). */
export const MAX_LISTED_PODS = 50;

const date = (value: string | undefined): ReactNode => (value ? <time dateTime={value}>{formatDateTime(value)}</time> : null);

function Note({ text, tone }: { text: string; tone: "warning" | "danger" }) {
  return <p className={`jobset-note jobset-note--${tone}`}>{text}</p>;
}

function Muted({ text }: { text: string }) {
  return <p className="jobset-muted">{text}</p>;
}

/** Why it failed: the Failed condition, the first failed Job and that Job's own reason. */
function Failure({ obj, jobs }: { obj: KubeObject; jobs: Children }) {
  const { t } = useTranslation();
  const failed = conditionOf(obj, "Failed");
  const first = firstFailedJob(failed?.message);
  const job = first ? jobs.items.find((j) => j.metadata?.name === first) : undefined;
  const reason = job ? jobState(job) : undefined;
  const firstRows: FieldRow[] = [["firstFailedJob", link(KINDS.job, first, obj.metadata?.namespace ?? null)]];
  return (
    <>
      <Note text={[failed?.reason, failed?.message].filter(Boolean).join(": ") || t("jobset:failedNoReason")} tone="danger" />
      {first && <Fields rows={firstRows} labelPrefix={LABELS} />}
      {reason?.state === "failed" && <Note text={[reason.reason, reason.message].filter(Boolean).join(": ")} tone="danger" />}
      {first && !job && !jobs.loading && <Muted text={t("jobset:failedJobGone")} />}
    </>
  );
}

const REPLICATED_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", "nowrap", "nowrap", "nowrap", undefined];
const RULE_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined, undefined];
const JOB_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", "nowrap", undefined];
const POD_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap"];

function JobsBlock({ obj, jobs }: { obj: KubeObject; jobs: Children }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const rows = jobs.items.map((j) => {
    const s = jobState(j);
    return [
      link(KINDS.job, j.metadata?.name, ns),
      labelOf(j, REPLICATED_JOB_LABEL) ?? "",
      labelOf(j, JOB_INDEX_LABEL) ?? "",
      <StatusText key="s" value={t(`jobset:jobState.${s.state}`)} tone={JOB_TONE[s.state]} />,
      labelOf(j, RESTART_ATTEMPT_LABEL) ?? "",
      [s.reason, s.message].filter(Boolean).join(": "),
    ];
  });
  const headers = ["job", "replicatedJob", "index", "state", "attempt", "reason"].map((h) => t(`jobset:jobs.${h}`));
  const list = table("jobsetJobs", headers, rows, JOB_WRAP);
  return (
    <Block id="jobset:jobs.title" title={t("jobset:jobs.title")}>
      {jobs.loading ? <Muted text={t("jobset:loading")} /> : rows.length > 0 ? list : <Muted text={jobs.failed ? t("jobset:listUnknown") : t("jobset:noJobs")} />}
      {jobs.truncated && <Muted text={t("jobset:truncated", { max: MAX_CHILDREN })} />}
    </Block>
  );
}

const RUNNING = new Set(["Running", "Succeeded", "Completed"]);

function PodsBlock({ obj, pods }: { obj: KubeObject; pods: Children }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const sorted = [...pods.items].sort((a, b) => Number(RUNNING.has(status.podStatus(a))) - Number(RUNNING.has(status.podStatus(b))));
  const shown = sorted.slice(0, MAX_LISTED_PODS);
  const rows = shown.map((p) => {
    const phase = status.podStatus(p);
    return [link(KINDS.pod, p.metadata?.name, ns), labelOf(p, "batch.kubernetes.io/job-name") ?? labelOf(p, "job-name") ?? "", <StatusText key="s" value={phase} tone={status.statusTone(phase)} />];
  });
  const headers = [t("jobset:pods.pod"), t("jobset:pods.job"), t("jobset:pods.status")];
  const list = table("jobsetPods", headers, rows, POD_WRAP);
  return (
    <Block id="jobset:pods.title" title={t("jobset:pods.title")}>
      {pods.loading ? <Muted text={t("jobset:loading")} /> : rows.length > 0 ? list : <Muted text={pods.failed ? t("jobset:listUnknown") : t("jobset:noPods")} />}
      {sorted.length > shown.length && <Muted text={t("jobset:morePods", { shown: shown.length, total: sorted.length })} />}
      {pods.truncated && <Muted text={t("jobset:truncated", { max: MAX_CHILDREN })} />}
    </Block>
  );
}

/** The success policy in words: `All`/`Any` Job of the targets (every replicated job without targets). */
function successText(success: ReturnType<typeof successPolicyOf>, t: (key: string, values?: Record<string, string>) => string): string {
  const op = success.operator === "Any" ? "any" : "all";
  if (success.targets.length === 0) return t(`jobset:success.${op}`);
  return t(`jobset:success.${op}Of`, { targets: formatList(success.targets) });
}

function JobSetView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const state = jobSetState(obj);
  const jobsOpen = useDetailsDisclosure("jobset:jobs.title")?.open ?? true;
  const podsOpen = useDetailsDisclosure("jobset:pods.title")?.open ?? true;
  const jobs = useJobSetJobs(clusterId, jobsOpen || state === "failed" ? obj : null);
  const pods = useJobSetPods(clusterId, podsOpen ? obj : null);
  const restarts = restartsOf(obj);
  const success = successPolicyOf(obj);
  const coordinator = get(obj, "spec", "coordinator");
  const coordinatorText = str(get(coordinator, "replicatedJob"))
    ? `${str(get(coordinator, "replicatedJob"))}-${num(get(coordinator, "jobIndex")) ?? 0}-${num(get(coordinator, "podIndex")) ?? 0}`
    : undefined;
  const nearLimit = restarts.max !== undefined && restarts.max > 0 && restarts.counted >= restarts.max - 1 && state !== "failed" && state !== "completed";
  const rows: FieldRow[] = [
    ["status", <JobSetStateText key="s" obj={obj} />],
    ["terminalState", str(get(obj, "status", "terminalState"))],
    ["restarts", restarts.max === undefined ? String(restarts.total) : t("jobset:restartsOfMax", { counted: restarts.counted, max: restarts.max, total: restarts.total })],
    ["restartStrategy", str(get(obj, "spec", "failurePolicy", "restartStrategy")) ?? (restarts.max === undefined ? null : "Recreate")],
    ["successPolicy", successText(success, t)],
    ["startupPolicy", str(get(obj, "spec", "startupPolicy", "startupPolicyOrder"))],
    ["suspend", get(obj, "spec", "suspend") === true ? t("jobset:yes") : null],
    ["startTime", date(str(get(obj, "status", "startTime")))],
    ["activeDeadline", num(get(obj, "spec", "activeDeadlineSeconds"))?.toString()],
    ["ttlAfterFinished", num(get(obj, "spec", "ttlSecondsAfterFinished"))?.toString()],
    ["subdomain", str(get(obj, "spec", "network", "subdomain"))],
    ["coordinator", coordinatorText],
    ["managedBy", str(get(obj, "spec", "managedBy"))],
  ];
  const replicated = replicatedJobs(obj).map((r) => [
    r.name,
    String(r.replicas),
    r.completions === undefined && r.parallelism === undefined ? "" : `${r.completions ?? 1}/${r.parallelism ?? 1}`,
    String(r.ready),
    String(r.active),
    String(r.succeeded),
    r.failed > 0 ? <StatusText key="f" value={String(r.failed)} tone="danger" /> : "0",
    chips(r.dependsOn),
  ]);
  const rules = failureRules(obj).map((r) => [r.name, r.action, chips([...r.reasons, ...r.patterns]), chips(r.targets)]);
  const repHeaders = ["name", "replicas", "completions", "ready", "active", "succeeded", "failed", "dependsOn"].map((h) => t(`jobset:replicated.${h}`));
  const ruleHeaders = ["name", "action", "onFailure", "targets"].map((h) => t(`jobset:rules.${h}`));
  const replicatedTable = table("jobsetReplicated", repHeaders, replicated, REPLICATED_WRAP);
  const rulesTable = table("jobsetRules", ruleHeaders, rules, RULE_WRAP);
  return (
    <>
      {state === "failed" && <Failure obj={obj} jobs={jobs} />}
      {nearLimit && <Note text={t("jobset:nearLimit", { counted: restarts.counted, max: restarts.max })} tone="warning" />}
      {state === "suspended" && <Muted text={t("jobset:suspendedNote")} />}
      <Fields rows={rows} labelPrefix={LABELS} />
      {replicated.length > 0 && <Block id="jobset:replicated.title" title={t("jobset:replicated.title")}>{replicatedTable}</Block>}
      {rules.length > 0 && <Block id="jobset:rules.title" title={t("jobset:rules.title")}>{rulesTable}</Block>}
      <JobsBlock obj={obj} jobs={jobs} />
      <PodsBlock obj={obj} pods={pods} />
    </>
  );
}

export function JobSetSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj || !isJobSet(objectRef.kind)) return null;
  return <JobSetView clusterId={clusterId} obj={obj} />;
}
