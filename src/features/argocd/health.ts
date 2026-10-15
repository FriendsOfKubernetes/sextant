// Health of the resources of an Application, computed from the live objects the way Argo CD's built-in checks do
// (gitops-engine `pkg/health`). Argo CD 3.x keeps per-resource health in its app tree, which only its API serves,
// not in `status.resources[].health` (`status.resourceHealthSource: appTree`), so Sextant computes it here for the
// kinds Argo CD has a built-in check for. Where the Application does carry a resource's health (Argo CD 2.x), that
// value is shown instead. No React here.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { ManagedResource } from "./model";

const { arr, get, num, record, str } = status;

export type HealthStatus = "Healthy" | "Progressing" | "Degraded" | "Suspended" | "Missing" | "Unknown";

export interface Health {
  status: HealthStatus;
  message?: string;
}

/** The kinds Argo CD has a built-in health check for that Sextant computes, in a fixed order (one live list each). */
export const HEALTH_KINDS: KindRef[] = [
  { group: "apps", version: "v1", kind: "Deployment" },
  { group: "apps", version: "v1", kind: "StatefulSet" },
  { group: "apps", version: "v1", kind: "DaemonSet" },
  { group: "apps", version: "v1", kind: "ReplicaSet" },
  { group: "", version: "v1", kind: "Pod" },
  { group: "batch", version: "v1", kind: "Job" },
  { group: "", version: "v1", kind: "PersistentVolumeClaim" },
  { group: "", version: "v1", kind: "Service" },
  { group: "networking.k8s.io", version: "v1", kind: "Ingress" },
];

const keyOf = (group: string, kind: string) => `${group}/${kind}`;
const CHECKS: Record<string, (obj: KubeObject) => Health> = {
  "apps/Deployment": deploymentHealth,
  "apps/StatefulSet": statefulSetHealth,
  "apps/DaemonSet": daemonSetHealth,
  "apps/ReplicaSet": replicaSetHealth,
  "/Pod": podHealth,
  "batch/Job": jobHealth,
  "/PersistentVolumeClaim": pvcHealth,
  "/Service": serviceHealth,
  "networking.k8s.io/Ingress": ingressHealth,
};

/** Whether Sextant computes the health of objects of this kind. */
export function hasHealthCheck(kind: Pick<KindRef, "group" | "kind">): boolean {
  return keyOf(kind.group, kind.kind) in CHECKS;
}

/**
 * Health of `obj` of `kind`: `Missing` when the object does not exist (`obj` undefined), `undefined` for a kind
 * without a built-in check (Argo CD shows no health for those either).
 */
export function resourceHealth(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject | undefined): Health | undefined {
  const check = CHECKS[keyOf(kind.group, kind.kind)];
  if (!check) return undefined;
  if (!obj) return { status: "Missing" };
  // Argo CD: an object being deleted (its finalizers still running) is progressing, whatever its kind.
  if (obj.metadata?.deletionTimestamp) return { status: "Progressing", message: "Pending deletion" };
  return check(obj);
}

/**
 * The managed resources whose health Sextant has to compute (the Application does not carry it and Argo CD has a
 * check for the kind), as the kinds to list with the namespaces to list them in. Sorted like `HEALTH_KINDS`.
 */
export function healthWatchKinds(resources: ManagedResource[]): { kind: KindRef; namespaces: string[] }[] {
  const wanted = new Map<string, Set<string>>();
  for (const r of resources) {
    if (r.health || !r.namespace || !hasHealthCheck(r)) continue;
    const key = keyOf(r.group, r.kind);
    const namespaces = wanted.get(key) ?? new Set<string>();
    namespaces.add(r.namespace);
    wanted.set(key, namespaces);
  }
  return HEALTH_KINDS.filter((k) => wanted.has(keyOf(k.group, k.kind))).map((kind) => ({
    kind,
    namespaces: [...wanted.get(keyOf(kind.group, kind.kind))!].sort(),
  }));
}

// ---------- The checks (gitops-engine pkg/health/health_*.go) ----------

const generation = (obj: KubeObject) => num(get(obj, "metadata", "generation")) ?? 0;
const observedGeneration = (obj: KubeObject) => num(get(obj, "status", "observedGeneration")) ?? 0;
/** `spec.replicas`, undefined when unset (the checks skip the comparison then, as Argo CD's do for a nil pointer). */
const specReplicas = (obj: KubeObject) => num(get(obj, "spec", "replicas"));
const statusCount = (obj: KubeObject, field: string) => num(get(obj, "status", field)) ?? 0;

