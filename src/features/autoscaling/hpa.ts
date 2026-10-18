// Why a HorizontalPodAutoscaler (autoscaling/v2) did or did not scale — pure, no React. It follows the controller's
// algorithm (k8s.io/kubernetes pkg/controller/podautoscaler) as far as the object shows it:
//
//   per metric   ratio = current / target   (Utilization: averageUtilization; AverageValue: averageValue; Value: value)
//                proposes ceil(currentReplicas × ratio), or currentReplicas while |ratio − 1| ≤ tolerance (10 %,
//                or behavior.scaleUp/scaleDown.tolerance where the cluster supports it)
//   overall      the largest proposal; when a metric has no value and the rest would scale down, nothing changes
//   clamped      to [minReplicas, maxReplicas]; the behavior's policies cap one step (stabilization needs the
//                controller's history, so it is explained from the conditions, not recomputed)
//
// The estimate uses the replica count where the controller uses ready pods for resource metrics, so it is marked as
// an estimate. Conditions (AbleToScale, ScalingActive, ScalingLimited) get plain reasons; FailedGet*Metric messages
// are read for the usual causes (no metrics API, a container without a request, pods without metrics).
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import { conditionsOf, formatAmount, phrase, quantity, type Condition, type EventRow, type Phrase } from "./model";

const { arr, get, num, record, str } = status;

/** The controller's default tolerance (`--horizontal-pod-autoscaler-tolerance`). */
export const DEFAULT_TOLERANCE = 0.1;
/** The controller's default scale-down stabilization (`--horizontal-pod-autoscaler-downscale-stabilization`). */
export const DEFAULT_DOWN_WINDOW_S = 300;

export type MetricSource = "Resource" | "ContainerResource" | "Pods" | "Object" | "External";
export type TargetType = "Utilization" | "AverageValue" | "Value";

export interface MetricRow {
  source: string;
  /** Resource or metric name. */
  name: string;
  container?: string;
  /** `Kind/name` of the described object (Object metrics). */
  object?: string;
  /** The metric's label selector, as text. */
  selector?: string;
  targetType?: string;
  /** Target and current as shown ("80%", "500m", "100"). */
  targetText?: string;
  currentText?: string;
  /** current / target; `undefined` without both. */
  ratio?: number;
  /** Replicas this metric alone asks for; `undefined` without a value. */
  proposes?: number;
  /** The ratio is inside the tolerance: this metric asks for no change. */
  withinTolerance?: boolean;
}

export interface PolicyRow {
  type: "Pods" | "Percent" | string;
  value: number;
  periodSeconds: number;
}

export interface DirectionBehavior {
  /** Seconds; `undefined` for the controller's default (0 up, 300 down). */
  windowSeconds: number;
  windowIsDefault: boolean;
  selectPolicy: string;
  policies: PolicyRow[];
  tolerance: number;
}

export interface ConditionRow extends Condition {
  explanation?: Phrase;
  tone: Tone;
}

export interface Estimate {
  /** The largest proposal of the metrics with a value (or the current count, see `heldByMissing`). */
  wanted: number;
  /** After minReplicas/maxReplicas and the behavior's step limit. */
  replicas: number;
  limitedBy?: "max" | "min" | "upPolicy" | "downPolicy";
  /** A metric has no value and the others would scale down: the controller keeps the count. */
  heldByMissing: boolean;
}

export interface HpaAnalysis {
  min: number;
  max: number;
  current: number;
  /** What the controller decided last (`status.desiredReplicas`). */
  desired?: number;
  lastScaleTime?: string;
  target?: { apiVersion: string; kind: string; name: string };
  metrics: MetricRow[];
  estimate?: Estimate;
  up: DirectionBehavior;
  down: DirectionBehavior;
  conditions: ConditionRow[];
  /** The one sentence on top: why it is where it is. */
  verdict: Phrase;
  /** Causes read from the conditions' messages (missing metrics API, a container without a request, …). */
  causes: Phrase[];
}

