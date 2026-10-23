// What the Cluster API section reads from cluster.x-k8s.io objects (#243, ADR-0113): the kinds it knows, and each
// object's state from its own status — phase, conditions, failure fields, replica counts — in both shapes the API has:
//
//   v1beta2 (Cluster API ≥ 1.11): `status.conditions` are the new conditions (Available, Ready, UpToDate, …),
//     the counts are `status.readyReplicas` / `availableReplicas` / `upToDateReplicas`, and the old v1beta1
//     conditions, `failureReason` and `failureMessage` moved to `status.deprecated.v1beta1`;
//   v1beta1: `status.conditions` are the old conditions (with a severity), the failure fields sit on `status`, and
//     since Cluster API 1.9 the new conditions and counts are mirrored under `status.v1beta2`.
//
// The new conditions are read first; an older Cluster API that writes only the old ones is read from those.
// References are `{apiGroup, kind, name}` in v1beta2 and `{apiVersion, kind, name, namespace}` in v1beta1.
// Pure functions, no React. Read-only.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";

const { arr, get, num, record, str } = status;

export const CAPI_GROUP = "cluster.x-k8s.io";
export const CONTROL_PLANE_GROUP = "controlplane.cluster.x-k8s.io";
export const ADDONS_GROUP = "addons.cluster.x-k8s.io";
export const INFRASTRUCTURE_GROUP = "infrastructure.cluster.x-k8s.io";
export const BOOTSTRAP_GROUP = "bootstrap.cluster.x-k8s.io";

const k = (group: string, kind: string): KindRef => ({ group, version: "v1beta2", kind });

export const CAPI_CLUSTER = k(CAPI_GROUP, "Cluster");
export const CLUSTER_CLASS = k(CAPI_GROUP, "ClusterClass");
export const MACHINE = k(CAPI_GROUP, "Machine");
export const MACHINE_SET = k(CAPI_GROUP, "MachineSet");
export const MACHINE_DEPLOYMENT = k(CAPI_GROUP, "MachineDeployment");
export const MACHINE_HEALTH_CHECK = k(CAPI_GROUP, "MachineHealthCheck");
export const KUBEADM_CONTROL_PLANE = k(CONTROL_PLANE_GROUP, "KubeadmControlPlane");
export const CLUSTER_RESOURCE_SET = k(ADDONS_GROUP, "ClusterResourceSet");

export interface CapiKind {
  kind: KindRef;
  order: number;
  /** Key under `clusterapi:sidebar`. */
  label: string;
}

export const CAPI_KINDS: CapiKind[] = [
  { kind: CAPI_CLUSTER, order: 10, label: "clusters" },
  { kind: CLUSTER_CLASS, order: 11, label: "clusterClasses" },
  { kind: KUBEADM_CONTROL_PLANE, order: 20, label: "controlPlanes" },
  { kind: MACHINE_DEPLOYMENT, order: 30, label: "machineDeployments" },
  { kind: MACHINE_SET, order: 31, label: "machineSets" },
  { kind: MACHINE, order: 32, label: "machines" },
  { kind: MACHINE_HEALTH_CHECK, order: 40, label: "machineHealthChecks" },
  { kind: CLUSTER_RESOURCE_SET, order: 50, label: "clusterResourceSets" },
];

/** The kinds the problems screen watches (category `clusterApi`). */
export const PROBLEM_KINDS: KindRef[] = [CAPI_CLUSTER, KUBEADM_CONTROL_PLANE, MACHINE, MACHINE_HEALTH_CHECK];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

export const capiKind = (kind: Pick<KindRef, "group" | "kind">): CapiKind | undefined =>
  CAPI_KINDS.find((d) => isKind(kind, d.kind));

/** Whether the problems of `kind` are judged here (the kinds the `clusterApi` category watches). */
export const isProblemKind = (kind: Pick<KindRef, "group" | "kind">): boolean => isKind(kind, ...PROBLEM_KINDS);

// ---------- The two shapes ----------

/** A v1beta1 (or older) object: the new status is under `status.v1beta2`, the old one on `status`. */
export function isLegacy(obj: KubeObject): boolean {
  const version = (obj.apiVersion ?? "").split("/")[1] ?? "";
  return version === "v1beta1" || version.startsWith("v1alpha");
}

