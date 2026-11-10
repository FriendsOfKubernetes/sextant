// What the views read from VPA objects (autoscaling.k8s.io/v1), as the VPA components write and read them
// (kubernetes/autoscaler, vertical-pod-autoscaler: pkg/apis/autoscaling.k8s.io/v1/types.go for the API,
// pkg/utils/vpa/api.go for the defaults, pkg/recommender/model/vpa.go and pkg/recommender/input/cluster_feeder.go for
// the conditions) — the reading of Sextant's former built-in view (ADR-0111), ported unchanged. Pure functions, no
// DOM. Nothing here changes the cluster.
import type { KubeObject } from "@sextant/extension-sdk";

export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export interface KindOf {
  group: string;
  version: string;
  kind: string;
}

export const VPA_GROUP = "autoscaling.k8s.io";
export const VPA: KindOf = { group: VPA_GROUP, version: "v1", kind: "VerticalPodAutoscaler" };
export const VPA_CHECKPOINT: KindOf = { group: VPA_GROUP, version: "v1", kind: "VerticalPodAutoscalerCheckpoint" };
export const HPA: KindOf = { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" };
export const DEPLOYMENT: KindOf = { group: "apps", version: "v1", kind: "Deployment" };

const same = (a: Pick<KindOf, "group" | "kind">, b: Pick<KindOf, "group" | "kind">) => a.group === b.group && a.kind === b.kind;
export const isVpa = (kind: Pick<KindOf, "group" | "kind">): boolean => same(kind, VPA);

/** The workload kinds whose details list the VPAs that target them. */
export const TARGET_KINDS: readonly KindOf[] = [
  DEPLOYMENT,
  { group: "apps", version: "v1", kind: "StatefulSet" },
  { group: "apps", version: "v1", kind: "DaemonSet" },
  { group: "apps", version: "v1", kind: "ReplicaSet" },
  { group: "batch", version: "v1", kind: "Job" },
  { group: "batch", version: "v1", kind: "CronJob" },
];
export const isTargetKind = (kind: Pick<KindOf, "group" | "kind">): boolean => TARGET_KINDS.some((k) => same(k, kind));

/** An apiVersion's group and version (`v1` is the core group's). */
export function kindFromApiVersion(apiVersion: string, kind: string): KindOf {
  const slash = apiVersion.indexOf("/");
  return slash < 0 ? { group: "", version: apiVersion, kind } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1), kind };
}

// ---------- Target and update mode ----------

export interface TargetRef {
  apiVersion: string;
  kind: string;
  name: string;
  group: string;
}

/** `spec.targetRef` (a CrossVersionObjectReference); `undefined` when it is missing or incomplete. */
export function targetOf(vpa: KubeObject): TargetRef | undefined {
  const ref = get(vpa, "spec", "targetRef");
  const kind = str(get(ref, "kind"));
  const name = str(get(ref, "name"));
  if (!kind || !name) return undefined;
  const apiVersion = str(get(ref, "apiVersion")) ?? "";
  return { apiVersion, kind, name, group: kindFromApiVersion(apiVersion, kind).group };
}

/** Job and CronJob targets: their pods come and go by design, so "no pods" is their normal state between runs. */
export const isBatchTarget = (ref: Pick<TargetRef, "group" | "kind"> | undefined): boolean =>
  ref !== undefined && ref.group === "batch" && (ref.kind === "Job" || ref.kind === "CronJob");

/** How many pods a target object wants: a DaemonSet's scheduled count, else `spec.replicas` (1 when unset). */
export function replicasOfTarget(obj: KubeObject): number | undefined {
  if (obj.kind === "DaemonSet") return num(get(obj, "status", "desiredNumberScheduled"));
  const n = get(obj, "spec", "replicas");
  return typeof n === "number" ? n : 1;
}

/** Whether `ref` names the object `kind`/`name` (the group compared, never the version). */
export function targets(ref: { kind: string; name: string; group: string } | undefined, kind: Pick<KindOf, "group" | "kind">, name: string): boolean {
  return ref !== undefined && ref.kind === kind.kind && ref.name === name && ref.group === kind.group;
}

/** The update modes of `UpdateMode` (types.go). `Auto` is deprecated and works as `Recreate`. */
export const UPDATE_MODES = ["Off", "Initial", "Recreate", "Auto", "InPlaceOrRecreate", "InPlace"] as const;

