// Columns of the Argo Rollouts tables, as `kubectl argo rollouts list rollouts` shows them: the status (Healthy,
// Progressing, Paused, Degraded) with the controller's message on hover, the strategy, the step and the set weight;
// AnalysisRuns and Experiments by their phase and message; templates by their metrics.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { column, standardColumns, status, StatusText, type ColumnDef } from "../../resources";
import {
  analysisFailure,
  analysisPhase,
  analysisTone,
  currentStepIndex,
  PHASE_TONE,
  rolloutPhase,
  setWeight,
  stepProgress,
  strategyOf,
  templateMetrics,
} from "./model";

const { get, num, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<Omit<ColumnDef, "id" | "value">> = {}): ColumnDef => ({
  ...column(id, value, options),
  titleKey: `argorollouts:columns.${id}`,
});

/** The strategy as the plugin prints it. */
export const STRATEGY_TEXT = { canary: "Canary", blueGreen: "BlueGreen" } as const;

export function RolloutStatus({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const { phase, message, reasonKey } = rolloutPhase(obj);
  const title = message ?? (reasonKey ? t(`argorollouts:phaseReason.${reasonKey}`) : undefined);
  return (
    <span title={title}>
      <StatusText value={phase} tone={PHASE_TONE[phase]} />
    </span>
  );
}

function WeightCell({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  if (strategyOf(obj) !== "canary") return null;
  return <>{t("argorollouts:weightValue", { weight: setWeight(obj) })}</>;
}

const readyText = (o: KubeObject) => `${num(get(o, "status", "readyReplicas")) ?? 0}/${num(get(o, "spec", "replicas")) ?? 1}`;

export const rolloutColumns: ColumnDef[] = standardColumns(
  true,
  col("status", (o) => rolloutPhase(o).phase, { width: "120px", render: (o) => <RolloutStatus obj={o} /> }),
  col("strategy", (o) => {
    const s = strategyOf(o);
    return s ? STRATEGY_TEXT[s] : undefined;
  }, { width: "100px" }),
  col("step", (o) => currentStepIndex(o) ?? null, { width: "80px", render: (o) => stepProgress(o) ?? null }),
  col("weight", (o) => (strategyOf(o) === "canary" ? setWeight(o) : null), { width: "80px", render: (o) => <WeightCell obj={o} /> }),
  col("ready", readyText, { width: "80px" }),
);

function PhaseCell({ obj }: { obj: KubeObject }) {
  const phase = analysisPhase(obj);
  return phase ? <StatusText value={phase} tone={analysisTone(phase)} /> : null;
}

function Truncated({ text }: { text: string | undefined }) {
  return text ? <span title={text}>{text}</span> : null;
}

/** The Rollout that owns an AnalysisRun or Experiment. */
export const ownerRollout = (o: KubeObject): string | undefined =>
  str(get(status.arr(o.metadata?.ownerReferences).find((r) => get(r, "kind") === "Rollout"), "name"));

export const analysisRunColumns: ColumnDef[] = standardColumns(
  true,
  col("phase", analysisPhase, { width: "110px", render: (o) => <PhaseCell obj={o} /> }),
  col("rollout", ownerRollout, { width: "minmax(120px, 1fr)" }),
  col("message", analysisFailure, { width: "minmax(180px, 3fr)", render: (o) => <Truncated text={analysisFailure(o)} /> }),
);

const experimentMessage = (o: KubeObject) => str(get(o, "status", "message"));

export const experimentColumns: ColumnDef[] = standardColumns(
  true,
  col("phase", analysisPhase, { width: "110px", render: (o) => <PhaseCell obj={o} /> }),
  col("rollout", ownerRollout, { width: "minmax(120px, 1fr)" }),
  col("message", experimentMessage, {
    width: "minmax(180px, 3fr)",
    render: (o) => <Truncated text={experimentMessage(o)} />,
  }),
);

export const templateColumns = (namespaced: boolean): ColumnDef[] =>
  standardColumns(
    namespaced,
    col("metrics", (o) => templateMetrics(o).map((m) => m.name).join(", "), { width: "minmax(180px, 3fr)" }),
  );