// ---------- Metrics ----------

function metricKey(m: unknown): string {
  const type = str(get(m, "type")) ?? "";
  const lower = type.charAt(0).toLowerCase() + type.slice(1);
  const body = get(m, lower);
  const name = str(get(body, "name")) ?? str(get(body, "metric", "name")) ?? "";
  const container = str(get(body, "container")) ?? "";
  const object = str(get(body, "describedObject", "name")) ?? "";
  return `${type}|${name}|${container}|${object}`;
}

function selectorText(selector: unknown): string | undefined {
  const labels = Object.entries(record(get(selector, "matchLabels"))).map(([k, v]) => `${k}=${String(v)}`);
  const exprs = arr(get(selector, "matchExpressions")).map(
    (e) => `${str(get(e, "key")) ?? ""} ${str(get(e, "operator")) ?? ""} ${arr(get(e, "values")).map(String).join(",")}`.trim(),
  );
  const all = [...labels, ...exprs];
  return all.length > 0 ? all.join(",") : undefined;
}

interface Values {
  target?: number;
  current?: number;
  targetText?: string;
  currentText?: string;
  targetType?: string;
}

function valuesOf(source: string, name: string, target: unknown, current: unknown): Values {
  const type = str(get(target, "type"));
  const out: Values = {};
  if (type) out.targetType = type;
  const resource = source === "Resource" || source === "ContainerResource" ? name : "";
  const amount = (v: unknown) => {
    const n = quantity(v);
    return n === undefined ? undefined : resource ? formatAmount(resource, n) : (str(v) ?? String(v));
  };
  if (type === "Utilization") {
    out.target = num(get(target, "averageUtilization"));
    out.current = num(get(current, "averageUtilization"));
    if (out.target !== undefined) out.targetText = `${out.target}%`;
    if (out.current !== undefined) out.currentText = `${out.current}%`;
    return out;
  }
  const field = type === "Value" ? "value" : "averageValue";
  out.target = quantity(get(target, field));
  out.current = quantity(get(current, field));
  if (out.target !== undefined) out.targetText = amount(get(target, field));
  if (out.current !== undefined) out.currentText = amount(get(current, field));
  // A Utilization status also carries the average value: show it when the utilization itself is missing.
  return out;
}

/** Replicas one metric asks for (the controller's rule), or `undefined` without a value. */
export function proposal(ratio: number | undefined, current: number, up: number, down: number): { replicas?: number; within?: boolean } {
  if (ratio === undefined || !Number.isFinite(ratio)) return {};
  if (current <= 0) return {};
  if (ratio >= 1 ? ratio - 1 <= up : 1 - ratio <= down) return { replicas: current, within: true };
  return { replicas: Math.ceil(ratio * current - 1e-9), within: false };
}

function metricRows(hpa: KubeObject, current: number, up: number, down: number): MetricRow[] {
  const specs = arr(get(hpa, "spec", "metrics"));
  const statuses = arr(get(hpa, "status", "currentMetrics"));
  const byKey = new Map(statuses.map((s) => [metricKey(s), s]));
  return specs.map((spec, i) => {
    const source = str(get(spec, "type")) ?? "";
    const lower = source.charAt(0).toLowerCase() + source.slice(1);
    const body = get(spec, lower);
    const name = str(get(body, "name")) ?? str(get(body, "metric", "name")) ?? "";
    const matched = byKey.get(metricKey(spec)) ?? (str(get(statuses[i], "type")) === source ? statuses[i] : undefined);
    const values = valuesOf(source, name, get(body, "target"), get(get(matched, lower), "current"));
    const row: MetricRow = { source, name };
    const container = str(get(body, "container"));
    if (container) row.container = container;
    const described = get(body, "describedObject");
    if (described) row.object = `${str(get(described, "kind")) ?? ""}/${str(get(described, "name")) ?? ""}`;
    const selector = selectorText(get(body, "metric", "selector"));
    if (selector) row.selector = selector;
    if (values.targetType) row.targetType = values.targetType;
    if (values.targetText) row.targetText = values.targetText;
    if (values.currentText) row.currentText = values.currentText;
    if (values.target !== undefined && values.current !== undefined && values.target > 0) {
      row.ratio = values.current / values.target;
      const p = proposal(row.ratio, current, up, down);
      if (p.replicas !== undefined) row.proposes = p.replicas;
      if (p.within !== undefined) row.withinTolerance = p.within;
    }
    return row;
  });
}

