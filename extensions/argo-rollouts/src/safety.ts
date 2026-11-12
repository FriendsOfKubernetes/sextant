// How safe a canary or blue-green pipeline is set up, from its objects only (#341, ADR-0171): an analysis metric that
// passes without data or on NaN, one that cannot fail, a metric run dry, a Rollout promoted on time alone or that
// jumps weights without a check. Read as the controller of Argo Rollouts v1.10.2 evaluates them:
// - utils/evaluate/evaluate.go `EvaluateResult`: no successCondition and no failureCondition is Successful unless the
//   provider errors; only a failureCondition makes a measurement successful whenever that condition is false — and a
//   comparison with NaN is false; an expression that cannot be evaluated (`result[0]` of an empty result) is Error.
// - analysis/analysis.go `assessMetricFailureInconclusiveOrError`: a metric fails when failed > failureLimit (0 when
//   unset); a negative failureLimit never fails it; `assessMetricStatus`: a run terminated before its first measurement
//   is Successful.
// - utils/analysis/helpers.go `GetDryRunMetrics`: `dryRun[].metricName` is a regular expression over metric names.
// These are heuristics about intent, so they are an opt-in problem category and the agent tool calls them warnings.
// Pure: no DOM, no host.
import type { KubeObject } from "@sextant/extension-sdk";
import { arr, canarySteps, get, num, record, str, strategyOf } from "./model";

/** What a check found; `values` are the fact values of the problem judge (`contributes.problemJudges`). */
export interface SafetyFinding {
  code: SafetyCode;
  values: Record<string, string>;
}

export type SafetyCode =
  | "metric-always-passes"
  | "metric-nan-passes"
  | "metric-no-data-passes"
  | "metric-cannot-fail"
  | "metric-dry-run"
  | "promoted-on-time"
  | "weights-without-check"
  | "first-step-full"
  | "all-pods-unavailable";

/** Providers whose measurement is decided by the provider itself, not by the conditions. */
const OWN_VERDICT = new Set(["job", "kayenta", "plugin"]);