/** The status of the v1beta2 shape, wherever it is. */
const fresh = (obj: KubeObject): unknown => (isLegacy(obj) ? get(obj, "status", "v1beta2") : get(obj, "status"));
/** The status of the v1beta1 shape, wherever it is. */
const old = (obj: KubeObject): unknown => (isLegacy(obj) ? get(obj, "status") : get(obj, "status", "deprecated", "v1beta1"));

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  since?: string;
  /** v1beta1 conditions only: Error, Warning or Info when the condition is False. */
  severity?: string;
}

function readConditions(list: unknown): Condition[] {
  return arr(list).flatMap((c) => {
    const type = str(get(c, "type"));
    if (!type) return [];
    return [
      {
        type,
        status: str(get(c, "status")) ?? "Unknown",
        reason: str(get(c, "reason")) || undefined,
        message: str(get(c, "message")) || undefined,
        since: str(get(c, "lastTransitionTime")),
        severity: str(get(c, "severity")) || undefined,
      },
    ];
  });
}

/** The new (v1beta2) conditions. */
export const conditionsOf = (obj: KubeObject): Condition[] => readConditions(get(fresh(obj), "conditions"));
/** The old (v1beta1) conditions. */
export const legacyConditionsOf = (obj: KubeObject): Condition[] => readConditions(get(old(obj), "conditions"));

/**
 * A condition by type: of the new conditions when the object has any, else of the old ones (an older Cluster API).
 * `legacyType` names the old condition that stands for it when it is called otherwise (`Available` → `Ready`).
 */
export function conditionOf(obj: KubeObject, type: string, legacyType: string = type): Condition | undefined {
  const list = conditionsOf(obj);
  if (list.length > 0) return list.find((c) => c.type === type);
  return legacyConditionsOf(obj).find((c) => c.type === legacyType);
}

/**
 * Whether the object is available: the new Available condition; on an object with only old conditions, the old
 * Available (MachineDeployment, KubeadmControlPlane) or else the old Ready (Cluster, MachineSet).
 */
export function availableOf(obj: KubeObject): Condition | undefined {
  if (conditionsOf(obj).length > 0) return conditionOf(obj, "Available");
  const old = legacyConditionsOf(obj);
  return decisive(old.find((c) => c.type === "Available") ?? old.find((c) => c.type === "Ready"));
}

/**
 * An old (v1beta1) condition as a verdict: a False of severity Info or Warning is a passing state the controllers
 * set while they wait or work (cluster-api `api/v1beta1/condition_types.go`: Info "should not be considered an
 * error", Warning "might be a problem soon"; e.g. `WaitingForControlPlane`, `ScalingUp`), so it decides nothing —
 * only Error (or no severity) does. The new conditions have no severity and are read as they are.
 */
export function decisive(c: Condition | undefined): Condition | undefined {
  return c && c.status === "False" && (c.severity === "Info" || c.severity === "Warning") ? undefined : c;
}

/** A Machine's Ready condition: the new one, else the old one as a verdict (`decisive`). */
export function machineReadyOf(obj: KubeObject): Condition | undefined {
  if (conditionsOf(obj).length > 0) return conditionOf(obj, "Ready");
  return decisive(legacyConditionsOf(obj).find((c) => c.type === "Ready"));
}

/**
 * The first condition that is False — of the new ones when there are any — leaving out the conditions whose False is
 * good news (Deleting, Paused, ScalingUp, …) and old ones of severity Info or Warning (`decisive`).
 */
export function firstFailing(obj: KubeObject): Condition | undefined {
  const negative = new Set(["Deleting", "Paused", "ScalingUp", "ScalingDown", "RollingOut", "Remediating", "Updating"]);
  const list = conditionsOf(obj);
  if (list.length > 0) return list.find((c) => !negative.has(c.type) && c.status === "False");
  return legacyConditionsOf(obj).find((c) => !negative.has(c.type) && c.status === "False" && decisive(c) !== undefined);
}

/** `failureReason` / `failureMessage` of the v1beta1 status: a terminal error the controllers will not retry. */
export function failureOf(obj: KubeObject): { reason?: string; message?: string } | undefined {
  const s = old(obj);
  const reason = str(get(s, "failureReason")) || undefined;
  const message = str(get(s, "failureMessage")) || undefined;
  return reason || message ? { reason, message } : undefined;
}