// ---------- Behavior ----------

function direction(hpa: KubeObject, which: "scaleUp" | "scaleDown"): DirectionBehavior {
  const rules = get(hpa, "spec", "behavior", which);
  const window = num(get(rules, "stabilizationWindowSeconds"));
  const policies = arr(get(rules, "policies")).map((p) => ({
    type: str(get(p, "type")) ?? "",
    value: num(get(p, "value")) ?? 0,
    periodSeconds: num(get(p, "periodSeconds")) ?? 15,
  }));
  const defaults: PolicyRow[] =
    which === "scaleUp"
      ? [
          { type: "Percent", value: 100, periodSeconds: 15 },
          { type: "Pods", value: 4, periodSeconds: 15 },
        ]
      : [{ type: "Percent", value: 100, periodSeconds: 15 }];
  const tolerance = quantity(get(rules, "tolerance"));
  return {
    windowSeconds: window ?? (which === "scaleUp" ? 0 : DEFAULT_DOWN_WINDOW_S),
    windowIsDefault: window === undefined,
    selectPolicy: str(get(rules, "selectPolicy")) ?? "Max",
    policies: policies.length > 0 ? policies : defaults,
    tolerance: tolerance ?? DEFAULT_TOLERANCE,
  };
}

/** The most (scale up) or the fewest (scale down) replicas one period of the policies allows from `current`. */
export function stepLimit(behavior: DirectionBehavior, current: number, up: boolean): number | undefined {
  if (behavior.selectPolicy === "Disabled") return current;
  if (behavior.policies.length === 0) return undefined;
  const limits = behavior.policies.map((p) => {
    if (p.type === "Pods") return up ? current + p.value : current - p.value;
    // As calculateScaleUpLimitWithScalingRules / calculateScaleDownLimitWithBehaviors (horizontal.go): up rounds up
    // (`int32(math.Ceil(start * (1 + value/100)))`), down truncates (`int32(start * (1 - value/100))`).
    if (p.type === "Percent") return up ? Math.ceil(current * (1 + p.value / 100)) : Math.trunc(current * (1 - p.value / 100));
    return undefined;
  });
  const known = limits.filter((l): l is number => l !== undefined);
  if (known.length === 0) return undefined;
  // Max picks the policy allowing the biggest change: the highest limit up, the lowest down.
  const biggest = behavior.selectPolicy !== "Min";
  return up === biggest ? Math.max(...known) : Math.min(...known);
}

// ---------- Conditions ----------

/** Plain reasons the views know; any other reason is shown as the cluster wrote it. */
const KNOWN_REASONS = new Set([
  "SucceededGetScale",
  "ReadyForNewScale",
  "SucceededRescale",
  "FailedGetScale",
  "FailedUpdateScale",
  "BackoffBoth",
  "BackoffDownscale",
  "BackoffUpscale",
  "ScaleDownStabilized",
  "ScaleUpStabilized",
  "ValidMetricFound",
  "FailedGetResourceMetric",
  "FailedGetContainerResourceMetric",
  "FailedGetPodsMetric",
  "FailedGetObjectMetric",
  "FailedGetExternalMetric",
  "InvalidSelector",
  "AmbiguousSelector",
  "InvalidMetricSourceType",
  "FailedComputeMetricsReplicas",
  "ScalingDisabled",
  "DesiredWithinRange",
  "TooManyReplicas",
  "TooFewReplicas",
  "ScaleUpLimit",
  "ScaleDownLimit",
]);

