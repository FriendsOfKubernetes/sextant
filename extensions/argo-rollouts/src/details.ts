// The details sections of Argo Rollouts objects (the manifest's `contributes.detailsSections`):
//   rollout           — the status in plain words, strategy, step, set and actual weight, why it is paused, the
//                       Services; the canary steps with the current one marked; its ReplicaSets by role (stable,
//                       canary, active, preview) and its AnalysisRuns with the failing measurement's message;
//   analysis-run      — the phase, its Rollout, each metric's counts and the failing measurement;
//   experiment        — the phase, its templates and analyses;
//   template-metrics  — the metrics of an (Cluster)AnalysisTemplate and their providers.
// Each frame reads the shown object again whenever its resourceVersion changes. Conditions and YAML are Sextant's own
// sections. The actions are in ./actions.ts.
import { ui, type KubeObject, type ObjectRef, type RefInput, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { ago, element, errorText } from "./dom";
import { t } from "./i18n";
import { watchRolloutLists, type RolloutLists } from "./live";
import {
  actualWeight,
  ANALYSIS_RUN,
  analysisFailure,
  analysisPhase,
  analysisRunsOf,
  analysisTone,
  arr,
  blueGreenServices,
  canaryAvailable,
  canaryServices,
  canarySteps,
  currentHash,
  currentStepIndex,
  get,
  isAborted,
  metricResults,
  ownerRollout,
  pauseConditions,
  PHASE_TONE,
  REPLICA_SET,
  replicaSetsOf,
  ROLLOUT,
  rolloutPhase,
  runStarted,
  SERVICE,
  setWeight,
  stableHash,
  stepProgress,
  stepText,
  str,
  strategyOf,
  STRATEGY_TEXT,
  templateMetrics,
  type Tone,
} from "./model";

/** A link to an object's details in Sextant's panel. */
const link = (sextant: Sextant, ref: RefInput, text?: string) => ui.objectLink(sextant, ref as ObjectRef, text ?? ref.name);

/** A status word in its tone, with an explanation on hover. */
function badge(text: string, tone: Tone, title?: string): HTMLElement {
  const node = ui.status(text, tone);
  if (title) node.title = title;
  return node;
}

/** `ui.fields`, or nothing when no row has a value. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows);
  return list.childElementCount > 0 ? list : null;
}

/** The built-in view's details tables: words stay whole, the columns marked `true` on one line. */
const WORDS = [true, true, true, false];
const METRIC_COLUMNS = [true, true, true, true, true, true, false, false];
const FIRST_TWO = [true, true, false];

/** `ui.table`, or nothing without rows; its columns resize and Sextant keeps their widths under `id`, as the built-in view's. */
const tableOf = (sextant: Sextant, id: string, headers: string[], rows: UiContent[][], label: string, nowrap: readonly boolean[]): HTMLElement | null =>
  rows.length > 0 ? ui.table(headers, rows, { label, id, sextant, nowrap }) : null;

const present = (nodes: (Node | null)[]): Node[] => nodes.filter((n): n is Node => n !== null);

/** The explanation of a phase: the controller's message, else the extension's own reason. */
function phaseExplanation(ro: KubeObject): string | undefined {
  const { message, reasonKey } = rolloutPhase(ro);
  return message || (reasonKey ? t(`phaseReason.${reasonKey}`) : undefined);
}

export function rolloutStatusBadge(ro: KubeObject): HTMLElement {
  const { phase } = rolloutPhase(ro);
  return badge(phase, PHASE_TONE[phase], phaseExplanation(ro));
}

const weightText = (weight: number) => t("weightValue", { weight });

function statusView(sextant: Sextant, ro: KubeObject, weight: number | undefined): Node[] {
  const ns = ro.metadata.namespace ?? null;
  const strategy = strategyOf(ro);
  const bg = blueGreenServices(ro);
  const cs = canaryServices(ro);
  const service = (name: string | undefined, hash?: string) =>
    name ? link(sextant, { kind: SERVICE, namespace: ns, name }, hash ? t("selects", { service: name, hash }) : name) : undefined;
  const pausedBy = pauseConditions(ro)
    .map((p) => str(get(p, "reason")))
    .filter(Boolean)
    .join(", ");
  const explanation = phaseExplanation(ro);
  return present([
    explanation ? element("p", { className: "explain", textContent: explanation }) : null,
    isAborted(ro) ? element("p", { className: "explain error", textContent: t("abortedText") }) : null,
    fieldsOf([
      [t("fields.phase"), rolloutStatusBadge(ro)],
      [t("fields.strategy"), strategy ? STRATEGY_TEXT[strategy] : undefined],
      [t("fields.step"), stepProgress(ro)],
      [t("fields.setWeight"), strategy === "canary" ? weightText(setWeight(ro)) : undefined],
      [t("fields.actualWeight"), weight === undefined ? undefined : weightText(weight)],
      [t("fields.pausedBy"), pausedBy || undefined],
      [t("fields.activeService"), service(bg.active, bg.activeSelector)],
      [t("fields.previewService"), service(bg.preview, bg.previewSelector)],
      [t("fields.stableService"), service(cs.stable)],
      [t("fields.canaryService"), service(cs.canary)],
      [t("fields.stableHash"), stableHash(ro)],
      [t("fields.currentHash"), currentHash(ro)],
    ]),
  ]);
}

function stepsView(ro: KubeObject): HTMLElement | null {
  const steps = canarySteps(ro);
  if (steps.length === 0) return null;
  const current = currentStepIndex(ro) ?? 0;
  const list = element(
    "ol",
    { className: "steps" },
    ...steps.map((step, i) => {
      const state = i < current ? "done" : i === current ? "current" : "todo";
      const item = element(
        "li",
        { className: `step ${state}` },
        element("code", { textContent: stepText(step) }),
        state === "current" ? element("span", { className: "step-mark", textContent: t("stepCurrent") }) : null,
      );
      if (state === "current") item.setAttribute("aria-current", "step");
      return item;
    }),
  );
  return ui.block(t("sections.steps"), [
    list,
    current >= steps.length ? element("p", { className: "explain", textContent: t("stepsDoneAll") }) : null,
  ]);
}

/** A list's table, or why it has no rows yet; and why it is not whole. */
function listBlock(title: string, table: HTMLElement | null, list: { ready: boolean; error: string | null } | undefined, none: string): HTMLElement {
  return ui.block(title, [
    table ?? (list?.ready ? ui.empty(t(none)) : ui.loading(t("loading"))),
    list?.error ? ui.errorState(list.error) : null,
  ]);
}

function replicaSetsView(sextant: Sextant, ro: KubeObject, lists: RolloutLists | null): HTMLElement {
  const ns = ro.metadata.namespace ?? null;
  const list = lists?.replicaSets;
  const rows = replicaSetsOf(ro, list?.items ?? []).map((s) => [
    link(sextant, { kind: REPLICA_SET, namespace: ns, name: s.name }),
    ui.status(t(`roles.${s.role}`), s.role === "old" ? "muted" : "neutral"),
    s.revision === undefined ? null : String(s.revision),
    t("availableOf", { available: s.available, desired: s.desired }),
  ]);
  const headers = ["name", "role", "revision", "available"].map((h) => t(`table.${h}`));
  return listBlock(t("sections.replicaSets"), tableOf(sextant, "rolloutReplicaSets", headers, rows, t("sections.replicaSets"), WORDS), list, "noReplicaSets");
}

function analysisRunsView(sextant: Sextant, ro: KubeObject, lists: RolloutLists | null, now: number): HTMLElement {
  const ns = ro.metadata.namespace ?? null;
  const list = lists?.analysisRuns;
  const rows = analysisRunsOf(ro, list?.items ?? []).map((run) => {
    const phase = analysisPhase(run);
    const failure = phase === "Successful" ? undefined : analysisFailure(run);
    return [
      link(sextant, { kind: ANALYSIS_RUN, namespace: ns, name: run.metadata.name }),
      phase ? ui.status(phase, analysisTone(phase)) : null,
      ago(runStarted(run), now),
      failure ?? null,
    ];
  });
  const headers = ["name", "phase", "started", "message"].map((h) => t(`table.${h}`));
  return listBlock(t("sections.analysisRuns"), tableOf(sextant, "rolloutAnalysisRuns", headers, rows, t("sections.analysisRuns"), WORDS), list, "noAnalysisRuns");
}

/** The whole Rollout section: what the lists say so far (`null` before they start). */
export function rolloutView(sextant: Sextant, ro: KubeObject, lists: RolloutLists | null, now = Date.now()): Node[] {
  const sets = replicaSetsOf(ro, lists?.replicaSets.items ?? []);
  const weight = actualWeight(ro, lists?.replicaSets.ready ? (canaryAvailable(ro, sets) ?? 0) : undefined);
  return present([
    ...statusView(sextant, ro, weight),
    stepsView(ro),
    replicaSetsView(sextant, ro, lists),
    analysisRunsView(sextant, ro, lists, now),
  ]);
}

export function analysisRunView(sextant: Sextant, run: KubeObject): Node[] {
  const ns = run.metadata.namespace ?? null;
  const phase = analysisPhase(run);
  const owner = ownerRollout(run);
  const metrics = metricResults(run).map((m) => [
    m.name,
    m.phase ? ui.status(m.phase, analysisTone(m.phase)) : null,
    String(m.successful),
    String(m.failed),
    String(m.inconclusive),
    String(m.error),
    m.measurements[0]?.value ?? null,
    m.failing?.message || m.message || null,
  ]);
  const headers = ["metric", "phase", "successful", "failed", "inconclusive", "error", "lastValue", "message"].map((h) => t(`table.${h}`));
  const content = tableOf(sextant, "analysisMetrics", headers, metrics, t("sections.metrics"), METRIC_COLUMNS);
  return present([
    fieldsOf([
      [t("fields.phase"), phase ? ui.status(phase, analysisTone(phase)) : undefined],
      [t("fields.rollout"), owner ? link(sextant, { kind: ROLLOUT, namespace: ns, name: owner }) : undefined],
      [t("fields.failure"), phase === "Successful" ? undefined : analysisFailure(run)],
    ]),
    content ? ui.block(t("sections.metrics"), content) : null,
  ]);
}

export function experimentView(sextant: Sextant, exp: KubeObject): Node[] {
  const ns = exp.metadata.namespace ?? null;
  const phase = analysisPhase(exp);
  const owner = ownerRollout(exp);
  const templates = arr(get(exp, "status", "templateStatuses")).map((s) => {
    const value = str(get(s, "status"));
    return [str(get(s, "name")) ?? null, value ? ui.status(value, analysisTone(value)) : null, str(get(s, "message")) ?? null];
  });
  const analyses = arr(get(exp, "status", "analysisRuns")).map((a) => {
    const value = str(get(a, "phase"));
    const run = str(get(a, "analysisRun"));
    const label = str(get(a, "name")) ?? run;
    return [
      run ? link(sextant, { kind: ANALYSIS_RUN, namespace: ns, name: run }, label) : (label ?? null),
      value ? ui.status(value, analysisTone(value)) : null,
      str(get(a, "message")) ?? null,
    ];
  });
  const head = (keys: string[]) => keys.map((h) => t(`table.${h}`));
  const templateTable = tableOf(sextant, "experimentTemplates", head(["template", "status", "message"]), templates, t("sections.templates"), FIRST_TWO);
  const analysisTable = tableOf(sextant, "experimentAnalyses", head(["name", "phase", "message"]), analyses, t("sections.analysisRuns"), FIRST_TWO);
  return present([
    fieldsOf([
      [t("fields.phase"), phase ? ui.status(phase, analysisTone(phase)) : undefined],
      [t("fields.message"), str(get(exp, "status", "message"))],
      [t("fields.rollout"), owner ? link(sextant, { kind: ROLLOUT, namespace: ns, name: owner }) : undefined],
    ]),
    templateTable ? ui.block(t("sections.templates"), templateTable) : null,
    analysisTable ? ui.block(t("sections.analysisRuns"), analysisTable) : null,
  ]);
}

export function templateView(sextant: Sextant, obj: KubeObject): Node[] {
  const rows = templateMetrics(obj).map((m) => [m.name, m.provider ?? null]);
  return present([tableOf(sextant, "analysisTemplateMetrics", [t("table.metric"), t("table.provider")], rows, t("sections.metrics"), [true, true])]);
}

const VIEWS: Record<string, (sextant: Sextant, obj: KubeObject) => Node[]> = {
  "analysis-run": analysisRunView,
  experiment: experimentView,
  "template-metrics": templateView,
};

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes; a Rollout also watches its namespace's ReplicaSets and AnalysisRuns while shown. A section with nothing to
 * show (a template without metrics) hides itself, title included, until it has something (`ui.setHidden`).
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let lists: RolloutLists | null = null;
  let stopLists: () => void = () => undefined;
  let hidden = false;

  /** Shows `nodes`, hiding the section while there are none. */
  const show = (nodes: Node[]) => {
    root.replaceChildren(...nodes);
    const empty = nodes.length === 0;
    if (empty === hidden) return;
    hidden = empty;
    void sextant.ui.setHidden(empty).catch(() => undefined);
  };

  const render = () => {
    if (!object) return;
    show(contribution === "rollout" ? rolloutView(sextant, object, lists) : (VIEWS[contribution]?.(sextant, object) ?? []));
  };

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      object = fresh;
      render();
    } catch (err) {
      if (attempt === reading) show([ui.errorState(errorText(err))]);
    }
  };

  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      show([ui.empty(t("common.nothingSelected"))]);
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shownRef) {
      shownRef = key;
      shownVersion = undefined;
      object = null;
      stopLists();
      lists = null;
      show([ui.loading(t("loading"))]);
      if (contribution === "rollout" && ref.namespace) {
        stopLists = watchRolloutLists(sextant, ref.namespace, (now) => {
          lists = now;
          render();
        });
      }
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) return;
    shownVersion = version;
    void read(ref);
  };
  follow();
  const stopFollow = sextant.onContextChange(follow);
  return () => {
    stopFollow();
    stopLists();
  };
}