/** Modes in which the updater changes running pods (by eviction, in place, or either). */
export const UPDATING_MODES: ReadonlySet<string> = new Set(["Recreate", "Auto", "InPlaceOrRecreate", "InPlace"]);

/** `spec.updatePolicy.updateMode`, `Recreate` when unset or empty (`GetUpdateMode` in pkg/utils/vpa/api.go). */
export function updateModeOf(vpa: KubeObject): string {
  return str(get(vpa, "spec", "updatePolicy", "updateMode")) || "Recreate";
}

/** The key of a mode's texts (`modeExplain.<key>`); an unknown mode is `unknown`. */
export function modeKey(mode: string): string {
  return (UPDATE_MODES as readonly string[]).includes(mode) ? mode : "unknown";
}

/** Whether the mode was left unset (the default `Recreate`). */
export const modeIsDefault = (vpa: KubeObject): boolean => !str(get(vpa, "spec", "updatePolicy", "updateMode"));

/** `spec.updatePolicy.minReplicas` (the updater's `--min-replicas`, 2 by default, when unset). */
export function minReplicasOf(vpa: KubeObject): number | undefined {
  return num(get(vpa, "spec", "updatePolicy", "minReplicas"));
}

/** `spec.recommenders[0].name`: a recommender other than the default one. */
export function recommenderOf(vpa: KubeObject): string | undefined {
  return str(get(arr(get(vpa, "spec", "recommenders"))[0], "name"));
}

// ---------- Conditions ----------

export interface VpaCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  since?: string;
}

export function conditionOf(vpa: KubeObject, type: string): VpaCondition | undefined {
  const c = arr(get(vpa, "status", "conditions")).find((x) => get(x, "type") === type);
  if (c === undefined) return undefined;
  return {
    type,
    status: str(get(c, "status")) ?? "Unknown",
    reason: str(get(c, "reason")) || undefined,
    message: str(get(c, "message")) || undefined,
    since: str(get(c, "lastTransitionTime")) || undefined,
  };
}

const isTrue = (vpa: KubeObject, type: string) => conditionOf(vpa, type)?.status === "True";

/**
 * Ready: the recommender provided a recommendation; progressing: none yet (no status, or still collecting); failed:
 * the recommender cannot use the VPA (`ConfigUnsupported`) or no pod matches it (`NoPodsMatched`).
 */
export type VpaState = "ready" | "progressing" | "failed";

/** What the status column says, under `reason.<key>`. */
export const VPA_REASONS = ["provided", "lowConfidence", "fetchingHistory", "configUnsupported", "noPodsMatched", "notProvided", "noStatus"] as const;
export type VpaReason = (typeof VPA_REASONS)[number];

export interface VpaStatus {
  state: VpaState;
  reason: VpaReason;
  /** The condition's message (the recommender's text). */
  message?: string;
  /** When the deciding condition last changed. */
  since?: string;
  /** `ConfigDeprecated` is True. */
  deprecated: boolean;
  /** A recommendation is there while `NoPodsMatched` is True: no pod right now (scaled to zero, between runs). */
  noPodsNow?: true;
}

/**
 * The VPA's state from its conditions, in the order the recommender decides them: a configuration it cannot use
 * (`ConfigUnsupported`), a recommendation (with low confidence or while history is still loaded), no matching pods,
 * or none yet. A recommendation outranks `NoPodsMatched`: the recommender keeps it while the target has no pods.
 */
export function statusOf(vpa: KubeObject): VpaStatus {
  const deprecated = isTrue(vpa, "ConfigDeprecated");
  const unsupported = conditionOf(vpa, "ConfigUnsupported");
  if (unsupported?.status === "True") return { state: "failed", reason: "configUnsupported", message: unsupported.message, since: unsupported.since, deprecated };
  const noPods = conditionOf(vpa, "NoPodsMatched");
  const noPodsNow = noPods?.status === "True" ? ({ noPodsNow: true } as const) : {};
  const provided = conditionOf(vpa, "RecommendationProvided");
  if (provided?.status === "True") {
    const reason: VpaReason = isTrue(vpa, "LowConfidence") ? "lowConfidence" : isTrue(vpa, "FetchingHistory") ? "fetchingHistory" : "provided";
    return { state: "ready", reason, since: provided.since, deprecated, ...noPodsNow };
  }
  // A recommendation without the condition (an older recommender) still counts.
  const recommended = !provided && recommendationsOf(vpa).length > 0;
  if (recommended) return { state: "ready", reason: "provided", deprecated, ...noPodsNow };
  if (noPods?.status === "True") return { state: "failed", reason: "noPodsMatched", message: noPods.message, since: noPods.since, deprecated };
  if (provided) return { state: "progressing", reason: "notProvided", message: provided.message, since: provided.since, deprecated };
  return { state: "progressing", reason: "noStatus", deprecated };
}

