// Values derived from Kubernetes objects for table columns, computed the way kubectl / Lens show them.
import type { KubeObject } from "../api";

/** Untyped access into a JSON object: `get(obj, "status", "phase")`. */
export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function labelsOf(obj: KubeObject): Record<string, string> {
  return record(obj.metadata?.labels) as Record<string, string>;
}

/** `key=value` strings of the labels. */
export function labelPairs(obj: KubeObject): string[] {
  return Object.entries(labelsOf(obj)).map(([k, v]) => `${k}=${v}`);
}

export function createdAt(obj: KubeObject): number | undefined {
  const ts = str(obj.metadata?.creationTimestamp);
  if (!ts) return undefined;
  const time = Date.parse(ts);
  return Number.isNaN(time) ? undefined : time;
}

// ---------- Pods ----------

export interface ContainerState {
  name: string;
  /** running | waiting | terminated | unknown */
  state: "running" | "waiting" | "terminated" | "unknown";
  ready: boolean;
  /** Waiting/terminated reason, e.g. "CrashLoopBackOff", "Completed". */
  reason?: string;
  init: boolean;
}

/** State of every container (init containers first), as the "Containers" column shows them. */
export function containerStates(pod: KubeObject): ContainerState[] {
  const describe = (status: unknown, init: boolean): ContainerState => {
    const state = record(get(status, "state"));
    const name = str(get(status, "name")) ?? "";
    const ready = get(status, "ready") === true;
    if (state.running) return { name, state: "running", ready, init };
    if (state.waiting) return { name, state: "waiting", ready, init, reason: str(get(state.waiting, "reason")) };
    if (state.terminated)
      return { name, state: "terminated", ready, init, reason: str(get(state.terminated, "reason")) };
    return { name, state: "unknown", ready, init };
  };
  const init = arr(get(pod, "status", "initContainerStatuses")).map((s) => describe(s, true));
  const main = arr(get(pod, "status", "containerStatuses")).map((s) => describe(s, false));
  if (main.length > 0 || init.length > 0) return [...init, ...main];
  // No statuses yet (pending): the spec's containers, state unknown.
  return arr(get(pod, "spec", "containers")).map((c) => ({
    name: str(get(c, "name")) ?? "",
    state: "unknown" as const,
    ready: false,
    init: false,
  }));
}

export function podRestarts(pod: KubeObject): number {
  return arr(get(pod, "status", "containerStatuses")).reduce<number>(
    (sum, s) => sum + (num(get(s, "restartCount")) ?? 0),
    0,
  );
}

/** "Running", "Pending", "CrashLoopBackOff", "Init:0/1", "Completed", "Terminating", … (kubectl's STATUS). */
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

export type Tone = "success" | "warning" | "danger" | "muted" | "neutral";

const GOOD = new Set(["Running", "Active", "Bound", "Available", "Ready", "True", "Complete", "deployed"]);
const DONE = new Set(["Succeeded", "Completed", "Released", "Terminated"]);
const BAD = new Set([
  "Failed",
  "Error",
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "OOMKilled",
  "Lost",
  "Evicted",
  "Unknown",
  "False",
  "failed",
]);

/** Color of a status word. */
export function statusTone(status: string): Tone {
  if (GOOD.has(status)) return "success";
  if (DONE.has(status)) return "muted";
  if (BAD.has(status) || status.startsWith("Init:Err") || status.startsWith("Init:Crash")) return "danger";
  return "warning";
}

/**
 * Order of tones in a cell that shows several statuses: problems first, then warnings, then neutral, healthy and
 * finished ones.
 */
const TONE_RANK: Record<Tone, number> = { danger: 0, warning: 1, neutral: 2, success: 3, muted: 4 };

const statusCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * `items` in one fixed order whatever order the API reported them in: by tone (`TONE_RANK`: problems first), then by
 * text (natural, case-insensitive). Two objects with the same set of statuses show them the same way. Not for lists
 * whose order means something (containers in spec order, a condition timeline).
 */
export function sortStatusesBy<T>(items: readonly T[], tone: (item: T) => Tone, text: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, rank: TONE_RANK[tone(item)], text: text(item) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        statusCollator.compare(a.text, b.text) ||
        (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
    )
    .map((entry) => entry.item);
}