export const phaseOf = (obj: KubeObject): string | undefined => str(get(obj, "status", "phase")) || undefined;

/** Paused: `spec.paused`, the `cluster.x-k8s.io/paused` annotation or the Paused condition. Nothing is reconciled. */
export function isPaused(obj: KubeObject): boolean {
  if (get(obj, "spec", "paused") === true) return true;
  if (PAUSED_ANNOTATION in record(obj.metadata?.annotations)) return true;
  return conditionsOf(obj).some((c) => c.type === "Paused" && c.status === "True");
}
export const PAUSED_ANNOTATION = "cluster.x-k8s.io/paused";

export const isDeleting = (obj: KubeObject): boolean => Boolean(obj.metadata?.deletionTimestamp) || phaseOf(obj) === "Deleting";

// ---------- Replicas ----------

export interface Replicas {
  desired?: number;
  /** Machines that exist, also those being provisioned or deleted. */
  current?: number;
  ready?: number;
  available?: number;
  upToDate?: number;
}

const hasAny = (r: Replicas) => Object.values(r).some((v) => v !== undefined);

/**
 * The replica counts of a MachineDeployment, MachineSet or KubeadmControlPlane by the v1beta2 meaning (ready: the
 * Machine's Ready condition, up to date: its UpToDate condition). A v1beta1 object without `status.v1beta2` gives its
 * old counts: ready nodes and `updatedReplicas`.
 */
export function replicasOf(obj: KubeObject): Replicas {
  const desired = num(get(obj, "spec", "replicas"));
  const current = num(get(obj, "status", "replicas"));
  const s = fresh(obj);
  const counts: Replicas = { ready: num(get(s, "readyReplicas")), available: num(get(s, "availableReplicas")), upToDate: num(get(s, "upToDateReplicas")) };
  if (isLegacy(obj) && !hasAny(counts)) {
    const o = get(obj, "status");
    return { desired, current, ready: num(get(o, "readyReplicas")), available: num(get(o, "availableReplicas")), upToDate: num(get(o, "updatedReplicas")) };
  }
  return { desired, current, ...counts };
}

function groupReplicas(value: unknown): Replicas | undefined {
  const r: Replicas = {
    desired: num(get(value, "desiredReplicas")),
    current: num(get(value, "replicas")),
    ready: num(get(value, "readyReplicas")),
    available: num(get(value, "availableReplicas")),
    upToDate: num(get(value, "upToDateReplicas")),
  };
  return hasAny(r) ? r : undefined;
}

/** A Cluster's control plane and worker Machines as its status counts them (v1beta2 shape only). */
export function clusterReplicasOf(obj: KubeObject): { controlPlane?: Replicas; workers?: Replicas } {
  const s = fresh(obj);
  return { controlPlane: groupReplicas(get(s, "controlPlane")), workers: groupReplicas(get(s, "workers")) };
}

/** "ready/desired", or `undefined` when neither is known. */
export function readyText(r: Replicas | undefined): string | undefined {
  if (!r || (r.ready === undefined && r.desired === undefined)) return undefined;
  return `${r.ready ?? 0}/${r.desired ?? r.current ?? 0}`;
}

// ---------- References ----------

export interface CapiRef {
  group: string;
  /** Only v1beta1 references name it; a v1beta2 one is resolved by discovery. */
  version?: string;
  kind: string;
  name: string;
  namespace: string | null;
}

/** A reference in either shape; a v1beta2 reference is always in the object's own namespace. */
export function refFrom(value: unknown, namespace: string | null): CapiRef | undefined {
  const kind = str(get(value, "kind"));
  const name = str(get(value, "name"));
  if (!kind || !name) return undefined;
  const apiGroup = str(get(value, "apiGroup"));
  const apiVersion = str(get(value, "apiVersion"));
  let group = apiGroup ?? "";
  let version: string | undefined;
  if (apiGroup === undefined && apiVersion) {
    const parts = apiVersion.split("/");
    group = parts.length > 1 ? parts[0]! : "";
    version = parts[parts.length - 1];
  }
  return { group, version, kind, name, namespace: str(get(value, "namespace")) ?? namespace };
}