function condition(obj: KubeObject, type: string): Record<string, unknown> | undefined {
  const found = arr(get(obj, "status", "conditions")).find((c) => str(get(c, "type")) === type);
  return found === undefined ? undefined : record(found);
}

function deploymentHealth(obj: KubeObject): Health {
  const name = obj.metadata?.name ?? "";
  if (get(obj, "spec", "paused") === true) return { status: "Suspended", message: "Deployment is paused" };
  if (generation(obj) > observedGeneration(obj)) {
    return {
      status: "Progressing",
      message: "Waiting for rollout to finish: observed deployment generation less than desired generation",
    };
  }
  const replicas = specReplicas(obj);
  const updated = statusCount(obj, "updatedReplicas");
  if (str(condition(obj, "Progressing")?.reason) === "ProgressDeadlineExceeded") {
    return {
      status: "Degraded",
      message: `Deployment "${name}" exceeded its progress deadline`,
    };
  }
  if (replicas !== undefined && updated < replicas) {
    return {
      status: "Progressing",
      message: `Waiting for rollout to finish: ${updated} out of ${replicas} new replicas have been updated...`,
    };
  }
  const total = statusCount(obj, "replicas");
  if (total > updated) {
    return {
      status: "Progressing",
      message: `Waiting for rollout to finish: ${total - updated} old replicas are pending termination...`,
    };
  }
  const available = statusCount(obj, "availableReplicas");
  if (available < updated) {
    return {
      status: "Progressing",
      message: `Waiting for rollout to finish: ${available} of ${updated} updated replicas are available...`,
    };
  }
  return { status: "Healthy" };
}

function statefulSetHealth(obj: KubeObject): Health {
  const observed = observedGeneration(obj);
  if (observed === 0 || generation(obj) > observed) {
    return {
      status: "Progressing",
      message: "Waiting for statefulset spec update to be observed...",
    };
  }
  const replicas = specReplicas(obj);
  const ready = statusCount(obj, "readyReplicas");
  if (replicas !== undefined && ready < replicas) {
    return {
      status: "Progressing",
      message: `Waiting for ${replicas - ready} pods to be ready...`,
    };
  }
  const strategy = str(get(obj, "spec", "updateStrategy", "type"));
  const partition = num(get(obj, "spec", "updateStrategy", "rollingUpdate", "partition"));
  if (strategy === "RollingUpdate" && replicas !== undefined && partition !== undefined) {
    const updated = statusCount(obj, "updatedReplicas");
    if (updated < replicas - partition) {
      return {
        status: "Progressing",
        message: `Waiting for partitioned roll out to finish: ${updated} out of ${replicas - partition} new pods have been updated...`,
      };
    }
    return {
      status: "Healthy",
      message: `partitioned roll out complete: ${updated} new pods have been updated...`,
    };
  }
  if (strategy === "OnDelete")
    return {
      status: "Healthy",
      message: `statefulset has ${ready} ready pods`,
    };
  const updateRevision = str(get(obj, "status", "updateRevision"));
  if (updateRevision !== str(get(obj, "status", "currentRevision"))) {
    return {
      status: "Progressing",
      message: `waiting for statefulset rolling update to complete ${statusCount(obj, "updatedReplicas")} pods at revision ${updateRevision ?? ""}...`,
    };
  }
  return { status: "Healthy" };
}

function daemonSetHealth(obj: KubeObject): Health {
  if (generation(obj) > observedGeneration(obj)) {
    return {
      status: "Progressing",
      message: "Waiting for rollout to finish: observed daemon set generation less than desired generation",
    };
  }
  if (str(get(obj, "spec", "updateStrategy", "type")) === "OnDelete") return { status: "Healthy" };
  const desired = statusCount(obj, "desiredNumberScheduled");
  const updated = statusCount(obj, "updatedNumberScheduled");
  if (updated < desired) {
    return {
      status: "Progressing",
      message: `Waiting for daemon set rollout to finish: ${updated} out of ${desired} new pods have been updated...`,
    };
  }
  const available = statusCount(obj, "numberAvailable");
  if (available < desired) {
    return {
      status: "Progressing",
      message: `Waiting for daemon set rollout to finish: ${available} of ${desired} updated pods are available...`,
    };
  }
  return { status: "Healthy" };
}