function toneOf(c: Condition): Tone {
  if (c.type === "ScalingLimited") return c.status === "True" ? "warning" : "success";
  if (c.reason === "ScaleDownStabilized" || c.reason === "ScaleUpStabilized" || c.reason?.startsWith("Backoff")) return "warning";
  return c.status === "True" ? "success" : c.status === "False" ? "danger" : "warning";
}

/** Causes a FailedGet*Metric (or a FailedComputeMetricsReplicas) message names, in plain words. */
export function metricCauses(message: string | undefined): Phrase[] {
  if (!message) return [];
  const out: Phrase[] = [];
  const missing = /missing request for (\S+?) in container (\S+?) of Pod (\S+?)(?:[,;:\s]|$)/.exec(message);
  if (missing) out.push(phrase("cause.missingRequest", { resource: missing[1]!, container: missing[2]!, pod: missing[3]! }, "danger"));
  const api = /\b(metrics\.k8s\.io|custom\.metrics\.k8s\.io|external\.metrics\.k8s\.io)\b/.exec(message)?.[1];
  const notThere =
    /could not find the requested resource|the server is currently unable to handle the request|ServiceUnavailable|no matches for kind|not found|is not available/i.test(
      message,
    );
  if (api && notThere) {
    const key = api === "metrics.k8s.io" ? "cause.noMetricsServer" : api === "custom.metrics.k8s.io" ? "cause.noCustomMetrics" : "cause.noExternalMetrics";
    out.push(phrase(key, undefined, "danger"));
  } else if (/unable to fetch metrics from resource metrics API/i.test(message) && !missing) {
    out.push(phrase("cause.noMetricsServer", undefined, "danger"));
  }
  if (/did not receive metrics for (targeted|any ready) pods|no metrics returned from resource metrics API/i.test(message)) {
    out.push(phrase("cause.noPodMetrics", undefined, "warning"));
  }
  if (/no matching metrics found|unable to fetch metrics from (custom|external) metrics API/i.test(message) && !(api && notThere)) {
    out.push(phrase("cause.metricNotFound", undefined, "danger"));
  }
  return out;
}

function conditionRows(hpa: KubeObject): ConditionRow[] {
  return conditionsOf(hpa).map((c) => {
    const row: ConditionRow = { ...c, tone: toneOf(c) };
    if (c.reason && KNOWN_REASONS.has(c.reason)) row.explanation = phrase(`hpaReason.${c.reason}`);
    return row;
  });
}

// ---------- The analysis ----------

function targetOf(hpa: KubeObject): HpaAnalysis["target"] {
  const ref = get(hpa, "spec", "scaleTargetRef");
  const kind = str(get(ref, "kind"));
  const name = str(get(ref, "name"));
  if (!kind || !name) return undefined;
  return { apiVersion: str(get(ref, "apiVersion")) ?? "apps/v1", kind, name };
}

