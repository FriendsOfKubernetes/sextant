// Details of Argo Rollouts objects (one section, `argoRollouts`, for every kind of the section):
//   Rollout            — the status in plain words, strategy, step, set and actual weight, why it is paused, the
//                        Services; the canary steps with the current one marked; its ReplicaSets by role (stable,
//                        canary, active, preview) and its AnalysisRuns with the failing measurement's message;
//   AnalysisRun        — the phase, its Rollout, each metric's counts and the failing measurement;
//   Experiment         — the phase, its templates and analyses;
//   (Cluster)AnalysisTemplate — the metrics and their providers.
// Conditions and YAML are the panel's own sections. The actions are in ./actions.tsx.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { Age } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { Block, breakable, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { ownerRollout, RolloutStatus, STRATEGY_TEXT } from "./columns";
import { useRolloutLists } from "./hooks";
import {
  actualWeight,
  ANALYSIS_RUN,
  analysisFailure,
  analysisPhase,
  analysisRunsOf,
  analysisTone,
  blueGreenServices,
  canaryAvailable,
  canaryServices,
  canarySteps,
  currentHash,
  currentStepIndex,
  EXPERIMENT,
  isAborted,
  isKind,
  isRolloutsKind,
  metricResults,
  pauseConditions,
  replicaSetsOf,
  ROLLOUT,
  rolloutPhase,
  setWeight,
  stableHash,
  stepProgress,
  stepText,
  strategyOf,
  templateMetrics,
} from "./model";
import "./argo-rollouts.css";

const { arr, get, str } = status;

const FIELDS = "argorollouts:fields";
const API = "argoproj.io/v1alpha1";
const REPLICA_SET = { apiVersion: "apps/v1", kind: "ReplicaSet" };
const RUN_TYPE = { apiVersion: API, kind: ANALYSIS_RUN.kind };
const ROLLOUT_TYPE = { apiVersion: API, kind: ROLLOUT.kind };

const WORDS: readonly ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined];

function PhaseExplanation({ ro }: { ro: KubeObject }) {
  const { t } = useTranslation();
  const { message, reasonKey } = rolloutPhase(ro);
  const text = message || (reasonKey ? t(`argorollouts:phaseReason.${reasonKey}`) : undefined);
  return text ? <p className="ar-explain">{breakable(text)}</p> : null;
}

/** A Service link, labelled with the template hash it selects now ("name → hash"). */
function serviceLink(name: string | undefined, ns: string | null, label: string | undefined): ReactNode {
  return name ? link(KINDS.service, name, ns, label ?? name) : null;
}

function StatusBlock({ ro, weight }: { ro: KubeObject; weight: number | undefined }) {
  const { t } = useTranslation();
  const ns = ro.metadata?.namespace ?? null;
  const strategy = strategyOf(ro);
  const bg = blueGreenServices(ro);
  const cs = canaryServices(ro);
  const selects = (service: string | undefined, hash: string | undefined) =>
    service && hash ? t("argorollouts:selects", { service, hash }) : undefined;
  const pausedBy = pauseConditions(ro).map((p) => str(get(p, "reason"))).filter(Boolean).join(", ");
  const rows: FieldRow[] = [
    ["phase", <RolloutStatus key="p" obj={ro} />],
    ["strategy", strategy ? STRATEGY_TEXT[strategy] : undefined],
    ["step", stepProgress(ro)],
    ["setWeight", strategy === "canary" ? t("argorollouts:weightValue", { weight: setWeight(ro) }) : undefined],
    ["actualWeight", weight === undefined ? undefined : t("argorollouts:weightValue", { weight })],
    ["pausedBy", pausedBy || undefined],
    ["activeService", serviceLink(bg.active, ns, selects(bg.active, bg.activeSelector))],
    ["previewService", serviceLink(bg.preview, ns, selects(bg.preview, bg.previewSelector))],
    ["stableService", link(KINDS.service, cs.stable, ns)],
    ["canaryService", link(KINDS.service, cs.canary, ns)],
    ["stableHash", stableHash(ro)],
    ["currentHash", currentHash(ro)],
  ];
  return (
    <>
      <PhaseExplanation ro={ro} />
      {isAborted(ro) && <p className="ar-explain ar-explain--danger">{t("argorollouts:abortedText")}</p>}
      <Fields rows={rows} labelPrefix={FIELDS} />
    </>
  );
}

