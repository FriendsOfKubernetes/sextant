// Columns of the JobSet table: its state (running / completed / failed / suspended / …) with the Failed or Completed
// condition's message as the tooltip, its Jobs succeeded of all wanted, the failed ones, and restarts against the limit.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, StatusText, type ColumnDef } from "../../resources";
import { conditionOf, JOBSET_TONE, jobSetState, replicatedJobs, restartsOf } from "./model";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `jobset:columns.${id}`,
  value,
  ...options,
});

export function JobSetStateText({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const state = jobSetState(obj);
  const c = conditionOf(obj, state === "completed" ? "Completed" : "Failed");
  const title = state === "failed" || state === "completed" ? [c?.reason, c?.message].filter(Boolean).join(": ") : "";
  return (
    <span title={title || undefined}>
      <StatusText value={t(`jobset:state.${state}`)} tone={JOBSET_TONE[state]} />
    </span>
  );
}

const sum = (o: KubeObject, pick: (r: ReturnType<typeof replicatedJobs>[number]) => number) => replicatedJobs(o).reduce((n, r) => n + pick(r), 0);

export const jobSetColumns: ColumnDef[] = [
  nameColumn,
  namespaceColumn,
  col("status", jobSetState, { width: "120px", render: (o) => <JobSetStateText obj={o} /> }),
  col("succeeded", (o) => `${sum(o, (r) => r.succeeded)}/${sum(o, (r) => r.replicas)}`, { width: "100px" }),
  col("active", (o) => sum(o, (r) => r.active), { width: "80px" }),
  col("failed", (o) => sum(o, (r) => r.failed), { width: "80px" }),
  col(
    "restarts",
    (o) => {
      const r = restartsOf(o);
      return r.max === undefined ? String(r.total) : `${r.counted}/${r.max}`;
    },
    { width: "90px" },
  ),
  ageColumn,
];
