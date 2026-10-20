// Columns of the Argo Workflows tables, as `argo list` shows them: a Workflow's phase, progress (pods done of all),
// duration and the step that failed with its message; a CronWorkflow's schedule, suspension, active runs and last
// run; a template's entrypoint and templates.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { Age, ageParts } from "../../components";
import { column, standardColumns, status, StatusText, type ColumnDef } from "../../resources";
import {
  activeWorkflows,
  cronSuspended,
  failedNode,
  failureMessage,
  lastScheduled,
  phaseTone,
  progressOf,
  schedulesOf,
  templateSummary,
  workflowDuration,
  workflowPhase,
} from "./model";

const { get, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<Omit<ColumnDef, "id" | "value">> = {}): ColumnDef => ({
  ...column(id, value, options),
  titleKey: `argoworkflows:columns.${id}`,
});

/** A duration in the largest whole unit, as ages are shown ("45s", "3m", "2h"). */
export function DurationText({ ms }: { ms: number | undefined }) {
  const { t } = useTranslation();
  if (ms === undefined) return null;
  const { unit, count } = ageParts(ms);
  return <>{t(`common:age.${unit}`, { count })}</>;
}

export function PhaseText({ phase }: { phase: string | undefined }) {
  return phase ? <StatusText value={phase} tone={phaseTone(phase)} /> : null;
}

/** "step: message" of the node that failed (or the Workflow's message). */
export function useFailedStep(wf: KubeObject): string | undefined {
  const { t } = useTranslation();
  return failedStepText(wf, (step, message) => t("argoworkflows:failedStep", { step, message }));
}

function failedStepText(wf: KubeObject, join: (step: string, message: string) => string): string | undefined {
  const phase = workflowPhase(wf);
  if (phase !== "Failed" && phase !== "Error") return undefined;
  const node = failedNode(wf);
  const message = failureMessage(wf, node);
  if (node && message) return join(node.displayName, message);
  return node?.displayName ?? message;
}

function FailedStepCell({ obj }: { obj: KubeObject }) {
  const text = useFailedStep(obj);
  return text ? <span title={text}>{text}</span> : null;
}

export const workflowColumns: ColumnDef[] = standardColumns(
  true,
  col("phase", workflowPhase, { width: "110px", render: (o) => <PhaseText phase={workflowPhase(o)} /> }),
  col("progress", progressOf, { width: "90px" }),
  col("duration", (o) => workflowDuration(o, Date.now()) ?? null, {
    width: "90px",
    render: (o, ctx) => <DurationText ms={workflowDuration(o, ctx.now)} />,
  }),
  col("failedStep", (o) => failedStepText(o, (step, message) => `${step}: ${message}`), {
    width: "minmax(200px, 3fr)",
    render: (o) => <FailedStepCell obj={o} />,
  }),
);

function YesCell({ value }: { value: boolean }) {
  const { t } = useTranslation();
  return value ? <>{t("argoworkflows:yes")}</> : null;
}

export const cronWorkflowColumns: ColumnDef[] = standardColumns(
  true,
  col("schedule", (o) => schedulesOf(o).join(", "), { width: "minmax(120px, 1fr)" }),
  col("suspended", cronSuspended, { width: "100px", render: (o) => <YesCell value={cronSuspended(o)} /> }),
  col("active", (o) => activeWorkflows(o).length, { width: "80px" }),
  col("lastScheduled", (o) => Date.parse(lastScheduled(o) ?? "") || null, {
    width: "120px",
    render: (o, ctx) => <Age timestamp={lastScheduled(o)} now={ctx.now} />,
  }),
);

export const templateColumns = (namespaced: boolean): ColumnDef[] =>
  standardColumns(
    namespaced,
    col("entrypoint", (o) => templateSummary(o).entrypoint, { width: "minmax(120px, 1fr)" }),
    col("templates", (o) => templateSummary(o).templates.length, { width: "100px" }),
  );

/** The CronWorkflow that started a Workflow (its label). */
export const cronOf = (wf: KubeObject): string | undefined =>
  str((wf.metadata?.labels as Record<string, unknown> | undefined)?.["workflows.argoproj.io/cron-workflow"]);

/** The WorkflowTemplate (or ClusterWorkflowTemplate) a Workflow was made from. */
export const templateRefOf = (wf: KubeObject): { name: string; cluster: boolean } | undefined => {
  const name = str(get(wf, "spec", "workflowTemplateRef", "name"));
  return name ? { name, cluster: get(wf, "spec", "workflowTemplateRef", "clusterScope") === true } : undefined;
};
