// `get_autoscaling_status`: per HorizontalPodAutoscaler of a namespace the analysis of its details (`analyzeHpa`,
// ADR-0080), KEDA ScaledObjects' state (`kedaState`) and the pending pods with the scheduler's own reasons
// (`parseSchedulerMessage`), from shared lists of that namespace — only kinds the agent may read there.
import type { KubeObject } from "../../api";
import { analyzeHpa, type HpaAnalysis, type MetricRow } from "../autoscaling/hpa";
import { useSharedList } from "../autoscaling/hooks";
import { kedaState } from "../autoscaling/keda";
import { HPA, POD, SCALED_OBJECT, type Phrase } from "../autoscaling/model";
import { isUnscheduled, parseSchedulerMessage, schedulingCondition } from "../autoscaling/scheduling";
import { en } from "./english";
import { canRead, objectName } from "./scope";
import { useAnswer, type WorkerProps } from "./worker";

interface Args {
  namespace: string;
  name: string | null;
}

const said = (p: Phrase) => en(`autoscaling:${p.key}`, p.params);

function metricName(m: MetricRow): string {
  const parts = [`${m.source} ${m.name}`.trim()];
  if (m.container) parts.push(`(${m.container})`);
  if (m.object) parts.push(`(${m.object})`);
  if (m.selector) parts.push(`{${m.selector}}`);
  return parts.join(" ");
}

const groupOf = (apiVersion: string) => (apiVersion.includes("/") ? apiVersion.split("/")[0]! : "");

export function hpaOut(hpa: KubeObject, a: HpaAnalysis) {
  const ns = hpa.metadata?.namespace ?? null;
  return {
    object: objectName(HPA, ns, hpa.metadata?.name ?? ""),
    target: a.target ? objectName({ group: groupOf(a.target.apiVersion), kind: a.target.kind }, ns, a.target.name) : undefined,
    min: a.min,
    max: a.max,
    current: a.current,
    desired: a.desired,
    verdict: said(a.verdict),
    causes: a.causes.map(said),
    metrics: a.metrics.map((m) => ({
      metric: metricName(m),
      current: m.currentText,
      target: m.targetType ? `${m.targetText ?? "?"} (${m.targetType})` : m.targetText,
      proposes: m.proposes,
      withinTolerance: m.withinTolerance === true,
    })),
    estimate: a.estimate
      ? {
          wanted: a.estimate.wanted,
          replicas: a.estimate.replicas,
          limitedBy: a.estimate.limitedBy,
          heldByMissingMetric: a.estimate.heldByMissing,
        }
      : undefined,
    conditions: a.conditions.map((c) => ({
      type: c.type,
      status: c.status,
      reason: c.reason,
      message: c.message,
      explanation: c.explanation ? said(c.explanation) : undefined,
    })),
  };
}

export function pendingOut(pod: KubeObject) {
  const condition = schedulingCondition(pod);
  const parsed = parseSchedulerMessage(condition.message);
  return {
    object: objectName(POD, pod.metadata?.namespace, pod.metadata?.name ?? ""),
    reason: condition.reason,
    message: condition.message,
    since: condition.since,
    reasons: (parsed?.reasons ?? []).map((r) => ({ nodes: r.count, code: r.code, text: r.text })),
    nodesTotal: parsed?.total,
  };
}

export function AutoscalingWorker(props: WorkerProps) {
  const { request } = props;
  const args = request.args as unknown as Args;
  const ns = args.namespace;
  const may = (kind: typeof HPA) => canRead(request.reads, kind, ns);
  const hpas = useSharedList(request.clusterId, HPA, ns, may(HPA));
  const pods = useSharedList(request.clusterId, POD, ns, may(POD));
  const scaled = useSharedList(request.clusterId, SCALED_OBJECT, ns, may(SCALED_OBJECT));
  const listed = (l: typeof hpas, on: boolean) => !on || l.served === false || (l.served === true && l.state?.status !== "loading" && l.state !== undefined);
  const ready = listed(hpas, may(HPA)) && listed(pods, may(POD)) && listed(scaled, may(SCALED_OBJECT));

  useAnswer(props, ready, () => {
    const named = (o: KubeObject) => !args.name || o.metadata?.name === args.name;
    return {
      hpas: hpas.items.filter(named).map((h) => hpaOut(h, analyzeHpa(h))),
      scaledObjects: scaled.items.filter(named).map((s) => {
        const state = kedaState(s);
        return {
          object: objectName(SCALED_OBJECT, s.metadata?.namespace, s.metadata?.name ?? ""),
          ready: state.ready,
          active: state.active,
          paused: state.paused,
          fallback: state.fallback,
          state: state.phrases.map(said),
        };
      }),
      pendingPods: pods.items.filter(isUnscheduled).map(pendingOut),
    };
  });
  return null;
}
