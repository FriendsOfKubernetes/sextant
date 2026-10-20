// The best-practice checks (#207): their ids, areas and severities, and the compact rows the checks read. A workload
// is reduced to `WorkloadInfo` once per object version (`workloadInfo`), and the objects around it — HPAs,
// PodDisruptionBudgets, LimitRanges, live pods — to rows of their own, so the page (namespaced watches) and the
// problems category (taps on the problems store's cluster-wide watches) run the same pure checks (checks.ts). Pure.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { parseQuantity } from "../metrics/format";
import { podSelectorOf, type Selector } from "../resource-map/selectors";
import { workloadOf } from "../rightsizing/group";

const { arr, get, num, record, str } = status;

export const AREAS = ["reliability", "efficiency"] as const;
export type Area = (typeof AREAS)[number];

export const RELIABILITY_CHECKS = [
  "readinessProbe",
  "livenessProbe",
  "mutableImage",
  "pullAlwaysDigest",
  "singleReplica",
  "noPdb",
  "pdbBlocksDisruption",
  "sameNode",
] as const;
export const EFFICIENCY_CHECKS = ["noRequests", "noMemoryLimit", "limitsAboveRecommendation", "hpaMinEqualsMax"] as const;
export const CHECKS = [...RELIABILITY_CHECKS, ...EFFICIENCY_CHECKS] as const;
export type CheckId = (typeof CHECKS)[number];

export function areaOf(check: CheckId): Area {
  return (RELIABILITY_CHECKS as readonly string[]).includes(check) ? "reliability" : "efficiency";
}

export type Severity = "high" | "medium" | "low";
export const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];

/** The kinds the checks judge (by their pod template). */
export const PRACTICE_KINDS = ["Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job"] as const;
export type PracticeKind = (typeof PRACTICE_KINDS)[number];

export interface PracticeFinding {
  check: CheckId;
  severity: Severity;
  /** The exact field from the root of the object that holds it (`on`, else the workload). */
  path: string;
  /** The value found, as text; absent when the field is missing. */
  value?: string;
  container?: string;
  /** Another object holds the field and takes the fix: an HPA or a PodDisruptionBudget. */
  on?: { kind: "HorizontalPodAutoscaler" | "PodDisruptionBudget"; name: string };
  /** `patch`: a strategic merge patch from the root of the object; `create`: a whole new object. */
  fixType: "patch" | "create";
  fix: Record<string, unknown>;
  /** Values of the explanation (`practices:checks.<check>.why`). */
  params?: Record<string, string | number>;
}

export interface ContainerInfo {
  list: "containers" | "initContainers";
  index: number;
  name: string;
  image?: string;
  pullPolicy?: string;
  /** An init container with `restartPolicy: Always`: runs as long as the pod. */
  sidecar: boolean;
  /** The first `containerPort`. */
  port?: number;
  readiness: boolean;
  liveness: boolean;
  /** Requests and limits as written (`"250m"`, `"1Gi"`). */
  requests: { cpu?: string; memory?: string };
  limits: { cpu?: string; memory?: string };
}

export interface WorkloadInfo {
  kind: PracticeKind;
  namespace: string;
  name: string;
  uid: string;
  /** `spec.replicas` of a Deployment or a StatefulSet. */
  replicas?: number;
  /** A Deployment with `strategy.type: Recreate` (one pod at a time, often on purpose: a ReadWriteOnce volume). */
  recreate: boolean;
  /** `spec.selector` as written. */
  selector?: Record<string, unknown>;
  templateLabels: Record<string, string>;
  /** Topology spread constraints or pod anti-affinity are set. */
  spread: boolean;
  /** What limits the nodes the pods may run on. */
  scheduling: TemplateScheduling;
  /** Path from the root of the object to the pod template (`["spec", "template"]`). */
  prefix: string[];
  containers: ContainerInfo[];
}

export interface Toleration {
  key: string;
  operator: string;
  value: string;
  effect: string;
}

/** The pod template's `nodeSelector`, required node affinity and tolerations. */
export interface TemplateScheduling {
  nodeSelector: Record<string, string>;
  /** `affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution` as written. */
  requiredAffinity: unknown;
  tolerations: Toleration[];
}

