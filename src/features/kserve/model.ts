// What the KServe section reads from serving.kserve.io objects, as KServe writes them (pkg/apis/serving/v1beta1 and
// v1alpha1 in github.com/kserve/kserve): an InferenceService's components (predictor, transformer, explainer) with
// their model format, runtime and storage URI, its conditions (Ready, PredictorReady, IngressReady,
// LatestDeploymentReady, …), URL, address, each component's revisions and traffic, the model status
// (`transitionStatus`, `states`, `lastFailureInfo`) and the deployment mode; ServingRuntimes and
// ClusterServingRuntimes; InferenceGraphs and TrainedModels. Pure functions, no React.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";

const { arr, get, num, record, str } = status;

export const KSERVE_GROUP = "serving.kserve.io";
const k = (version: string, kind: string): KindRef => ({ group: KSERVE_GROUP, version, kind });

export const INFERENCE_SERVICE = k("v1beta1", "InferenceService");
export const SERVING_RUNTIME = k("v1alpha1", "ServingRuntime");
export const CLUSTER_SERVING_RUNTIME = k("v1alpha1", "ClusterServingRuntime");
export const INFERENCE_GRAPH = k("v1alpha1", "InferenceGraph");
export const TRAINED_MODEL = k("v1alpha1", "TrainedModel");

export interface KServeKind {
  kind: KindRef;
  order: number;
  /** Key under `kserve:sidebar`. */
  label: string;
  namespaced: boolean;
}

export const KSERVE_KINDS: KServeKind[] = [
  { kind: INFERENCE_SERVICE, order: 10, label: "inferenceServices", namespaced: true },
  { kind: SERVING_RUNTIME, order: 20, label: "servingRuntimes", namespaced: true },
  { kind: CLUSTER_SERVING_RUNTIME, order: 21, label: "clusterServingRuntimes", namespaced: false },
  { kind: INFERENCE_GRAPH, order: 30, label: "inferenceGraphs", namespaced: true },
  { kind: TRAINED_MODEL, order: 40, label: "trainedModels", namespaced: true },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

export const kserveKind = (kind: Pick<KindRef, "group" | "kind">): KServeKind | undefined => KSERVE_KINDS.find((d) => isKind(kind, d.kind));

/** Labels KServe puts on a component's Knative Service, Deployment and Service (pkg/constants/constants.go). */
export const ISVC_LABEL = "serving.kserve.io/inferenceservice";
export const COMPONENT_LABEL = "component";
export const DEPLOYMENT_MODE_ANNOTATION = "serving.kserve.io/deploymentMode";
export const STOP_ANNOTATION = "serving.kserve.io/stop";

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  since?: string;
}

export function conditionsOf(obj: KubeObject): Condition[] {
  return arr(get(obj, "status", "conditions")).map((c) => ({
    type: str(get(c, "type")) ?? "",
    status: str(get(c, "status")) ?? "Unknown",
    reason: str(get(c, "reason")),
    message: str(get(c, "message")),
    since: str(get(c, "lastTransitionTime")),
  }));
}

export const conditionOf = (obj: KubeObject, type: string): Condition | undefined => conditionsOf(obj).find((c) => c.type === type);

// ---------- URIs ----------