function replicaSetHealth(obj: KubeObject): Health {
  if (generation(obj) > observedGeneration(obj)) {
    return {
      status: "Progressing",
      message: "Waiting for rollout to finish: observed replica set generation less than desired generation",
    };
  }
  const failure = condition(obj, "ReplicaFailure");
  if (failure && str(failure.status) === "True") return { status: "Degraded", message: str(failure.message) };
  const replicas = specReplicas(obj);
  const available = statusCount(obj, "availableReplicas");
  if (replicas !== undefined && available < replicas) {
    return {
      status: "Progressing",
      message: `Waiting for rollout to finish: ${available} out of ${replicas} new replicas are available...`,
    };
  }
  return { status: "Healthy" };
}

function containerFailure(ctr: unknown): string | undefined {
  const terminated = get(ctr, "state", "terminated");
  if (!terminated) return undefined;
  const message = str(get(terminated, "message"));
  if (message) return message;
  if (str(get(terminated, "reason")) === "OOMKilled") return "OOMKilled";
  const exitCode = num(get(terminated, "exitCode"));
  if (exitCode) return `container "${str(get(ctr, "name")) ?? ""}" failed with exit code ${exitCode}`;
  return undefined;
}

function podHealth(obj: KubeObject): Health {
  // The API server defaults the restart policy to Always.
  const restartPolicy = str(get(obj, "spec", "restartPolicy")) ?? "Always";
  const message = str(get(obj, "status", "message")) || undefined;
  const containers = arr(get(obj, "status", "containerStatuses"));
  // Only for long-running pods: a hook pod (OnFailure, Never) waiting for its image is not failed yet.
  if (restartPolicy === "Always") {
    const waiting = containers
      .map((c) => get(c, "state", "waiting"))
      .filter((w) => {
        const reason = str(get(w, "reason")) ?? "";
        return w != null && (reason.startsWith("Err") || reason.endsWith("Error") || reason.endsWith("BackOff"));
      });
    if (waiting.length > 0) {
      return {
        status: "Degraded",
        message: waiting.map((w) => str(get(w, "message")) ?? "").join(", ") || undefined,
      };
    }
  }
  switch (str(get(obj, "status", "phase"))) {
    case "Pending":
      return { status: "Progressing", message };
    case "Succeeded":
      return { status: "Healthy", message };
    case "Failed": {
      if (message) return { status: "Degraded", message };
      const all = [...arr(get(obj, "status", "initContainerStatuses")), ...containers];
      return {
        status: "Degraded",
        message: all.map(containerFailure).find((m) => m !== undefined),
      };
    }
    case "Running":
      if (restartPolicy === "Always") {
        if (str(condition(obj, "Ready")?.status) === "True") return { status: "Healthy", message };
        if (containers.some((c) => get(c, "lastState", "terminated") != null)) return { status: "Degraded", message };
        return { status: "Progressing", message };
      }
      // A pod with a finite life (OnFailure, Never) is usually a hook: running is progressing, not healthy.
      return { status: "Progressing", message };
  }
  return { status: "Unknown", message };
}

function jobHealth(obj: KubeObject): Health {
  let failed = false;
  let complete = false;
  let suspended = false;
  let message: string | undefined;
  let failMessage: string | undefined;
  for (const c of arr(get(obj, "status", "conditions"))) {
    switch (str(get(c, "type"))) {
      case "Failed":
        failed = true;
        complete = true;
        failMessage = str(get(c, "message"));
        break;
      case "Complete":
        complete = true;
        message = str(get(c, "message"));
        break;
      case "Suspended":
        complete = true;
        message = str(get(c, "message"));
        if (str(get(c, "status")) === "True") suspended = true;
        break;
    }
  }
  if (!complete) return { status: "Progressing", message };
  if (failed) return { status: "Degraded", message: failMessage };
  if (suspended) return { status: "Suspended", message };
  return { status: "Healthy", message };
}

function pvcHealth(obj: KubeObject): Health {
  switch (str(get(obj, "status", "phase"))) {
    case "Lost":
      return { status: "Degraded" };
    case "Pending":
      return { status: "Progressing" };
    case "Bound":
      return { status: "Healthy" };
    default:
      return { status: "Unknown" };
  }
}

const hasLoadBalancerIngress = (obj: KubeObject) => arr(get(obj, "status", "loadBalancer", "ingress")).length > 0;

function serviceHealth(obj: KubeObject): Health {
  if (str(get(obj, "spec", "type")) === "LoadBalancer" && !hasLoadBalancerIngress(obj))
    return { status: "Progressing" };
  return { status: "Healthy" };
}

function ingressHealth(obj: KubeObject): Health {
  return { status: hasLoadBalancerIngress(obj) ? "Healthy" : "Progressing" };
}