const nsOf = (obj: KubeObject) => obj.metadata?.namespace ?? null;

export const controlPlaneRefOf = (cluster: KubeObject) => refFrom(get(cluster, "spec", "controlPlaneRef"), nsOf(cluster));
export const infrastructureRefOf = (obj: KubeObject) => refFrom(get(obj, "spec", "infrastructureRef"), nsOf(obj));
export const bootstrapRefOf = (machine: KubeObject) => refFrom(get(machine, "spec", "bootstrap", "configRef"), nsOf(machine));
/** A KubeadmControlPlane's machine template: `spec.machineTemplate.spec.infrastructureRef` (v1beta2) or `.infrastructureRef`. */
export const kcpTemplateRefOf = (kcp: KubeObject) =>
  refFrom(get(kcp, "spec", "machineTemplate", "spec", "infrastructureRef") ?? get(kcp, "spec", "machineTemplate", "infrastructureRef"), nsOf(kcp));
/** The ClusterClass of a managed topology: `spec.topology.classRef.name` (v1beta2) or `spec.topology.class`. */
export function classOf(cluster: KubeObject): { name: string; namespace: string | null } | undefined {
  const name = str(get(cluster, "spec", "topology", "classRef", "name")) ?? str(get(cluster, "spec", "topology", "class"));
  if (!name) return undefined;
  return { name, namespace: str(get(cluster, "spec", "topology", "classRef", "namespace")) ?? str(get(cluster, "spec", "topology", "classNamespace")) ?? nsOf(cluster) };
}

export const CLUSTER_NAME_LABEL = "cluster.x-k8s.io/cluster-name";
export const CONTROL_PLANE_LABEL = "cluster.x-k8s.io/control-plane";

/** The Cluster an object belongs to: `spec.clusterName`, else the `cluster.x-k8s.io/cluster-name` label. */
export const clusterNameOf = (obj: KubeObject): string | undefined =>
  str(get(obj, "spec", "clusterName")) || str(record(obj.metadata?.labels)[CLUSTER_NAME_LABEL]) || undefined;

/** The Node of a Machine in the workload cluster (`status.nodeRef.name`). */
export const nodeNameOf = (machine: KubeObject): string | undefined => str(get(machine, "status", "nodeRef", "name")) || undefined;

export const isControlPlaneMachine = (machine: KubeObject): boolean => CONTROL_PLANE_LABEL in record(machine.metadata?.labels);

/** A label selector (`matchLabels`, `matchExpressions`) as the API server's selector string; `undefined` when empty. */
export function selectorString(selector: unknown): string | undefined {
  const parts = Object.entries(record(get(selector, "matchLabels"))).map(([key, v]) => `${key}=${String(v)}`);
  for (const e of arr(get(selector, "matchExpressions"))) {
    const key = str(get(e, "key"));
    const values = arr(get(e, "values")).map(String).join(",");
    if (!key) continue;
    const op = str(get(e, "operator"));
    if (op === "In") parts.push(`${key} in (${values})`);
    else if (op === "NotIn") parts.push(`${key} notin (${values})`);
    else if (op === "Exists") parts.push(key);
    else if (op === "DoesNotExist") parts.push(`!${key}`);
  }
  return parts.length > 0 ? parts.join(",") : undefined;
}

/** The selector of an object's Machines: `status.selector` (what the controller uses), else `spec.selector`. */
export const machineSelectorOf = (obj: KubeObject): string | undefined =>
  str(get(obj, "status", "selector")) || selectorString(get(obj, "spec", "selector"));

// ---------- The workload cluster ----------

export interface Endpoint {
  host: string;
  port: number;
}

/** `spec.controlPlaneEndpoint` of a Cluster (or an infrastructure cluster), once it is known. */
export function endpointOf(obj: KubeObject): Endpoint | undefined {
  const host = str(get(obj, "spec", "controlPlaneEndpoint", "host"));
  const port = num(get(obj, "spec", "controlPlaneEndpoint", "port"));
  return host && port ? { host, port } : undefined;
}

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();

/**
 * Whether a kubeconfig server URL points at the endpoint: the same host (case-insensitive, IPv6 without brackets)
 * and the same port (443 when the URL names none). Only an exact match: an endpoint reached through a rewritten
 * address (a port mapped to 127.0.0.1, a proxy) is not recognised.
 */