function schedulingOf(spec: Record<string, unknown>): TemplateScheduling {
  return {
    nodeSelector: Object.fromEntries(Object.entries(record(spec.nodeSelector)).map(([k, v]) => [k, String(v)])),
    requiredAffinity: get(spec, "affinity", "nodeAffinity", "requiredDuringSchedulingIgnoredDuringExecution"),
    tolerations: arr(spec.tolerations).map((t) => ({
      key: str(get(t, "key")) ?? "",
      operator: str(get(t, "operator")) ?? "Equal",
      value: str(get(t, "value")) ?? "",
      effect: str(get(t, "effect")) ?? "",
    })),
  };
}

const TEMPLATE: Record<PracticeKind, string[]> = {
  Deployment: ["spec", "template"],
  StatefulSet: ["spec", "template"],
  DaemonSet: ["spec", "template"],
  Job: ["spec", "template"],
  CronJob: ["spec", "jobTemplate", "spec", "template"],
};

export function isPracticeKind(kind: string): kind is PracticeKind {
  return (PRACTICE_KINDS as readonly string[]).includes(kind);
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

function containerInfo(list: ContainerInfo["list"], c: unknown, index: number): ContainerInfo {
  const port = num(get(arr(get(c, "ports"))[0], "containerPort"));
  const info: ContainerInfo = {
    list,
    index,
    name: str(get(c, "name")) ?? "",
    sidecar: list === "initContainers" && str(get(c, "restartPolicy")) === "Always",
    readiness: get(c, "readinessProbe") != null,
    liveness: get(c, "livenessProbe") != null,
    requests: { cpu: text(get(c, "resources", "requests", "cpu")), memory: text(get(c, "resources", "requests", "memory")) },
    limits: { cpu: text(get(c, "resources", "limits", "cpu")), memory: text(get(c, "resources", "limits", "memory")) },
  };
  const image = str(get(c, "image"));
  if (image) info.image = image;
  const pullPolicy = str(get(c, "imagePullPolicy"));
  if (pullPolicy) info.pullPolicy = pullPolicy;
  if (port !== undefined) info.port = port;
  return info;
}

const infoCache = new WeakMap<KubeObject, WorkloadInfo | null>();

/**
 * The row of a workload the checks read, once per object version; `null` for another kind, an object being deleted,
 * and a Job a CronJob runs (judged through the CronJob's template).
 */
export function workloadInfo(kind: string, obj: KubeObject): WorkloadInfo | null {
  const cached = infoCache.get(obj);
  if (cached !== undefined) return cached;
  const info = computeInfo(kind, obj);
  infoCache.set(obj, info);
  return info;
}

function computeInfo(kind: string, obj: KubeObject): WorkloadInfo | null {
  if (!isPracticeKind(kind) || obj.metadata?.deletionTimestamp) return null;
  if (kind === "Job" && status.controllerOf(obj)?.kind === "CronJob") return null;
  const prefix = TEMPLATE[kind];
  const template = get(obj, ...prefix);
  const spec = record(get(template, "spec"));
  const affinity = get(spec, "affinity", "podAntiAffinity");
  const info: WorkloadInfo = {
    kind,
    namespace: obj.metadata?.namespace ?? "",
    name: obj.metadata?.name ?? "",
    uid: obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${kind}/${obj.metadata?.name ?? ""}`,
    recreate: kind === "Deployment" && str(get(obj, "spec", "strategy", "type")) === "Recreate",
    templateLabels: Object.fromEntries(Object.entries(record(get(template, "metadata", "labels"))).map(([k, v]) => [k, String(v)])),
    spread: arr(spec.topologySpreadConstraints).length > 0 || (affinity != null && Object.keys(record(affinity)).length > 0),
    scheduling: schedulingOf(spec),
    prefix,
    containers: [
      ...arr(spec.containers).map((c, i) => containerInfo("containers", c, i)),
      ...arr(spec.initContainers).map((c, i) => containerInfo("initContainers", c, i)),
    ],
  };
  if (kind === "Deployment" || kind === "StatefulSet") {
    const replicas = num(get(obj, "spec", "replicas"));
    if (replicas !== undefined) info.replicas = replicas;
  }
  const selector = get(obj, "spec", "selector");
  if (selector && typeof selector === "object" && !Array.isArray(selector)) info.selector = selector as Record<string, unknown>;
  return info;
}

/** `namespace/kind/name`: how pods, HPAs and recommendations find their workload. */
export function workloadKey(namespace: string, kind: string, name: string): string {
  return `${namespace}/${kind}/${name}`;
}

// ---------- What surrounds a workload ----------

export interface HpaInfo {
  namespace: string;
  name: string;
  targetKind: string;
  targetName: string;
  /** `spec.minReplicas` (1 when unset). */
  min: number;
  max?: number;
}

export function hpaInfo(obj: KubeObject): HpaInfo {
  const info: HpaInfo = {
    namespace: obj.metadata?.namespace ?? "",
    name: obj.metadata?.name ?? "",
    targetKind: str(get(obj, "spec", "scaleTargetRef", "kind")) ?? "",
    targetName: str(get(obj, "spec", "scaleTargetRef", "name")) ?? "",
    min: num(get(obj, "spec", "minReplicas")) ?? 1,
  };
  const max = num(get(obj, "spec", "maxReplicas"));
  if (max !== undefined) info.max = max;
  return info;
}

export interface PdbInfo {
  namespace: string;
  name: string;
  selector: Selector;
  minAvailable?: number | string;
  maxUnavailable?: number | string;
  /** `status.expectedPods`: the pods it counts now. */
  expectedPods?: number;
}

const intOrString = (value: unknown): number | string | undefined =>
  typeof value === "number" || typeof value === "string" ? value : undefined;

export function pdbInfo(obj: KubeObject): PdbInfo {
  const version = (obj.apiVersion ?? "policy/v1").split("/")[1] ?? "v1";
  const info: PdbInfo = {
    namespace: obj.metadata?.namespace ?? "",
    name: obj.metadata?.name ?? "",
    selector: podSelectorOf({ group: "policy", kind: "PodDisruptionBudget", version }, obj) ?? { type: "nothing" },
  };
  const minAvailable = intOrString(get(obj, "spec", "minAvailable"));
  const maxUnavailable = intOrString(get(obj, "spec", "maxUnavailable"));
  const expected = num(get(obj, "status", "expectedPods"));
  if (minAvailable !== undefined) info.minAvailable = minAvailable;
  if (maxUnavailable !== undefined) info.maxUnavailable = maxUnavailable;
  if (expected !== undefined) info.expectedPods = expected;
  return info;
}

/** What the LimitRanges of a namespace give a container that sets nothing itself. */
export interface LimitDefaults {
  namespace: string;
  cpuRequest: boolean;
  memoryRequest: boolean;
  memoryLimit: boolean;
}

/** The container defaults of one LimitRange (a default limit is also the default request). */
export function limitDefaults(obj: KubeObject): LimitDefaults {
  const out: LimitDefaults = { namespace: obj.metadata?.namespace ?? "", cpuRequest: false, memoryRequest: false, memoryLimit: false };
  for (const limit of arr(get(obj, "spec", "limits"))) {
    if (str(get(limit, "type")) !== "Container") continue;
    const has = (field: string, resource: string) => get(limit, field, resource) !== undefined;
    out.cpuRequest ||= has("defaultRequest", "cpu") || has("default", "cpu");
    out.memoryRequest ||= has("defaultRequest", "memory") || has("default", "memory");
    out.memoryLimit ||= has("default", "memory");
  }
  return out;
}

/** A live pod's workload and node; `null` for a pod that is finished, being deleted or not scheduled. */
export interface Placement {
  workload: string;
  node: string;
}

export function placementOf(pod: KubeObject): Placement | null {
  const phase = str(get(pod, "status", "phase"));
  const node = str(get(pod, "spec", "nodeName"));
  if (!node || pod.metadata?.deletionTimestamp || phase === "Succeeded" || phase === "Failed") return null;
  const w = workloadOf(pod);
  return { workload: workloadKey(w.namespace, w.kind, w.name), node };
}

/** CPU in millicores, memory in bytes; `undefined` when it does not parse. */
export function cpuMillicores(value: string | undefined): number | undefined {
  const cores = parseQuantity(value);
  return cores === undefined ? undefined : Math.round(cores * 1e6) / 1e3;
}

export function memoryBytes(value: string | undefined): number | undefined {
  return parseQuantity(value);
}