const stepState = (i: number, current: number) => (i < current ? "done" : i === current ? "current" : "todo");
const runStarted = (run: KubeObject) => str(get(run, "status", "startedAt")) ?? str(run.metadata?.creationTimestamp);

function Steps({ ro }: { ro: KubeObject }) {
  const { t } = useTranslation();
  const steps = canarySteps(ro);
  if (steps.length === 0) return null;
  const current = currentStepIndex(ro) ?? 0;
  const label = t("argorollouts:stepCurrent");
  return (
    <Block title={t("argorollouts:sections.steps")}>
      <ol className="ar-steps">
        {steps.map((step, i) => {
          const state = stepState(i, current);
          return (
            <li key={i} className={`ar-step ar-step--${state}`} aria-current={state === "current" ? "step" : undefined}>
              <code>{stepText(step)}</code>
              {state === "current" && <span className="ar-step__mark">{label}</span>}
            </li>
          );
        })}
      </ol>
      {current >= steps.length && <p className="ar-explain">{t("argorollouts:stepsDoneAll")}</p>}
    </Block>
  );
}

function ReplicaSetsBlock({ ro, sets, known }: { ro: KubeObject; sets: ReturnType<typeof replicaSetsOf>; known: boolean }) {
  const { t } = useTranslation();
  const ns = ro.metadata?.namespace ?? null;
  const rows = sets.map((s) => [
    link(REPLICA_SET, s.name, ns),
    <StatusText key="r" value={t(`argorollouts:roles.${s.role}`)} tone={s.role === "old" ? "muted" : "neutral"} />,
    s.revision === undefined ? null : String(s.revision),
    t("argorollouts:availableOf", { available: s.available, desired: s.desired }),
  ]);
  const headers = ["name", "role", "revision", "available"].map((h) => t(`argorollouts:table.${h}`));
  const content = table("argoRolloutReplicaSets", headers, rows, WORDS);
  return (
    <Block title={t("argorollouts:sections.replicaSets")}>
      {content ?? <p className="ar-muted">{t(known ? "argorollouts:noReplicaSets" : "argorollouts:loading")}</p>}
    </Block>
  );
}

function AnalysisRunsBlock({ ns, runs, known }: { ns: string | null; runs: KubeObject[]; known: boolean }) {
  const { t } = useTranslation();
  const rows = runs.map((run) => {
    const phase = analysisPhase(run);
    const failure = phase === "Successful" ? undefined : analysisFailure(run);
    return [
      link(RUN_TYPE, run.metadata?.name, ns),
      phase ? <StatusText key="p" value={phase} tone={analysisTone(phase)} /> : null,
      <Age key="a" timestamp={runStarted(run)} />,
      failure ? breakable(failure) : null,
    ];
  });
  const headers = ["name", "phase", "started", "message"].map((h) => t(`argorollouts:table.${h}`));
  const content = table("argoRolloutAnalysisRuns", headers, rows, WORDS);
  return (
    <Block title={t("argorollouts:sections.analysisRuns")}>
      {content ?? <p className="ar-muted">{t(known ? "argorollouts:noAnalysisRuns" : "argorollouts:loading")}</p>}
    </Block>
  );
}

function RolloutView({ clusterId, ro }: { clusterId: ClusterId; ro: KubeObject }) {
  const { t } = useTranslation();
  const ns = ro.metadata?.namespace ?? null;
  const lists = useRolloutLists(clusterId, ns);
  const sets = replicaSetsOf(ro, lists.replicaSets);
  const weight = actualWeight(ro, lists.replicaSetsKnown ? (canaryAvailable(ro, sets) ?? 0) : undefined);
  return (
    <>
      <Block title={t("argorollouts:sections.status")}>
        <StatusBlock ro={ro} weight={weight} />
      </Block>
      <Steps ro={ro} />
      <ReplicaSetsBlock ro={ro} sets={sets} known={lists.replicaSetsKnown} />
      <AnalysisRunsBlock ns={ns} runs={analysisRunsOf(ro, lists.analysisRuns)} known={lists.analysisRunsKnown} />
    </>
  );
}

const METRIC_COLUMNS: readonly ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap", "nowrap", "nowrap", undefined, undefined];