export function serverMatches(server: string, endpoint: Endpoint): boolean {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return false;
  }
  const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  return bare(url.hostname) === bare(endpoint.host) && port === endpoint.port;
}

// ---------- Provider objects ----------

/**
 * Whether a provider object is done by the Cluster API contract: `status.initialization.provisioned` (an
 * infrastructure object, v1beta2 contract), `status.initialization.dataSecretCreated` (a bootstrap config),
 * `status.ready` (v1beta1 contract), else its Ready condition; `undefined` when it says nothing.
 */
export function providerReady(obj: KubeObject): boolean | undefined {
  for (const field of ["provisioned", "dataSecretCreated", "controlPlaneInitialized"]) {
    const v = get(obj, "status", "initialization", field);
    if (typeof v === "boolean") return v;
  }
  const ready = get(obj, "status", "ready");
  if (typeof ready === "boolean") return ready;
  const c = readConditions(get(obj, "status", "conditions")).find((x) => x.type === "Ready");
  return c ? c.status === "True" : undefined;
}

/** A provider object's terminal error (`status.failureMessage`, also under `deprecated.v1beta1`). */
export const providerFailureOf = (obj: KubeObject): string | undefined =>
  str(get(obj, "status", "failureMessage")) || str(get(obj, "status", "deprecated", "v1beta1", "failureMessage")) || undefined;

/**
 * A few fields of the infrastructure kinds most installations use, when the cluster serves them (keys under
 * `clusterapi:provider`); any other kind is shown by its readiness alone.
 */
export function providerFields(obj: KubeObject): [key: string, value: string | undefined][] {
  const [group] = (obj.apiVersion ?? "").split("/");
  if (group !== INFRASTRUCTURE_GROUP) return [];
  const spec = (...path: string[]) => {
    const v = get(obj, "spec", ...path);
    return typeof v === "number" ? String(v) : str(v) || undefined;
  };
  const st = (...path: string[]) => str(get(obj, "status", ...path)) || undefined;
  switch (obj.kind) {
    case "DockerMachine":
      return [["customImage", spec("customImage")]];
    case "DockerCluster": {
      const e = endpointOf(obj);
      return [["endpoint", e ? `${e.host}:${e.port}` : undefined]];
    }
    case "AWSMachine":
      return [["instanceType", spec("instanceType")], ["instanceState", st("instanceState")], ["instanceId", spec("instanceID")]];
    case "AzureMachine":
      return [["vmSize", spec("vmSize")], ["vmState", st("vmState")]];
    case "VSphereMachine":
      return [["template", spec("template")], ["cpus", spec("numCPUs")], ["memoryMiB", spec("memoryMiB")]];
    default:
      return [];
  }
}

/** The addresses in `status.addresses` (a Machine's or an infrastructure machine's). */
export const addressesOf = (obj: KubeObject): string[] =>
  arr(get(obj, "status", "addresses"))
    .map((a) => str(get(a, "address")))
    .filter((a): a is string => Boolean(a));

// ---------- States ----------

export type ClusterState = "available" | "provisioned" | "provisioning" | "notAvailable" | "deleting" | "failed" | "paused" | "unknown";
export type MachineState = "running" | "notReady" | "provisioning" | "updating" | "deleting" | "failed" | "paused" | "unknown";
export type ScalableState = "available" | "provisioning" | "rollingOut" | "scaling" | "notAvailable" | "deleting" | "failed" | "paused" | "unknown";
export type HealthCheckState = "healthy" | "remediating" | "blocked" | "unknown";

export const STATE_TONE: Record<ClusterState | MachineState | ScalableState | HealthCheckState, Tone> = {
  available: "success",
  provisioned: "success",
  running: "success",
  healthy: "success",
  provisioning: "warning",
  updating: "warning",
  rollingOut: "warning",
  scaling: "warning",
  remediating: "warning",
  notReady: "danger",
  notAvailable: "danger",
  failed: "danger",
  blocked: "danger",
  deleting: "muted",
  paused: "muted",
  unknown: "muted",
};

const PROVISIONING_PHASES = new Set(["Pending", "Provisioning"]);

