// The agent tool `diagnose-rollout` (#341, ADR-0171): one Rollout read whole — the Deployment its template comes from
// (`workloadRef`), its ReplicaSets, where its traffic goes (Istio, the canary and stable Services), its analysis runs and
// templates, and its events — and told as findings that know the context: "replicas 0" of a Deployment the Rollout
// scales down is normal, two subsets on one template hash are a problem only while a canary has weight. Every read goes
// through `Reader`, which the backend backs with `host` (Sextant decides each read for the extension and the agent both);
// a read refused or failed is named in `notChecked`, never taken for "not there". Pure apart from the reader.
import type { KubeObject } from "@sextant/extension-sdk";
import {
  ANALYSIS_RUN,
  ANALYSIS_TEMPLATE,
  CLUSTER_ANALYSIS_TEMPLATE,
  POD_TEMPLATE_HASH_LABEL,
  REPLICA_SET,
  ROLLOUT,
  SERVICE,
  analysisFailure,
  analysisPhase,
  analysisRunsOf,
  arr,
  canarySteps,
  currentHash,
  currentStepIndex,
  fullyPromoted,
  get,
  isAborted,
  metricResults,
  num,
  pauseConditions,
  record,
  replicaSetsOf,
  revisionOf,
  rolloutPhase,
  setWeight,
  stableHash,
  stepProgress,
  stepText,
  str,
  strategyOf,
  updating,
} from "./model";
import { rolloutFindings, safetyText, templateFindings } from "./safety";
import { canaryWeight, destinationRuleRef, trafficFindings, trafficText, virtualServiceRefs, type Found } from "./traffic";

export const DEPLOYMENT = { group: "apps", kind: "Deployment" } as const;
export const EVENT = { group: "", kind: "Event" } as const;
export const VIRTUAL_SERVICE = { group: "networking.istio.io", kind: "VirtualService" } as const;
export const DESTINATION_RULE = { group: "networking.istio.io", kind: "DestinationRule" } as const;

type Kind = { group: string; kind: string };

/** How the tool reads; each call may throw (`SextantError`). `get` answers `null` for an object that is not there. */
export interface Reader {
  get(kind: Kind, namespace: string | undefined, name: string): KubeObject | null;
  list(kind: Kind, namespace: string, options?: { fieldSelector?: string; limit?: number }): { items: KubeObject[]; truncated: boolean };
}

export type Level = "problem" | "warning" | "normal" | "info";

export interface Finding {
  level: Level;
  code: string;
  text: string;
}

/** Most analysis runs and events told; the newest. */
export const MAX_RUNS = 5;
export const MAX_EVENTS = 30;
export const MAX_TEMPLATES = 10;
const MAX_TEXT = 300;

const clip = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;

const ORDER: Record<Level, number> = { problem: 0, warning: 1, info: 2, normal: 3 };

/** Why a read failed, in a few words (never the object). */
function why(err: unknown): string {
  const code = (err as { code?: string }).code;
  if (code === "forbidden") return "the cluster refused it (forbidden)";
  if (code === "denied") return "not allowed for this agent or extension in Sextant";
  if (code === "notFound") return "not served by the cluster";
  return code ? `the read failed (${code})` : "the read failed";
}

/** The routers Argo Rollouts knows, by their `trafficRouting` field. */
const ROUTERS = ["istio", "nginx", "alb", "smi", "ambassador", "appMesh", "traefik", "apisix", "plugins"] as const;

export interface DiagnoseArgs {
  cluster: string;
  namespace: string;
  /** The Rollout; or `deployment`: the Deployment a Rollout takes its template from. */
  name?: string;
  deployment?: string;
}