/** Status words in the fixed order of {@link sortStatusesBy}; `tone` colors them (default {@link statusTone}). */
export function sortStatuses(values: readonly string[], tone: (value: string) => Tone = statusTone): string[] {
  return sortStatusesBy(values, tone, (v) => v);
}

export interface OwnerRef {
  apiVersion: string;
  kind: string;
  name: string;
}

/** The controller among the owner references (or the first owner). */
export function controllerOf(obj: KubeObject): OwnerRef | undefined {
  const owners = arr(obj.metadata?.ownerReferences);
  const owner = owners.find((o) => get(o, "controller") === true) ?? owners[0];
  if (!owner) return undefined;
  const kind = str(get(owner, "kind"));
  const name = str(get(owner, "name"));
  const apiVersion = str(get(owner, "apiVersion"));
  return kind && name && apiVersion ? { apiVersion, kind, name } : undefined;
}

// ---------- Workloads ----------

/** "ready/desired" of a Deployment/StatefulSet/ReplicaSet. */
export function readyOfDesired(obj: KubeObject): string {
  const desired = num(get(obj, "spec", "replicas")) ?? 0;
  const ready = num(get(obj, "status", "readyReplicas")) ?? 0;
  return `${ready}/${desired}`;
}

/** Types of the conditions whose status is "True", e.g. ["Available", "Progressing"]. */
export function trueConditions(obj: KubeObject): string[] {
  return arr(get(obj, "status", "conditions"))
    .filter((c) => get(c, "status") === "True")
    .map((c) => str(get(c, "type")) ?? "")
    .filter(Boolean);
}

// ---------- Nodes ----------

export function nodeRoles(node: KubeObject): string[] {
  const roles = Object.keys(labelsOf(node))
    .filter((k) => k.startsWith("node-role.kubernetes.io/"))
    .map((k) => k.slice("node-role.kubernetes.io/".length))
    .filter(Boolean);
  const role = labelsOf(node)["kubernetes.io/role"];
  if (role && !roles.includes(role)) roles.push(role);
  return roles;
}

/** Color of a node condition word of {@link nodeConditions}. */
export function nodeConditionTone(condition: string): Tone {
  if (condition === "Ready") return "success";
  return condition === "SchedulingDisabled" ? "warning" : "danger";
}

/**
 * Node conditions as Lens shows them: "Ready" or "NotReady", plus problem conditions that are true (in API order;
 * the table cell orders them with {@link sortStatuses} and {@link nodeConditionTone}).
 */
export function nodeConditions(node: KubeObject): string[] {
  const conditions = arr(get(node, "status", "conditions"));
  const ready = conditions.find((c) => get(c, "type") === "Ready");
  const result = [get(ready, "status") === "True" ? "Ready" : "NotReady"];
  for (const c of conditions) {
    const type = str(get(c, "type"));
    if (type && type !== "Ready" && get(c, "status") === "True") result.push(type);
  }
  if (get(node, "spec", "unschedulable") === true) result.push("SchedulingDisabled");
  return result;
}

// ---------- Services ----------

/** "80:30080/TCP, 443/TCP". */
export function servicePorts(svc: KubeObject): string {
  return arr(get(svc, "spec", "ports"))
    .map((p) => {
      const port = num(get(p, "port"));
      const nodePort = num(get(p, "nodePort"));
      const protocol = str(get(p, "protocol")) ?? "TCP";
      return `${port}${nodePort ? `:${nodePort}` : ""}/${protocol}`;
    })
    .join(", ");
}

export function externalIps(svc: KubeObject): string {
  const ingress = arr(get(svc, "status", "loadBalancer", "ingress")).map(
    (i) => str(get(i, "ip")) ?? str(get(i, "hostname")) ?? "",
  );
  const external = arr(get(svc, "spec", "externalIPs")).map((i) => str(i) ?? "");
  return [...ingress, ...external].filter(Boolean).join(", ");
}

export function selectorText(selector: unknown): string {
  return Object.entries(record(selector))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
}

/** Size of a quantity map field, e.g. a ConfigMap's data keys. */
export function keyCount(...fields: unknown[]): string[] {
  return fields.flatMap((f) => Object.keys(record(f)));
}