/** A Cluster by its phase (Pending, Provisioning, Provisioned, Deleting, Failed) and its Available condition. */
export function clusterState(obj: KubeObject): ClusterState {
  const phase = phaseOf(obj);
  if (isDeleting(obj)) return "deleting";
  if (failureOf(obj) || phase === "Failed") return "failed";
  if (isPaused(obj)) return "paused";
  const available = availableOf(obj);
  if (available?.status === "True") return "available";
  if (phase && PROVISIONING_PHASES.has(phase)) return "provisioning";
  if (available?.status === "False") return "notAvailable";
  if (phase === "Provisioned") return "provisioned";
  return "unknown";
}

/** A Machine by its phase (Pending, Provisioning, Provisioned, Running, Updating, Deleting, Deleted, Failed). */
export function machineState(obj: KubeObject): MachineState {
  const phase = phaseOf(obj);
  if (isDeleting(obj) || phase === "Deleted") return "deleting";
  if (failureOf(obj) || phase === "Failed") return "failed";
  if (isPaused(obj)) return "paused";
  if (phase === "Pending" || phase === "Provisioning" || phase === "Provisioned") return "provisioning";
  if (phase === "Updating") return "updating";
  if (phase === "Running") return machineReadyOf(obj)?.status === "False" ? "notReady" : "running";
  return "unknown";
}

const isTrue = (obj: KubeObject, type: string) => conditionsOf(obj).some((c) => c.type === type && c.status === "True");

