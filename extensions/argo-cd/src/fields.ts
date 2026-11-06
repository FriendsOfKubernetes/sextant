// Reading fields of objects as the cluster sends them: anything may be missing or of another type.
import type { KindRef, KubeObject } from "@sextant/extension-sdk";

export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur = obj;
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

/** `apps/v1` + `Deployment` → the kind; `v1` is the core group. */
export function kindFromApiVersion(apiVersion: string, kind: string): KindRef {
  const slash = apiVersion.indexOf("/");
  return slash < 0
    ? { group: "", version: apiVersion, kind }
    : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1), kind };
}

/** `group/version` (or `version` for the core group). */
export const apiVersionOf = (kind: Pick<KindRef, "group" | "version">): string =>
  kind.group ? `${kind.group}/${kind.version}` : kind.version;

export type Tone = "ok" | "warning" | "error" | "neutral";

/** Kubernetes' pod status as `kubectl get pods` shows it (Sextant's `podStatus`). */
export function podStatus(pod: KubeObject): string {
  let reason = str(get(pod, "status", "reason")) ?? str(get(pod, "status", "phase")) ?? "Unknown";
  let initializing = false;
  const initStatuses = arr(get(pod, "status", "initContainerStatuses"));
  initStatuses.forEach((status, i) => {
    if (initializing) return;
    const terminated = get(status, "state", "terminated");
    const waiting = get(status, "state", "waiting");
    if (terminated && num(get(terminated, "exitCode")) === 0) return;
    initializing = true;
    if (terminated) {
      const r = str(get(terminated, "reason"));
      const signal = num(get(terminated, "signal"));
      reason = r ? `Init:${r}` : signal ? `Init:Signal:${signal}` : `Init:ExitCode:${num(get(terminated, "exitCode")) ?? 0}`;
    } else if (waiting && str(get(waiting, "reason")) && str(get(waiting, "reason")) !== "PodInitializing") {
      reason = `Init:${str(get(waiting, "reason"))}`;
    } else {
      reason = `Init:${i}/${initStatuses.length}`;
    }
  });
  if (!initializing) {
    let hasRunning = false;
    const statuses = arr(get(pod, "status", "containerStatuses"));
    for (let i = statuses.length - 1; i >= 0; i--) {
      const status = statuses[i];
      const waitingReason = str(get(status, "state", "waiting", "reason"));
      const terminated = get(status, "state", "terminated");
      if (waitingReason) reason = waitingReason;
      else if (terminated) {
        const r = str(get(terminated, "reason"));
        const signal = num(get(terminated, "signal"));
        reason = r ?? (signal ? `Signal:${signal}` : `ExitCode:${num(get(terminated, "exitCode")) ?? 0}`);
      } else if (get(status, "ready") === true && get(status, "state", "running")) hasRunning = true;
    }
    if (reason === "Completed" && hasRunning) reason = "Running";
  }
  if (pod.metadata?.deletionTimestamp) {
    reason = str(get(pod, "status", "reason")) === "NodeLost" ? "Unknown" : "Terminating";
  }
  return reason;
}

const GOOD = new Set(["Running", "Active", "Bound", "Available", "Ready", "True", "Complete"]);
const DONE = new Set(["Succeeded", "Completed", "Released", "Terminated"]);
const BAD = new Set(["Failed", "Error", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled", "Lost", "Evicted", "Unknown", "False"]);

/** Colour of a pod status word (Sextant's `statusTone`). */
export function statusTone(status: string): Tone {
  if (GOOD.has(status)) return "ok";
  if (DONE.has(status)) return "neutral";
  if (BAD.has(status) || status.startsWith("Init:Err") || status.startsWith("Init:Crash")) return "error";
  return "warning";
}

/** "ready/desired" of a ReplicaSet. */
export function readyOfDesired(obj: KubeObject): string {
  return `${num(get(obj, "status", "readyReplicas")) ?? 0}/${num(get(obj, "spec", "replicas")) ?? 0}`;
}

/** Types of the conditions whose status is "True", sorted. */
export function trueConditions(obj: KubeObject): string[] {
  return arr(get(obj, "status", "conditions"))
    .filter((c) => get(c, "status") === "True")
    .map((c) => str(get(c, "type")) ?? "")
    .filter(Boolean)
    .sort();
}
