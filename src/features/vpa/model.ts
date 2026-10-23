// What the Vertical Pod Autoscaler views read from VPA objects (autoscaling.k8s.io/v1), as the VPA components write
// and read them (kubernetes/autoscaler, vertical-pod-autoscaler: pkg/apis/autoscaling.k8s.io/v1/types.go for the API,
// pkg/utils/vpa/api.go for the defaults, pkg/recommender/model/vpa.go and pkg/recommender/input/cluster_feeder.go for
// the conditions). Pure functions, no React. Nothing here changes the cluster.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import { kindFromApiVersion } from "../../resources/refs";
import type { Tone } from "../../resources/status";

const { arr, get, record, str } = status;

export const VPA_GROUP = "autoscaling.k8s.io";
export const VPA: KindRef = { group: VPA_GROUP, version: "v1", kind: "VerticalPodAutoscaler" };
export const VPA_CHECKPOINT: KindRef = { group: VPA_GROUP, version: "v1", kind: "VerticalPodAutoscalerCheckpoint" };
export const HPA: KindRef = { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" };
export const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };

const same = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) => a.group === b.group && a.kind === b.kind;
export const isVpa = (kind: Pick<KindRef, "group" | "kind">): boolean => same(kind, VPA);
export const isCheckpoint = (kind: Pick<KindRef, "group" | "kind">): boolean => same(kind, VPA_CHECKPOINT);

/** The workload kinds whose details list the VPAs that target them. */
export const TARGET_KINDS: readonly KindRef[] = [
  DEPLOYMENT,
  { group: "apps", version: "v1", kind: "StatefulSet" },
  { group: "apps", version: "v1", kind: "DaemonSet" },
  { group: "apps", version: "v1", kind: "ReplicaSet" },
  { group: "batch", version: "v1", kind: "Job" },
  { group: "batch", version: "v1", kind: "CronJob" },
];
export const isTargetKind = (kind: Pick<KindRef, "group" | "kind">): boolean => TARGET_KINDS.some((k) => same(k, kind));

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

/** Whether `ref` names the object `kind`/`name` (the group compared, never the version). */
export function targets(ref: { kind: string; name: string; group: string } | undefined, kind: Pick<KindRef, "group" | "kind">, name: string): boolean {
  return ref !== undefined && ref.kind === kind.kind && ref.name === name && ref.group === kind.group;
}

/** The update modes of `UpdateMode` (types.go). `Auto` is deprecated and works as `Recreate`. */
export const UPDATE_MODES = ["Off", "Initial", "Recreate", "Auto", "InPlaceOrRecreate", "InPlace"] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

/** Modes in which the updater changes running pods (by eviction, in place, or either). */
export const UPDATING_MODES: ReadonlySet<string> = new Set(["Recreate", "Auto", "InPlaceOrRecreate", "InPlace"]);

/** `spec.updatePolicy.updateMode`, `Recreate` when unset or empty (`GetUpdateMode` in pkg/utils/vpa/api.go). */
export function updateModeOf(vpa: KubeObject): string {
  return str(get(vpa, "spec", "updatePolicy", "updateMode")) || "Recreate";
}

/** The key of a mode's texts (`vpa:mode.<key>`); an unknown mode is `unknown`. */
export function modeKey(mode: string): string {
  return (UPDATE_MODES as readonly string[]).includes(mode) ? mode : "unknown";
}

/** Whether the mode was set explicitly (an unset one is the default `Recreate`). */
export const modeIsDefault = (vpa: KubeObject): boolean => !str(get(vpa, "spec", "updatePolicy", "updateMode"));

/** `spec.updatePolicy.minReplicas` (the updater's `--min-replicas`, 2 by default, when unset). */
export function minReplicasOf(vpa: KubeObject): number | undefined {
  const v = get(vpa, "spec", "updatePolicy", "minReplicas");
  return typeof v === "number" ? v : undefined;
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
 * the recommender cannot use the VPA (`ConfigUnsupported`: the target cannot be read or is not the topmost controller)
 * or no pod matches it (`NoPodsMatched`).
 */
export type VpaState = "ready" | "progressing" | "failed";

/** What the status column says, under `vpa:reason`. */
export type VpaReason =
  | "provided"
  | "lowConfidence"
  | "fetchingHistory"
  | "configUnsupported"
  | "noPodsMatched"
  | "notProvided"
  | "noStatus";

export interface VpaStatus {
  state: VpaState;
  reason: VpaReason;
  /** The condition's message (the recommender's text). */
  message?: string;
  /** When the deciding condition last changed. */
  since?: string;
  /** `ConfigDeprecated` is True. */
  deprecated: boolean;
}

/**
 * The VPA's state from its conditions, in the order the recommender decides them: a configuration it cannot use
 * (`ConfigUnsupported`; it then also says `NoPodsMatched`, since it selects nothing), no matching pods, a
 * recommendation (with low confidence or while history is still loaded), or none yet.
 */
export function statusOf(vpa: KubeObject): VpaStatus {
  const deprecated = isTrue(vpa, "ConfigDeprecated");
  const unsupported = conditionOf(vpa, "ConfigUnsupported");
  if (unsupported?.status === "True") return { state: "failed", reason: "configUnsupported", message: unsupported.message, since: unsupported.since, deprecated };
  const noPods = conditionOf(vpa, "NoPodsMatched");
  if (noPods?.status === "True") return { state: "failed", reason: "noPodsMatched", message: noPods.message, since: noPods.since, deprecated };
  const provided = conditionOf(vpa, "RecommendationProvided");
  if (provided?.status === "True") {
    const reason: VpaReason = isTrue(vpa, "LowConfidence") ? "lowConfidence" : isTrue(vpa, "FetchingHistory") ? "fetchingHistory" : "provided";
    return { state: "ready", reason, since: provided.since, deprecated };
  }
  if (provided) return { state: "progressing", reason: "notProvided", message: provided.message, since: provided.since, deprecated };
  // A recommendation without conditions (an older recommender) still counts.
  if (recommendationsOf(vpa).length > 0) return { state: "ready", reason: "provided", deprecated };
  return { state: "progressing", reason: "noStatus", deprecated };
}

export const STATE_TONE: Record<VpaState, Tone> = { ready: "success", progressing: "warning", failed: "danger" };

/** The "Only problems" filter: a configuration the recommender cannot use, or no pods matched. */
export const isProblem = (vpa: KubeObject): boolean => statusOf(vpa).state === "failed";

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

const quantities = (value: unknown): Record<string, string> => {
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