/** Whether a KubeadmControlPlane has initialized its control plane (v1beta2 `initialization`, v1beta1 `initialized`). */
export function kcpInitialized(obj: KubeObject): boolean | undefined {
  const v = get(obj, "status", "initialization", "controlPlaneInitialized") ?? get(obj, "status", "initialized");
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Whether a Cluster's control plane is initialized (accepts requests): v1beta2 `status.initialization
 * .controlPlaneInitialized` (cluster-api `api/core/v1beta2/cluster_types.go`, `ClusterInitializationStatus`), v1beta1
 * the `ControlPlaneInitialized` condition (new: `ClusterControlPlaneInitializedCondition`; old:
 * `ControlPlaneInitializedCondition`, `api/v1beta1/condition_consts.go`), else v1beta1 `status.controlPlaneReady`
 * (`api/v1beta1/cluster_types.go`);
 * `undefined` when the Cluster says nothing of it. Until then the Cluster cannot be available, so "not available" is
 * judged with the long provisioning grace.
 */
export function clusterControlPlaneInitialized(obj: KubeObject): boolean | undefined {
  const init = get(obj, "status", "initialization", "controlPlaneInitialized");
  if (typeof init === "boolean") return init;
  // The condition stays True once initialized; `controlPlaneReady` follows the control plane's readiness, so it is
  // only the last resort.
  const c = conditionsOf(obj).find((x) => x.type === "ControlPlaneInitialized") ?? legacyConditionsOf(obj).find((x) => x.type === "ControlPlaneInitialized");
  if (c) return c.status === "True";
  const ready = get(obj, "status", "controlPlaneReady");
  return typeof ready === "boolean" && isLegacy(obj) ? ready : undefined;
}

/** A MachineDeployment, MachineSet or KubeadmControlPlane by its conditions and replica counts. */
export function scalableState(obj: KubeObject): ScalableState {
  if (isDeleting(obj)) return "deleting";
  if (failureOf(obj) || phaseOf(obj) === "Failed") return "failed";
  if (isPaused(obj)) return "paused";
  if (obj.kind === KUBEADM_CONTROL_PLANE.kind && kcpInitialized(obj) === false) return "provisioning";
  const r = replicasOf(obj);
  if (isTrue(obj, "RollingOut") || (r.desired !== undefined && r.upToDate !== undefined && r.upToDate < r.desired)) return "rollingOut";
  if (isTrue(obj, "ScalingUp") || isTrue(obj, "ScalingDown") || (r.desired !== undefined && r.current !== undefined && r.current !== r.desired)) return "scaling";
  const available = availableOf(obj);
  if (available?.status === "False") return "notAvailable";
  if (available?.status === "True") return "available";
  if (r.desired !== undefined && r.ready === r.desired) return "available";
  // A v1beta2 MachineSet has no Available condition: fewer ready Machines than wanted, and no scaling, is not available.
  if (r.desired !== undefined && r.ready !== undefined && r.ready < r.desired) return "notAvailable";
  return "unknown";
}

/** A MachineHealthCheck: remediation blocked (RemediationAllowed False), Machines unhealthy, or all healthy. */
export function healthCheckState(obj: KubeObject): HealthCheckState {
  if (remediationBlocked(obj)) return "blocked";
  const { expected, healthy } = healthCountsOf(obj);
  if (expected === undefined || healthy === undefined) return "unknown";
  return healthy < expected ? "remediating" : "healthy";
}

export const remediationBlocked = (obj: KubeObject): Condition | undefined => {
  const c = conditionOf(obj, "RemediationAllowed");
  return c?.status === "False" ? c : undefined;
};

/** `expectedMachines`, `currentHealthy` and `remediationsAllowed` of a MachineHealthCheck's status. */
export function healthCountsOf(obj: KubeObject): { expected?: number; healthy?: number; allowed?: number } {
  const s = get(obj, "status");
  return { expected: num(get(s, "expectedMachines")), healthy: num(get(s, "currentHealthy")), allowed: num(get(s, "remediationsAllowed")) };
}

export interface UnhealthyCondition {
  type: string;
  status: string;
  /** As written: "300s" (v1beta2 seconds) or a Go duration ("5m", v1beta1). */
  timeout?: string;
}

export interface HealthCheckSpec {
  nodeConditions: UnhealthyCondition[];
  machineConditions: UnhealthyCondition[];
  nodeStartupTimeout?: string;
  /** `remediation.triggerIf.unhealthyLessThanOrEqualTo` (v1beta2) or `maxUnhealthy` (v1beta1). */
  maxUnhealthy?: string;
  /** `remediation.triggerIf.unhealthyInRange` (v1beta2) or `unhealthyRange` (v1beta1). */
  unhealthyRange?: string;
}

const seconds = (v: unknown) => (typeof v === "number" ? `${v}s` : undefined);
const text = (v: unknown) => (typeof v === "number" ? String(v) : str(v) || undefined);

function unhealthyList(list: unknown, legacy: boolean): UnhealthyCondition[] {
  return arr(list).flatMap((c) => {
    const type = str(get(c, "type"));
    if (!type) return [];
    return [{ type, status: str(get(c, "status")) ?? "", timeout: legacy ? str(get(c, "timeout")) : seconds(get(c, "timeoutSeconds")) }];
  });
}

/** What a MachineHealthCheck checks and when it stops remediating, in either shape. */
export function healthCheckSpecOf(obj: KubeObject): HealthCheckSpec {
  if (isLegacy(obj)) {
    const s = get(obj, "spec");
    return {
      nodeConditions: unhealthyList(get(s, "unhealthyConditions"), true),
      machineConditions: unhealthyList(get(s, "unhealthyMachineConditions"), true),
      nodeStartupTimeout: str(get(s, "nodeStartupTimeout")),
      maxUnhealthy: text(get(s, "maxUnhealthy")),
      unhealthyRange: str(get(s, "unhealthyRange")),
    };
  }
  const checks = get(obj, "spec", "checks");
  const trigger = get(obj, "spec", "remediation", "triggerIf");
  return {
    nodeConditions: unhealthyList(get(checks, "unhealthyNodeConditions"), false),
    machineConditions: unhealthyList(get(checks, "unhealthyMachineConditions"), false),
    nodeStartupTimeout: seconds(get(checks, "nodeStartupTimeoutSeconds")),
    maxUnhealthy: text(get(trigger, "unhealthyLessThanOrEqualTo")),
    unhealthyRange: str(get(trigger, "unhealthyInRange")),
  };
}

// ---------- Problems ----------

/** A Cluster or control plane not available counts after this long once provisioned. */
export const CAPI_GRACE_MS = 5 * 60_000;
/** A Machine still provisioning, or a Cluster or control plane still coming up, counts after this long. */
export const PROVISIONING_GRACE_MS = 30 * 60_000;
/** Blocked remediation counts after this long (a MachineHealthCheck recounts as Machines come back). */
export const REMEDIATION_GRACE_MS = 2 * 60_000;

function failed(obj: KubeObject): Detected | undefined {
  const failure = failureOf(obj);
  if (!failure && phaseOf(obj) !== "Failed") return undefined;
  return { reason: "Failed", group: "failed", message: failure?.message ?? failure?.reason, notify: true };
}

function notAvailable(obj: KubeObject, settled: boolean): Detected | undefined {
  const c = availableOf(obj);
  if (c?.status !== "False") return undefined;
  return {
    reason: "NotAvailable",
    group: "notAvailable",
    message: c.message ?? c.reason,
    since: c.since,
    graceMs: settled ? CAPI_GRACE_MS : PROVISIONING_GRACE_MS,
    notify: true,
  };
}

/** Why a Machine is not up yet: the first of its provisioning conditions that is False. */
function provisioningWhy(obj: KubeObject): string | undefined {
  for (const type of ["BootstrapConfigReady", "InfrastructureReady", "NodeReady", "NodeHealthy", "Ready"]) {
    const c = conditionOf(obj, type);
    if (c && c.status !== "True") return c.message ?? c.reason;
  }
  return undefined;
}

/**
 * The problems of a Cluster API object of `kind`: a failed Cluster, Machine or control plane (a terminal failure the
 * v1beta1 status reports, or the Failed phase); a Cluster or KubeadmControlPlane not available (after 5 minutes, or
 * 30 while still coming up); a Machine that has not reached Running 30 minutes after its phase last changed; a
 * MachineHealthCheck that stopped remediating (`RemediationAllowed` False: more Machines unhealthy than its
 * `unhealthyLessThanOrEqualTo` / `maxUnhealthy` allows). Deleting and paused objects have none; a Machine or control
 * plane carries its Cluster's name (`belongsTo`), so the problems store leaves it out while that Cluster is paused.
 * A Cluster is "not available" after 5 minutes only once its control plane is initialized, else after 30.
 */
export function capiProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  if (isDeleting(obj) || isPaused(obj)) return [];
  const found: (Detected | undefined)[] = [];
  if (isKind(kind, CAPI_CLUSTER)) {
    const f = failed(obj);
    const phase = phaseOf(obj);
    // Settled only past the provisioning phases and once its control plane is initialized (when the Cluster says).
    const settled = !(phase && PROVISIONING_PHASES.has(phase)) && clusterControlPlaneInitialized(obj) !== false;
    found.push(f ?? notAvailable(obj, settled));
  } else if (isKind(kind, KUBEADM_CONTROL_PLANE)) {
    found.push(failed(obj) ?? notAvailable(obj, kcpInitialized(obj) !== false));
  } else if (isKind(kind, MACHINE)) {
    const f = failed(obj);
    if (f) found.push(f);
    else if (machineState(obj) === "provisioning") {
      const phase = phaseOf(obj) ?? "";
      found.push({
        reason: "ProvisioningStuck",
        group: "provisioning",
        message: provisioningWhy(obj) ?? phase,
        since: str(get(obj, "status", "lastUpdated")) ?? str(obj.metadata?.creationTimestamp),
        graceMs: PROVISIONING_GRACE_MS,
        stamp: phase,
        notify: true,
      });
    }
  } else if (isKind(kind, MACHINE_HEALTH_CHECK)) {
    const c = remediationBlocked(obj);
    if (c) found.push({ reason: "RemediationBlocked", message: c.message ?? c.reason, since: c.since, graceMs: REMEDIATION_GRACE_MS, notify: true });
  }
  const cluster = isKind(kind, MACHINE, KUBEADM_CONTROL_PLANE) ? clusterNameOf(obj) : undefined;
  // A Machine's or control plane's Cluster: its problems are dropped while the Cluster is paused (across.ts).
  return found.filter((d): d is Detected => d !== undefined).map((d) => (cluster ? { ...d, belongsTo: cluster } : d));
}

/** Whether the table's "Only problems" filter shows `obj`: a problem whose grace has passed by `now`. */
export function isProblem(obj: KubeObject, kind: Pick<KindRef, "group" | "kind">, now: number = Date.now()): boolean {
  return capiProblems(kind, obj).some((d) => {
    const start = Date.parse(d.since ?? str(obj.metadata?.creationTimestamp) ?? "");
    return Number.isNaN(start) || start + (d.graceMs ?? 0) <= now;
  });
}