/** Everything the tool says of one Rollout. */
export function diagnose(read: Reader, args: DiagnoseArgs): Record<string, unknown> {
  const notChecked: { what: string; why: string }[] = [];
  const attempt = <T>(what: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      notChecked.push({ what, why: why(err) });
      return undefined;
    }
  };
  const ns = args.namespace;
  const findings: Finding[] = [];

  // The Rollout: by name, or the one whose workloadRef names the Deployment.
  let ro: KubeObject | null | undefined;
  let others: string[] = [];
  if (args.name) {
    ro = attempt(`Rollout ${ns}/${args.name}`, () => read.get(ROLLOUT, ns, args.name!));
    if (ro === undefined) throw new Error(`cannot read Rollout ${ns}/${args.name}: ${notChecked[0]?.why ?? "failed"}`);
    if (ro === null) throw new Error(`Rollout ${ns}/${args.name} is not there`);
  } else {
    const list = attempt(`Rollouts in ${ns}`, () => read.list(ROLLOUT, ns, { limit: 500 }));
    if (!list) throw new Error(`cannot list Rollouts in ${ns}: ${notChecked[0]?.why ?? "failed"}`);
    const refs = list.items.filter(
      (r) => str(get(r, "spec", "workloadRef", "kind")) === "Deployment" && str(get(r, "spec", "workloadRef", "name")) === args.deployment,
    );
    if (refs.length === 0) {
      return {
        deployment: `${ns}/${args.deployment}`,
        managedBy: null,
        note: `No Rollout in ${ns} takes its template from Deployment ${args.deployment} (spec.workloadRef)${list.truncated ? "; the list of Rollouts was cut short, so one may exist" : ""}. Its replicas are its own.`,
        notChecked,
      };
    }
    ro = refs[0]!;
    others = refs.slice(1).map((r) => r.metadata?.name ?? "");
  }
  const name = ro.metadata?.name ?? "";
  const uid = ro.metadata?.uid;
  const strategy = strategyOf(ro);
  const phase = rolloutPhase(ro);
  if (others.length > 0) {
    findings.push({ level: "warning", code: "several-rollouts", text: `Rollouts ${others.join(", ")} also take their template from this Deployment.` });
  }

  // ReplicaSets.
  const rsList = attempt(`ReplicaSets in ${ns}`, () => read.list(REPLICA_SET, ns, { limit: 2000 }));
  const sets = rsList ? replicaSetsOf(ro, rsList.items) : undefined;
  const availableOf = (hash: string): number | undefined => {
    if (!sets) return undefined;
    const set = sets.find((s) => s.hash === hash);
    return set ? set.available : rsList?.truncated ? undefined : 0;
  };

  // The workload the template comes from.
  let workload: Record<string, unknown> | null = null;
  const ref = record(get(ro, "spec", "workloadRef"));
  const refName = str(ref.name);
  if (refName) {
    const scaleDown = str(ref.scaleDown) ?? "never";
    const kind = str(ref.kind) ?? "";
    const dep = kind === "Deployment" ? attempt(`Deployment ${ns}/${refName}`, () => read.get(DEPLOYMENT, ns, refName)) : undefined;
    const desired = dep ? num(get(dep, "spec", "replicas")) : undefined;
    const running = dep ? (num(get(dep, "status", "replicas")) ?? 0) : undefined;
    workload = { kind, name: refName, scaleDown, replicas: desired, runningPods: running };
    if (dep === null) {
      findings.push({ level: "problem", code: "workload-missing", text: `The template comes from ${kind} ${refName} (spec.workloadRef), which is not there: the controller cannot resolve it.` });
    } else if (dep) {
      if (desired === 0 && running === 0) {
        findings.push({
          level: "normal",
          code: "workload-scaled-down",
          text:
            scaleDown === "never"
              ? `Deployment ${refName} has 0 replicas: normal, the Rollout only takes its pod template from it (scaleDown never: scaled to 0 by hand). Its pods run in the Rollout's ReplicaSets.`
              : `Deployment ${refName} has 0 replicas: normal, the controller scales it down (scaleDown ${scaleDown}). Its pods run in the Rollout's ReplicaSets.`,
        });
      } else if ((running ?? 0) > 0) {
        // The controller scales the Deployment down only while the Rollout's first revision rolls out (revision == 1).
        const later = (revisionOf(ro) ?? 1) > 1;
        findings.push({
          level: scaleDown === "never" || later ? "warning" : "info",
          code: "workload-pods-running",
          text:
            scaleDown === "never"
              ? `Deployment ${refName} still runs ${running} pods of its own beside the Rollout's (scaleDown never): both get the Service's traffic unless their selectors differ.`
              : later
                ? `Deployment ${refName} runs ${running} pods of its own beside the Rollout's: with scaleDown ${scaleDown} the controller scales it down only while the Rollout's first revision rolls out (now revision ${revisionOf(ro)}), so they stay until it is scaled down by hand; both get the Service's traffic unless their selectors differ.`
                : `Deployment ${refName} still runs ${running} pods; the controller scales it down once the Rollout's first revision is healthy (scaleDown ${scaleDown}).`,
        });
      }
      const wanted = str(record(ro.metadata?.annotations)["rollout.argoproj.io/workload-generation"]);
      const seen = num(get(ro, "status", "workloadObservedGeneration"));
      if (wanted && seen !== undefined && String(seen) !== wanted) {
        findings.push({ level: "info", code: "workload-change-pending", text: `The controller has not yet rolled out the Deployment's latest template (generation ${wanted}, rolled out ${seen}).` });
      }
    }
  }

  // Traffic.
  const routing = record(get(ro, "spec", "strategy", "canary", "trafficRouting"));
  const routers = ROUTERS.filter((r) => routing[r] !== undefined);
  const lookups = {
    virtualService: (namespace: string, n: string): Found => attempt(`VirtualService ${namespace}/${n}`, () => read.get(VIRTUAL_SERVICE, namespace, n)),
    destinationRule: (namespace: string, n: string): Found => attempt(`DestinationRule ${namespace}/${n}`, () => read.get(DESTINATION_RULE, namespace, n)),
    service: (namespace: string, n: string): Found => attempt(`Service ${namespace}/${n}`, () => read.get(SERVICE, namespace, n)),
    available: availableOf,
  };
  const traffic = strategy === "canary" ? trafficFindings(ro, lookups) : [];
  for (const f of traffic) findings.push({ level: f.level, code: f.code, text: trafficText(f) });
  const unread = routers.filter((r) => r !== "istio");
  if (unread.length > 0) notChecked.push({ what: `traffic through ${unread.join(", ")}`, why: "only Istio and the canary/stable Services are checked" });

  // Analysis: runs and the templates the strategy names.
  const runs = attempt(`AnalysisRuns in ${ns}`, () => read.list(ANALYSIS_RUN, ns, { limit: 1000 }));
  const own = runs ? analysisRunsOf(ro, runs.items).slice(0, MAX_RUNS) : [];
  const templates = templateRefs(ro).slice(0, MAX_TEMPLATES);
  const templateOut: Record<string, unknown>[] = [];
  for (const t of templates) {
    const obj = attempt(`${t.cluster ? "ClusterAnalysisTemplate" : "AnalysisTemplate"} ${t.name}`, () =>
      read.get(t.cluster ? CLUSTER_ANALYSIS_TEMPLATE : ANALYSIS_TEMPLATE, t.cluster ? undefined : ns, t.name),
    );
    if (obj === null) {
      findings.push({ level: "problem", code: "template-missing", text: `${t.cluster ? "ClusterAnalysisTemplate" : "AnalysisTemplate"} ${t.name}, which the strategy names, is not there.` });
      continue;
    }
    if (!obj) continue;
    const found = templateFindings(get(obj, "spec"));
    for (const f of found) findings.push({ level: "warning", code: f.code, text: `${t.cluster ? "ClusterAnalysisTemplate" : "AnalysisTemplate"} ${t.name}: ${safetyText(f)}` });
    templateOut.push({
      kind: t.cluster ? "ClusterAnalysisTemplate" : "AnalysisTemplate",
      name: t.name,
      metrics: arr(get(obj, "spec", "metrics")).map((m) => ({
        name: str(get(m, "name")),
        provider: Object.keys(record(get(m, "provider")))[0],
        successCondition: clip(str(get(m, "successCondition"))),
        failureCondition: clip(str(get(m, "failureCondition"))),
        failureLimit: get(m, "failureLimit"),
        count: get(m, "count"),
        interval: str(get(m, "interval")),
      })),
    });
  }
  for (const f of rolloutFindings(get(ro, "spec"))) findings.push({ level: "warning", code: f.code, text: safetyText(f) });
  const runOut = own.map((run) => ({
    name: run.metadata?.name,
    phase: analysisPhase(run),
    started: str(get(run, "status", "startedAt")) ?? run.metadata?.creationTimestamp,
    hash: str(record(run.metadata?.labels)[POD_TEMPLATE_HASH_LABEL]),
    message: clip(analysisFailure(run)),
    dryRun: get(run, "status", "dryRunSummary") ?? undefined,
    metrics: metricResults(run).map((m) => ({
      name: m.name,
      phase: m.phase,
      successful: m.successful,
      failed: m.failed,
      inconclusive: m.inconclusive,
      error: m.error,
      lastValues: m.measurements.slice(0, 3).map((x) => clip(x.value)),
      failing: m.failing ? { value: clip(m.failing.value), message: clip(m.failing.message), at: m.failing.finishedAt ?? m.failing.startedAt } : undefined,
    })),
  }));

  // State findings that need the context.
  const pauses = pauseConditions(ro).map((p) => ({ reason: str(get(p, "reason")), since: str(get(p, "startTime")) }));
  for (const p of pauses) {
    if (p.reason === "InconclusiveAnalysisRun" || p.reason === "InconclusiveExperiment") {
      findings.push({ level: "problem", code: "inconclusive", text: `Paused because an ${p.reason === "InconclusiveAnalysisRun" ? "analysis" : "experiment"} was inconclusive (since ${p.since}): it waits for a person to promote or abort.` });
    }
  }
  if (isAborted(ro)) findings.push({ level: "problem", code: "aborted", text: `The update was aborted: ${clip(str(get(ro, "status", "message"))) ?? "no message"}.` });
  else if (phase.phase === "Degraded") findings.push({ level: "problem", code: "degraded", text: `Degraded: ${clip(phase.message) ?? "no message"}.` });
  if (fullyPromoted(ro) && phase.phase === "Healthy") findings.push({ level: "normal", code: "healthy", text: "Fully promoted and healthy: no update is running." });

  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level]);

  // What happened, oldest first: conditions, pauses, analysis runs and the Rollout's events.
  const timeline: { at: string; what: string }[] = [];
  for (const c of arr(get(ro, "status", "conditions"))) {
    const at = str(get(c, "lastTransitionTime"));
    if (at) timeline.push({ at, what: `condition ${str(get(c, "type"))}=${str(get(c, "status"))} (${str(get(c, "reason")) ?? ""})` });
  }
  for (const p of pauses) if (p.since) timeline.push({ at: p.since, what: `paused: ${p.reason}` });
  for (const r of runOut) {
    if (r.started) timeline.push({ at: r.started, what: `AnalysisRun ${r.name} started (${r.phase ?? "?"})` });
    for (const m of r.metrics) if (m.failing?.at) timeline.push({ at: m.failing.at, what: `metric ${m.name} of ${r.name}: ${m.failing.value ?? ""} ${m.failing.message ?? ""}`.trim() });
  }
  if (uid) {
    const events = attempt(`events of Rollout ${ns}/${name}`, () => read.list(EVENT, ns, { fieldSelector: `involvedObject.uid=${uid}`, limit: 200 }));
    for (const e of events?.items ?? []) {
      const at = str(get(e, "lastTimestamp")) ?? str(get(e, "eventTime")) ?? e.metadata?.creationTimestamp;
      if (at) timeline.push({ at, what: `event ${str(get(e, "type")) ?? ""} ${str(get(e, "reason")) ?? ""}: ${clip(str(get(e, "message"))) ?? ""}`.trim() });
    }
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  const index = currentStepIndex(ro);
  const steps = canarySteps(ro);
  return {
    rollout: {
      namespace: ns,
      name,
      strategy,
      phase: phase.phase,
      message: clip(phase.message),
      step: stepProgress(ro),
      currentStep: index !== undefined && index < steps.length ? stepText(steps[index]!) : undefined,
      setWeight: strategy === "canary" ? setWeight(ro) : undefined,
      canaryWeight: strategy === "canary" ? canaryWeight(ro) : undefined,
      stableHash: stableHash(ro),
      newHash: currentHash(ro),
      updating: updating(ro),
      aborted: isAborted(ro),
      paused: pauses,
      replicas: {
        desired: num(get(ro, "spec", "replicas")),
        ready: num(get(ro, "status", "readyReplicas")),
        available: num(get(ro, "status", "availableReplicas")),
        updated: num(get(ro, "status", "updatedReplicas")),
      },
    },
    workload,
    replicaSets: sets?.map((s) => ({ name: s.name, hash: s.hash, role: s.role, revision: s.revision, desired: s.desired, available: s.available })),
    traffic: {
      routers,
      virtualServices: virtualServiceRefs(ro).map((v) => `${v.namespace}/${v.name}`),
      destinationRule: destinationRuleRef(ro),
      canaryService: str(get(ro, "spec", "strategy", "canary", "canaryService")),
      stableService: str(get(ro, "spec", "strategy", "canary", "stableService")),
      reportedWeights: get(ro, "status", "canary", "weights"),
    },
    analysis: { templates: templateOut, runs: runOut },
    findings,
    timeline: timeline.slice(-MAX_EVENTS * 2),
    notChecked,
  };
}

/** The analysis templates a strategy names: its steps', background analysis' and blue-green analyses'. */
export function templateRefs(ro: KubeObject): { name: string; cluster: boolean }[] {
  const lists = [
    ...canarySteps(ro).map((s) => get(s, "analysis", "templates")),
    get(ro, "spec", "strategy", "canary", "analysis", "templates"),
    get(ro, "spec", "strategy", "blueGreen", "prePromotionAnalysis", "templates"),
    get(ro, "spec", "strategy", "blueGreen", "postPromotionAnalysis", "templates"),
  ];
  const out = new Map<string, { name: string; cluster: boolean }>();
  for (const list of lists) {
    for (const t of arr(list)) {
      const name = str(get(t, "templateName"));
      if (!name) continue;
      const cluster = get(t, "clusterScope") === true;
      out.set(`${cluster}:${name}`, { name, cluster });
    }
  }
  return [...out.values()];
}