const compact = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A success condition that also holds when there is no data or the value is not a number. */
function passesWithoutData(condition: string): "no-data" | "nan" | undefined {
  const c = compact(condition);
  if (/len\(\s*result\s*\)\s*==\s*0\s*\|\|/.test(c) || /\|\|\s*len\(\s*result\s*\)\s*==\s*0/.test(c)) return "no-data";
  if (/\bdefault\(/.test(c)) return "no-data";
  if (/is(NaN|Inf)\([^)]*\)\s*\|\|/.test(c) || /\|\|\s*is(NaN|Inf)\(/.test(c)) return "nan";
  return undefined;
}

const intOf = (value: unknown): number | undefined => {
  const n = num(value);
  if (n !== undefined) return Math.trunc(n);
  return typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
};

/** Whether a dry-run rule (a regular expression, as Argo matches it) covers `metric`; a broken pattern covers nothing. */
function dryRun(rules: unknown[], metric: string): boolean {
  return rules.some((r) => {
    const pattern = str(get(r, "metricName"));
    if (!pattern) return false;
    try {
      return new RegExp(pattern).test(metric);
    } catch {
      return false;
    }
  });
}

/** The checks of an AnalysisTemplate's or ClusterAnalysisTemplate's metrics (`spec`). */
export function templateFindings(spec: unknown): SafetyFinding[] {
  const out: SafetyFinding[] = [];
  const dry = arr(get(spec, "dryRun"));
  for (const m of arr(get(spec, "metrics"))) {
    const metric = str(get(m, "name"));
    if (!metric) continue;
    const provider = Object.keys(record(get(m, "provider")))[0] ?? "";
    if (dryRun(dry, metric)) {
      out.push({ code: "metric-dry-run", values: { metric } });
      continue;
    }
    const success = str(get(m, "successCondition"));
    const failure = str(get(m, "failureCondition"));
    if (!OWN_VERDICT.has(provider)) {
      if (!success && !failure) out.push({ code: "metric-always-passes", values: { metric } });
      else if (!success && failure && !/is(NaN|Inf)\(/.test(failure)) out.push({ code: "metric-nan-passes", values: { metric } });
      else if (success) {
        const passes = passesWithoutData(success);
        if (passes === "no-data") out.push({ code: "metric-no-data-passes", values: { metric } });
        else if (passes === "nan") out.push({ code: "metric-nan-passes", values: { metric } });
      }
    }
    const limit = intOf(get(m, "failureLimit"));
    const count = intOf(get(m, "count"));
    const successLimit = intOf(get(m, "consecutiveSuccessLimit")) ?? 0;
    if (successLimit <= 0 && limit !== undefined && (limit < 0 || (count !== undefined && count > 0 && limit >= count))) {
      out.push({ code: "metric-cannot-fail", values: { metric, failureLimit: String(limit), count: count === undefined ? "" : String(count) } });
    }
  }
  return out;
}

/** Whether a canary step is a check: an analysis, an experiment (which may run analyses), or a pause a person ends. */
const isCheck = (step: Record<string, unknown>): boolean =>
  step.analysis !== undefined || step.experiment !== undefined || (step.pause !== undefined && get(step.pause, "duration") === undefined);

/** The checks of a Rollout's strategy (`spec`). */
export function rolloutFindings(spec: unknown): SafetyFinding[] {
  const ro = { spec } as unknown as KubeObject;
  const out: SafetyFinding[] = [];
  const strategy = strategyOf(ro);
  if (strategy === "blueGreen") {
    const bg = get(spec, "strategy", "blueGreen");
    const auto = get(bg, "autoPromotionEnabled") !== false;
    if (auto && get(bg, "prePromotionAnalysis") === undefined && get(bg, "postPromotionAnalysis") === undefined) {
      out.push({ code: "promoted-on-time", values: { strategy: "blueGreen" } });
    }
    return out;
  }
  if (strategy !== "canary") return out;
  const steps = canarySteps(ro);
  const background = get(spec, "strategy", "canary", "analysis") !== undefined;
  const shifts = steps.some((s) => num(s.setWeight) !== undefined);
  if (shifts && !background && !steps.some(isCheck)) out.push({ code: "promoted-on-time", values: { strategy: "canary" } });
  const max = num(get(spec, "strategy", "canary", "trafficRouting", "maxTrafficWeight")) ?? 100;
  const firstWeight = steps.map((s) => num(s.setWeight)).find((w) => w !== undefined);
  if (firstWeight !== undefined && firstWeight >= max) out.push({ code: "first-step-full", values: { weight: String(firstWeight) } });
  if (!background) {
    // Two traffic shifts with neither a check nor a timed pause between them: the second follows as soon as the canary's
    // pods are ready.
    let last: number | undefined;
    let between = false;
    for (const step of steps) {
      const weight = num(step.setWeight);
      if (weight !== undefined) {
        if (last !== undefined && !between && weight > last) {
          out.push({ code: "weights-without-check", values: { from: String(last), to: String(weight) } });
          break;
        }
        last = weight;
        between = false;
      } else if (isCheck(step) || step.pause !== undefined) between = true;
    }
  }
  const replicas = num(get(spec, "replicas")) ?? 1;
  const unavailable = get(spec, "strategy", "canary", "maxUnavailable");
  const all =
    (typeof unavailable === "string" && unavailable.trim() === "100%") ||
    (typeof unavailable === "number" && replicas > 1 && unavailable >= replicas);
  if (all) out.push({ code: "all-pods-unavailable", values: { maxUnavailable: String(unavailable) } });
  return out;
}

/** English text of a finding, for the agent tool (the problems' texts are the manifest's, translated there). */
export function safetyText(f: SafetyFinding): string {
  const v = f.values;
  switch (f.code) {
    case "metric-always-passes":
      return `Metric ${v.metric} has neither successCondition nor failureCondition: every measurement the provider answers counts as a success.`;
    case "metric-nan-passes":
      return `Metric ${v.metric} passes on NaN (for example 0/0 when there is no traffic): ${v.metric} has only a failureCondition, or its successCondition accepts isNaN/isInf.`;
    case "metric-no-data-passes":
      return `Metric ${v.metric} passes without data: its successCondition accepts an empty result or a default value.`;
    case "metric-cannot-fail":
      return `Metric ${v.metric} cannot fail: failureLimit ${v.failureLimit}${v.count ? ` with count ${v.count}` : ""} is never exceeded.`;
    case "metric-dry-run":
      return `Metric ${v.metric} runs dry: its failures are recorded but never fail the analysis.`;
    case "promoted-on-time":
      return v.strategy === "blueGreen"
        ? "Auto-promotion is on and no pre- or post-promotion analysis runs: the new version is promoted without a check."
        : "No analysis, experiment or manual pause guards the traffic steps: the canary is promoted on time alone.";
    case "weights-without-check":
      return `The canary goes from ${v.from}% to ${v.to}% with no pause or analysis between the two steps.`;
    case "first-step-full":
      return `The first traffic step sends ${v.weight}% to the canary: there is no gradual shift.`;
    case "all-pods-unavailable":
      return `maxUnavailable ${v.maxUnavailable} lets every pod be unavailable during an update.`;
  }
}