function estimate(rows: MetricRow[], a: Pick<HpaAnalysis, "min" | "max" | "current" | "up" | "down">): Estimate | undefined {
  const proposals = rows.map((r) => r.proposes).filter((p): p is number => p !== undefined);
  if (proposals.length === 0 || a.current <= 0) return undefined;
  const missing = proposals.length < rows.length;
  let wanted = Math.max(...proposals);
  const heldByMissing = missing && wanted < a.current;
  if (heldByMissing) wanted = a.current;
  let replicas = wanted;
  let limitedBy: Estimate["limitedBy"];
  // As reconcileAutoscaler and convertDesiredReplicasWithBehaviorRate (horizontal.go): a count outside min/max goes
  // straight to the bound; otherwise the direction is decided on the unclamped recommendation, and the bound or the
  // policy step that is tighter limits it.
  if (a.current < a.min) {
    replicas = a.min;
    limitedBy = "min";
  } else if (a.current > a.max) {
    replicas = a.max;
    limitedBy = "max";
  } else if (wanted > a.current) {
    const cap = Math.max(a.current, stepLimit(a.up, a.current, true) ?? Number.POSITIVE_INFINITY);
    const allowed = Math.min(a.max, cap);
    if (wanted > allowed) {
      replicas = allowed;
      limitedBy = a.max > cap ? "upPolicy" : "max";
    }
  } else if (wanted < a.current) {
    const floor = Math.min(a.current, stepLimit(a.down, a.current, false) ?? Number.NEGATIVE_INFINITY);
    const allowed = Math.max(a.min, floor);
    if (wanted < allowed) {
      replicas = allowed;
      limitedBy = a.min < floor ? "downPolicy" : "min";
    }
  }
  const out: Estimate = { wanted, replicas, heldByMissing };
  if (limitedBy) out.limitedBy = limitedBy;
  return out;
}

function verdictOf(a: Omit<HpaAnalysis, "verdict">): Phrase {
  const cond = (type: string) => a.conditions.find((c) => c.type === type);
  const active = cond("ScalingActive");
  const able = cond("AbleToScale");
  const limited = cond("ScalingLimited");
  if (active?.reason === "ScalingDisabled") return phrase("verdict.disabled", undefined, "warning");
  if (active?.status === "False") return phrase("verdict.noMetrics", undefined, "danger");
  if (able?.status === "False") {
    if (able.reason?.startsWith("Backoff")) return phrase("verdict.backoff", { count: a.current }, "warning");
    return phrase("verdict.cannotScale", undefined, "danger");
  }
  if (able?.reason === "ScaleDownStabilized") return phrase("verdict.stabilizedDown", { count: a.current }, "warning");
  if (able?.reason === "ScaleUpStabilized") return phrase("verdict.stabilizedUp", { count: a.current }, "warning");
  const wanted = a.estimate?.wanted;
  if (limited?.status === "True") {
    if (limited.reason === "TooManyReplicas") return phrase("verdict.atMax", { count: a.max, wanted: wanted ?? a.max }, "warning");
    if (limited.reason === "TooFewReplicas") return phrase("verdict.atMin", { count: a.min, wanted: wanted ?? a.min }, "neutral");
    if (limited.reason === "ScaleUpLimit") return phrase("verdict.upLimit", { count: a.desired ?? a.current }, "warning");
    if (limited.reason === "ScaleDownLimit") return phrase("verdict.downLimit", { count: a.desired ?? a.current }, "neutral");
  }
  if (a.conditions.length === 0 && a.metrics.every((m) => m.currentText === undefined)) return phrase("verdict.noStatus", undefined, "muted");
  const desired = a.desired ?? a.current;
  if (desired !== a.current) return phrase("verdict.scaling", { count: desired, from: a.current }, "neutral");
  if (a.estimate?.heldByMissing) return phrase("verdict.heldByMissing", { count: a.current }, "warning");
  return phrase("verdict.steady", { count: a.current }, "success");
}

export function analyzeHpa(hpa: KubeObject): HpaAnalysis {
  const min = num(get(hpa, "spec", "minReplicas")) ?? 1;
  const max = num(get(hpa, "spec", "maxReplicas")) ?? min;
  const current = num(get(hpa, "status", "currentReplicas")) ?? 0;
  const up = direction(hpa, "scaleUp");
  const down = direction(hpa, "scaleDown");
  const metrics = metricRows(hpa, current, up.tolerance, down.tolerance);
  const conditions = conditionRows(hpa);
  const base: Omit<HpaAnalysis, "verdict"> = { min, max, current, metrics, up, down, conditions, causes: [] };
  const desired = num(get(hpa, "status", "desiredReplicas"));
  if (desired !== undefined) base.desired = desired;
  const last = str(get(hpa, "status", "lastScaleTime"));
  if (last) base.lastScaleTime = last;
  const target = targetOf(hpa);
  if (target) base.target = target;
  const est = estimate(metrics, base);
  if (est) base.estimate = est;
  const seen = new Set<string>();
  for (const c of conditions) {
    if (c.status === "True" && c.type !== "ScalingActive") continue;
    for (const cause of metricCauses(c.message)) {
      const key = JSON.stringify(cause);
      if (!seen.has(key)) {
        seen.add(key);
        base.causes.push(cause);
      }
    }
  }
  return { ...base, verdict: verdictOf(base) };
}