export const STATE_TONE: Record<VpaState, "success" | "warning" | "danger"> = { ready: "success", progressing: "warning", failed: "danger" };

/**
 * The "Only problems" filter, as the problems category judges it: a configuration the recommender cannot use, or no
 * pods matched without a recommendation — not in mode Off and not for a Job or CronJob (no pods between runs).
 */
export function isProblem(vpa: KubeObject): boolean {
  const s = statusOf(vpa);
  if (s.reason === "noPodsMatched") return updateModeOf(vpa) !== "Off" && !isBatchTarget(targetOf(vpa));
  return s.state === "failed";
}

// ---------- Container policies ----------

export const WILDCARD = "*";
export const DEFAULT_RESOURCES = ["cpu", "memory"] as const;

export interface ContainerPolicy {
  containerName: string;
  /** `Auto` (default) or `Off`. */
  mode: string;
  minAllowed: Record<string, string>;
  maxAllowed: Record<string, string>;
  /** `controlledResources`, `[cpu, memory]` when unset. */
  controlledResources: string[];
  /** `RequestsAndLimits` (default) or `RequestsOnly`. */
  controlledValues: string;
}

export const quantities = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(value))) if (typeof v === "string" || typeof v === "number") out[k] = String(v);
  return out;
};

export function containerPoliciesOf(vpa: KubeObject): ContainerPolicy[] {
  return arr(get(vpa, "spec", "resourcePolicy", "containerPolicies")).map((p) => {
    const controlled = get(p, "controlledResources");
    return {
      containerName: str(get(p, "containerName")) ?? "",
      mode: str(get(p, "mode")) || "Auto",
      minAllowed: quantities(get(p, "minAllowed")),
      maxAllowed: quantities(get(p, "maxAllowed")),
      controlledResources: Array.isArray(controlled) ? controlled.filter((r): r is string => typeof r === "string") : [...DEFAULT_RESOURCES],
      controlledValues: str(get(p, "controlledValues")) || "RequestsAndLimits",
    };
  });
}

/** The policy of a container: its own, else the wildcard one, else none (`GetContainerResourcePolicy`). */
export function policyFor(policies: readonly ContainerPolicy[], container: string): ContainerPolicy | undefined {
  return policies.find((p) => p.containerName === container) ?? policies.find((p) => p.containerName === WILDCARD);
}

/** Whether the VPA scales `resource` of `container`: its policy is not `Off` and controls the resource. */
export function controls(policies: readonly ContainerPolicy[], container: string, resource: string): boolean {
  const p = policyFor(policies, container);
  if (!p) return (DEFAULT_RESOURCES as readonly string[]).includes(resource);
  return p.mode !== "Off" && p.controlledResources.includes(resource);
}

/** `RequestsAndLimits` unless the container's policy says `RequestsOnly` (`GetContainerControlledValues`). */
export function controlledValuesFor(policies: readonly ContainerPolicy[], container: string): string {
  return policyFor(policies, container)?.controlledValues ?? "RequestsAndLimits";
}

// ---------- Recommendations ----------

export interface ContainerRecommendation {
  container: string;
  target: Record<string, string>;
  lowerBound: Record<string, string>;
  upperBound: Record<string, string>;
  uncappedTarget: Record<string, string>;
}

/** `status.recommendation.containerRecommendations`. */
export function recommendationsOf(vpa: KubeObject): ContainerRecommendation[] {
  return arr(get(vpa, "status", "recommendation", "containerRecommendations")).map((r) => ({
    container: str(get(r, "containerName")) ?? "",
    target: quantities(get(r, "target")),
    lowerBound: quantities(get(r, "lowerBound")),
    upperBound: quantities(get(r, "upperBound")),
    uncappedTarget: quantities(get(r, "uncappedTarget")),
  }));
}