function AnalysisRunView({ run }: { run: KubeObject }) {
  const { t } = useTranslation();
  const ns = run.metadata?.namespace ?? null;
  const phase = analysisPhase(run);
  const rows: FieldRow[] = [
    ["phase", phase ? <StatusText key="p" value={phase} tone={analysisTone(phase)} /> : null],
    ["rollout", link(ROLLOUT_TYPE, ownerRollout(run), ns)],
    ["failure", phase === "Successful" ? undefined : analysisFailure(run)],
  ];
  const metrics = metricResults(run).map((m) => [
    m.name,
    m.phase ? <StatusText key="p" value={m.phase} tone={analysisTone(m.phase)} /> : null,
    String(m.successful),
    String(m.failed),
    String(m.inconclusive),
    String(m.error),
    m.measurements[0]?.value ? breakable(m.measurements[0].value) : null,
    m.failing?.message || m.message ? breakable(m.failing?.message || m.message || "") : null,
  ]);
  const headers = ["metric", "phase", "successful", "failed", "inconclusive", "error", "lastValue", "message"].map((h) =>
    t(`argorollouts:table.${h}`),
  );
  const content = table("argoAnalysisMetrics", headers, metrics, METRIC_COLUMNS);
  return (
    <>
      <Fields rows={rows} labelPrefix={FIELDS} />
      {content && <Block title={t("argorollouts:sections.metrics")}>{content}</Block>}
    </>
  );
}

function ExperimentView({ exp }: { exp: KubeObject }) {
  const { t } = useTranslation();
  const ns = exp.metadata?.namespace ?? null;
  const phase = analysisPhase(exp);
  const rows: FieldRow[] = [
    ["phase", phase ? <StatusText key="p" value={phase} tone={analysisTone(phase)} /> : null],
    ["message", str(get(exp, "status", "message"))],
    ["rollout", link(ROLLOUT_TYPE, ownerRollout(exp), ns)],
  ];
  const templates = arr(get(exp, "status", "templateStatuses")).map((s) => {
    const value = str(get(s, "status"));
    const message = str(get(s, "message"));
    return [str(get(s, "name")), value ? <StatusText key="s" value={value} tone={analysisTone(value)} /> : null, message ? breakable(message) : null];
  });
  const analyses = arr(get(exp, "status", "analysisRuns")).map((a) => {
    const value = str(get(a, "phase"));
    const message = str(get(a, "message"));
    return [
      link(RUN_TYPE, str(get(a, "analysisRun")), ns, str(get(a, "name"))),
      value ? <StatusText key="s" value={value} tone={analysisTone(value)} /> : null,
      message ? breakable(message) : null,
    ];
  });
  const head = (keys: string[]) => keys.map((h) => t(`argorollouts:table.${h}`));
  const templateTable = table("argoExperimentTemplates", head(["template", "status", "message"]), templates, ["nowrap", "nowrap", undefined]);
  const analysisTable = table("argoExperimentAnalyses", head(["name", "phase", "message"]), analyses, ["nowrap", "nowrap", undefined]);
  return (
    <>
      <Fields rows={rows} labelPrefix={FIELDS} />
      {templateTable && <Block title={t("argorollouts:sections.templates")}>{templateTable}</Block>}
      {analysisTable && <Block title={t("argorollouts:sections.analysisRuns")}>{analysisTable}</Block>}
    </>
  );
}

function TemplateView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const rows = templateMetrics(obj).map((m) => [m.name, m.provider ?? null]);
  const content = table("argoAnalysisTemplateMetrics", [t("argorollouts:table.metric"), t("argorollouts:table.provider")], rows, ["nowrap", "nowrap"]);
  return content ? <Block title={t("argorollouts:sections.metrics")}>{content}</Block> : null;
}

/** The section of every Argo Rollouts kind. */
export function RolloutsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj || !isRolloutsKind(objectRef.kind)) return null;
  const kind = objectRef.kind;
  if (isKind(kind, ROLLOUT)) return <RolloutView clusterId={clusterId} ro={obj} />;
  if (isKind(kind, ANALYSIS_RUN)) return <AnalysisRunView run={obj} />;
  if (isKind(kind, EXPERIMENT)) return <ExperimentView exp={obj} />;
  return <TemplateView obj={obj} />;
}