// ---------- The target's requests ----------

export interface RequestCheck {
  resource: string;
  /** Containers of the pod template without a request for `resource`. */
  without: string[];
  /** Checked a single container (ContainerResource): its name. */
  container?: string;
}

/**
 * The resources whose Utilization targets need requests, and the template containers without one. CPU or memory
 * percentages are of the pods' requests, so the controller cannot compute them for a pod with a container that has
 * none (ContainerResource: the named container). Sidecars injected at admission are not in the template: the
 * condition's message names them (`metricCauses`).
 */
export function requestChecks(hpa: KubeObject, template: unknown): RequestCheck[] {
  const containers = arr(get(template, "spec", "containers"));
  const requestOf = (c: unknown, resource: string) => get(c, "resources", "requests", resource) ?? get(c, "resources", "limits", resource);
  const out: RequestCheck[] = [];
  const seen = new Set<string>();
  for (const m of arr(get(hpa, "spec", "metrics"))) {
    const source = str(get(m, "type"));
    const body = source === "Resource" ? get(m, "resource") : source === "ContainerResource" ? get(m, "containerResource") : undefined;
    if (!body || str(get(body, "target", "type")) !== "Utilization") continue;
    const resource = str(get(body, "name")) ?? "";
    const container = source === "ContainerResource" ? str(get(body, "container")) : undefined;
    const key = `${resource}|${container ?? ""}`;
    if (!resource || seen.has(key)) continue;
    seen.add(key);
    const scope = container ? containers.filter((c) => str(get(c, "name")) === container) : containers;
    const check: RequestCheck = {
      resource,
      // A limit without a request defaults the request to the limit.
      without: scope.filter((c) => requestOf(c, resource) === undefined).map((c) => str(get(c, "name")) ?? ""),
    };
    if (container) check.container = container;
    out.push(check);
  }
  return out;
}

/** The pod template of a scale target (Deployment, StatefulSet, ReplicaSet, Argo Rollout, …), if it has one. */
export function templateOf(target: KubeObject | undefined): unknown {
  return target ? get(target, "spec", "template") : undefined;
}

// ---------- Events ----------

/** Reasons of the HPA controller's events worth listing. */
export const HPA_EVENT_REASONS = new Set([
  "SuccessfulRescale",
  "FailedRescale",
  "FailedGetScale",
  "FailedUpdateScale",
  "FailedGetResourceMetric",
  "FailedGetContainerResourceMetric",
  "FailedGetPodsMetric",
  "FailedGetObjectMetric",
  "FailedGetExternalMetric",
  "FailedComputeMetricsReplicas",
  "InvalidSelector",
  "AmbiguousSelector",
  "SelectorRequired",
  "InvalidMetricSourceType",
]);

export function isScalingEvent(e: EventRow): boolean {
  return HPA_EVENT_REASONS.has(e.reason);
}

/** "New size: 5; reason: cpu resource utilization (percentage of request) above target" → its parts. */
export function rescaleOf(message: string): { size: number; reason: string } | undefined {
  const m = /New size: (\d+); reason: (.*)$/.exec(message);
  return m ? { size: Number(m[1]), reason: m[2]!.trim() } : undefined;
}