const URI = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)([?#].*)?$/i;

export interface SafeUri {
  text: string;
  /** Credentials (`user:password@`), a query or a fragment were left out. */
  hidden: boolean;
}

/**
 * A URI as it may be shown: without its userinfo (`user:token@`), query (`?X-Amz-Signature=…`, a SAS token) and
 * fragment, which can carry credentials. A text that is not `scheme://…` loses everything from its first `?` or `#`.
 */
export function safeUri(value: string | undefined): SafeUri | undefined {
  if (!value) return undefined;
  const m = URI.exec(value);
  if (!m) {
    const cut = value.search(/[?#]/);
    return cut < 0 ? { text: value, hidden: false } : { text: value.slice(0, cut), hidden: true };
  }
  const authority = m[2] ?? "";
  const at = authority.lastIndexOf("@");
  const host = at < 0 ? authority : authority.slice(at + 1);
  return { text: `${m[1]}${host}${m[3] ?? ""}`, hidden: at >= 0 || Boolean(m[4]) };
}

// ---------- Deployment mode ----------

export type DeploymentMode = "knative" | "standard" | "modelMesh" | "other";

/**
 * The deployment mode: `status.deploymentMode` (KServe records the mode it used), else the annotation
 * `serving.kserve.io/deploymentMode`; `Serverless` is the old name of `Knative`, `RawDeployment` of `Standard`
 * (`ParseDeploymentMode` in pkg/constants). `undefined`: neither says, the cluster's default applies (set in the
 * `inferenceservice-config` ConfigMap, which Sextant does not read).
 */
export function deploymentModeOf(obj: KubeObject): { mode: DeploymentMode; raw: string } | undefined {
  const raw = str(get(obj, "status", "deploymentMode")) || str(record(obj.metadata?.annotations)[DEPLOYMENT_MODE_ANNOTATION]);
  if (!raw) return undefined;
  if (raw === "Serverless" || raw === "Knative") return { mode: "knative", raw };
  if (raw === "RawDeployment" || raw === "Standard") return { mode: "standard", raw };
  if (raw === "ModelMesh") return { mode: "modelMesh", raw };
  return { mode: "other", raw };
}

// ---------- InferenceService ----------

export const COMPONENTS = ["predictor", "transformer", "explainer"] as const;
export type ComponentName = (typeof COMPONENTS)[number];

/** The predictor's old framework fields, each defaulted to `model.modelFormat.name` of the same name by KServe's webhook. */
const FRAMEWORKS = ["sklearn", "xgboost", "tensorflow", "pytorch", "triton", "onnx", "huggingface", "pmml", "lightgbm", "paddle"];

export interface ModelFormat {
  name: string;
  version?: string;
}

export interface ComponentSpec {
  name: ComponentName;
  format?: ModelFormat;
  /** `model.runtime` as written (KServe picks one when it is not). */
  runtime?: string;
  storageUri?: string;
  protocolVersion?: string;
  minReplicas?: number;
  maxReplicas?: number;
  canaryTrafficPercent?: number;
  /** Multi-node serving (`workerSpec`). */
  workers: boolean;
  /** Images of custom containers. */
  images: string[];
}

function componentSpec(name: ComponentName, spec: unknown): ComponentSpec {
  const model = get(spec, "model");
  const framework = name === "predictor" ? FRAMEWORKS.find((f) => get(spec, f) !== undefined) : undefined;
  const source = model ?? (framework ? get(spec, framework) : undefined);
  const formatName = str(get(model, "modelFormat", "name")) ?? framework;
  const storage =
    str(get(source, "storageUri")) ??
    str(get(spec, "art", "storageUri")) ??
    str(get(arr(get(spec, "storageUris"))[0], "uri")) ??
    arr(get(spec, "containers"))
      .flatMap((c) => arr(get(c, "env")))
      .map((e) => (get(e, "name") === "STORAGE_URI" ? str(get(e, "value")) : undefined))
      .find(Boolean);
  return {
    name,
    format: formatName ? { name: formatName, version: str(get(model, "modelFormat", "version")) } : undefined,
    runtime: str(get(model, "runtime")),
    storageUri: storage,
    protocolVersion: str(get(source, "protocolVersion")),
    minReplicas: num(get(spec, "minReplicas")),
    maxReplicas: num(get(spec, "maxReplicas")),
    canaryTrafficPercent: num(get(spec, "canaryTrafficPercent")),
    workers: get(spec, "workerSpec") !== undefined,
    images: arr(get(spec, "containers")).map((c) => str(get(c, "image"))).filter((i): i is string => Boolean(i)),
  };
}

/** The components the spec has, predictor first. */
export const componentsOf = (obj: KubeObject): ComponentSpec[] =>
  COMPONENTS.filter((c) => get(obj, "spec", c) !== undefined).map((c) => componentSpec(c, get(obj, "spec", c)));

export interface Traffic {
  revision?: string;
  percent?: number;
  tag?: string;
  latest: boolean;
}

export interface ComponentStatus {
  latestReadyRevision?: string;
  latestCreatedRevision?: string;
  previousRolledoutRevision?: string;
  latestRolledoutRevision?: string;
  traffic: Traffic[];
  url?: string;
}

export function componentStatusOf(obj: KubeObject, name: ComponentName): ComponentStatus | undefined {
  const s = get(obj, "status", "components", name);
  if (s === undefined) return undefined;
  return {
    latestReadyRevision: str(get(s, "latestReadyRevision")),
    latestCreatedRevision: str(get(s, "latestCreatedRevision")),
    previousRolledoutRevision: str(get(s, "previousRolledoutRevision")),
    latestRolledoutRevision: str(get(s, "latestRolledoutRevision")),
    traffic: arr(get(s, "traffic")).map((tr) => ({
      revision: str(get(tr, "revisionName")),
      percent: num(get(tr, "percent")),
      tag: str(get(tr, "tag")),
      latest: get(tr, "latestRevision") === true,
    })),
    url: str(get(s, "url")),
  };
}

/** The share of the predictor's traffic on its latest revision while a canary rolls out; `undefined` without a split. */
export function canaryPercent(obj: KubeObject): number | undefined {
  const traffic = componentStatusOf(obj, "predictor")?.traffic ?? [];
  if (traffic.length < 2) return undefined;
  return traffic.filter((t) => t.latest).reduce((sum, t) => sum + (t.percent ?? 0), 0);
}

export interface ModelStatus {
  transitionStatus?: string;
  activeModelState?: string;
  targetModelState?: string;
  failure?: { reason?: string; message?: string; location?: string; time?: string; exitCode?: number; revision?: string };
  copies?: { failed?: number; total?: number };
}

export function modelStatusOf(obj: KubeObject): ModelStatus {
  const m = get(obj, "status", "modelStatus");
  const f = get(m, "lastFailureInfo");
  return {
    transitionStatus: str(get(m, "transitionStatus")),
    activeModelState: str(get(m, "states", "activeModelState")) || undefined,
    targetModelState: str(get(m, "states", "targetModelState")) || undefined,
    failure:
      f === undefined
        ? undefined
        : {
            reason: str(get(f, "reason")),
            message: str(get(f, "message")),
            location: str(get(f, "location")),
            time: str(get(f, "time")),
            exitCode: num(get(f, "exitCode")),
            revision: str(get(f, "modelRevisionName")),
          },
    copies: get(m, "copies") === undefined ? undefined : { failed: num(get(m, "copies", "failedCopies")), total: num(get(m, "copies", "totalCopies")) },
  };
}

/** The model failed to load (`FailedToLoad` state, or a transition blocked by a failed load). */
export function modelFailed(m: ModelStatus): boolean {
  return m.activeModelState === "FailedToLoad" || m.targetModelState === "FailedToLoad" || m.transitionStatus === "BlockedByFailedLoad";
}

export type ServiceState = "ready" | "progressing" | "notReady" | "failed" | "stopped";

export const SERVICE_TONE: Record<ServiceState, Tone> = {
  ready: "success",
  progressing: "warning",
  notReady: "warning",
  failed: "danger",
  stopped: "muted",
};

/** Stopped on purpose: the `serving.kserve.io/stop: "true"` annotation or the `Stopped` condition True. */
export const isStopped = (obj: KubeObject): boolean =>
  str(record(obj.metadata?.annotations)[STOP_ANNOTATION]) === "true" || conditionOf(obj, "Stopped")?.status === "True";

/** The aggregated readiness the other conditions feed (knative.dev's `Ready`). */
const READY = "Ready";
/** Conditions that are no fault when False (a stopped service's `Stopped` is True; no canary). */
const NOT_FAULTS = new Set([READY, "Stopped"]);

/**
 * Conditions in the order their failure explains the others (inference_service_status.go): a component that is not
 * ready makes the routes and the ingress not ready too, so the components come first, the ingress last.
 */
const CAUSE_ORDER = [
  "PredictorReady",
  "TransformerReady",
  "ExplainerReady",
  "PredictorConfigurationReady",
  "TransformerConfigurationReady",
  "ExplainerConfigurationReady",
  "LatestDeploymentReady",
  "CanaryPredictorReady",
  "PredictorRouteReady",
  "TransformerRouteReady",
  "ExplainerRoutesReady",
  "RoutesReady",
  "IngressReady",
];
const causeRank = (type: string): number => {
  const i = CAUSE_ORDER.indexOf(type);
  return i < 0 ? CAUSE_ORDER.length : i;
};

/** The condition that keeps the service from Ready: the most basic False one other than Ready, else Ready itself. */
export function failingCondition(obj: KubeObject): Condition | undefined {
  const conditions = conditionsOf(obj);
  const causes = conditions.filter((c) => c.status === "False" && !NOT_FAULTS.has(c.type)).sort((a, b) => causeRank(a.type) - causeRank(b.type));
  return causes[0] ?? conditions.find((c) => c.type === READY && c.status === "False");
}

/**
 * An InferenceService's state: stopped on purpose; failed when its model failed to load or the spec is invalid
 * (`transitionStatus: InvalidSpec`); ready by its Ready condition; not ready when Ready is False; progressing while
 * Ready is Unknown or not written yet.
 */
export function serviceState(obj: KubeObject): ServiceState {
  if (isStopped(obj)) return "stopped";
  const model = modelStatusOf(obj);
  if (modelFailed(model) || model.transitionStatus === "InvalidSpec") return "failed";
  const ready = conditionOf(obj, READY);
  if (ready?.status === "True") return "ready";
  if (ready?.status === "False") return "notReady";
  return "progressing";
}

/** What explains the state in KServe's words: the failing condition, else the model's last failure. */
export function serviceReason(obj: KubeObject): string | undefined {
  const model = modelStatusOf(obj);
  if (modelFailed(model) && model.failure?.message) return model.failure.message;
  const c = failingCondition(obj);
  return c ? c.message || c.reason : undefined;
}

/** The runtime KServe recorded for the predictor (newer KServe), namespaced or cluster-wide. */
export function recordedRuntimeOf(obj: KubeObject): { name: string; cluster: boolean } | undefined {
  const ns = str(get(obj, "status", "servingRuntimeName"));
  if (ns) return { name: ns, cluster: false };
  const cluster = str(get(obj, "status", "clusterServingRuntimeName"));
  return cluster ? { name: cluster, cluster: true } : undefined;
}

// ---------- Problems ----------

/** An InferenceService not ready counts after this long: a model download and a first revision take a while. */
export const KSERVE_GRACE_MS = 10 * 60_000;

/**
 * The problems of an InferenceService: not ready after a grace (the failing condition's reason and message), and
 * a model that failed to load (at once, from `modelStatus`). A stopped or deleted one has none.
 */
export function kserveProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  if (!isKind(kind, INFERENCE_SERVICE) || obj.metadata?.deletionTimestamp || isStopped(obj)) return [];
  const found: Detected[] = [];
  const model = modelStatusOf(obj);
  if (modelFailed(model)) {
    found.push({
      reason: model.failure?.reason || "FailedToLoad",
      group: "modelLoad",
      message: model.failure?.message,
      since: model.failure?.time,
      notify: true,
    });
  }
  const ready = conditionOf(obj, READY);
  if (ready?.status === "False") {
    const failing = failingCondition(obj);
    found.push({
      reason: failing?.reason || (failing && failing.type !== READY ? `${failing.type}False` : "InferenceServiceNotReady"),
      group: "notReady",
      message: failing?.message,
      since: ready.since,
      graceMs: KSERVE_GRACE_MS,
      notify: true,
    });
  }
  return found;
}

/** Whether the table's "Only problems" filter shows the object (no grace). */
export const isProblem = (obj: KubeObject, kind: Pick<KindRef, "group" | "kind">): boolean => kserveProblems(kind, obj).length > 0;
