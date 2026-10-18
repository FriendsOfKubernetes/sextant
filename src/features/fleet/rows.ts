// What the overview keeps of each watched object: a few fields (a "row"), never the object itself, so a cluster with
// thousands of pods costs a few hundred kilobytes. Pure functions over objects, plus the order and the filters of
// the tables.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import { nodeAllocatable } from "../metrics/columns";
import { isActive, type Problem, type ProblemCategory } from "../problems/model";

const { arr, get, num, str } = status;

/**
 * A kind the overview keeps rows of and how one object becomes a row. The rows come from the problem watch of the
 * kind (`category`), so a kind is never watched twice.
 */
export interface RowKind<R> {
  /** Unique among the row kinds. */
  id: string;
  kind: KindRef;
  category: ProblemCategory;
  toRow(obj: KubeObject): R;
}

export interface NodeRow {
  ready: boolean;
  /** The kubelet version (`status.nodeInfo.kubeletVersion`). */
  version?: string;
  /** Allocatable CPU (millicores) and memory (bytes). */
  cpu?: number;
  memory?: number;
}

export interface PodRow {
  namespace: string;
  name: string;
  /** kubectl's STATUS ("Running", "CrashLoopBackOff", …). */
  status: string;
  ready: number;
  containers: number;
  restarts: number;
  node?: string;
  created?: string;
}

export interface WorkloadRow {
  kind: KindRef;
  namespace: string;
  name: string;
  ready: number;
  desired: number;
  created?: string;
}

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });
export const NODE = k("", "v1", "Node");
export const POD = k("", "v1", "Pod");
export const DEPLOYMENT = k("apps", "v1", "Deployment");
export const STATEFULSET = k("apps", "v1", "StatefulSet");
export const DAEMONSET = k("apps", "v1", "DaemonSet");

export function nodeRow(node: KubeObject): NodeRow {
  const ready = arr(get(node, "status", "conditions")).some(
    (c) => get(c, "type") === "Ready" && get(c, "status") === "True",
  );
  const alloc = nodeAllocatable(node);
  return { ready, version: str(get(node, "status", "nodeInfo", "kubeletVersion")), cpu: alloc.cpu, memory: alloc.memory };
}

export function podRow(pod: KubeObject): PodRow {
  const statuses = arr(get(pod, "status", "containerStatuses"));
  const containers = Math.max(statuses.length, arr(get(pod, "spec", "containers")).length);
  return {
    namespace: pod.metadata?.namespace ?? "",
    name: pod.metadata?.name ?? "",
    status: status.podStatus(pod),
    ready: statuses.filter((s) => get(s, "ready") === true).length,
    containers,
    restarts: status.podRestarts(pod),
    node: str(get(pod, "spec", "nodeName")),
    created: str(pod.metadata?.creationTimestamp),
  };
}

/** Ready and desired replicas: a DaemonSet counts the nodes it should run on. */
export function workloadRow(kind: KindRef, obj: KubeObject): WorkloadRow {
  const daemon = kind.kind === "DaemonSet";
  return {
    kind,
    namespace: obj.metadata?.namespace ?? "",
    name: obj.metadata?.name ?? "",
    ready: num(get(obj, "status", daemon ? "numberReady" : "readyReplicas")) ?? 0,
    desired: daemon
      ? (num(get(obj, "status", "desiredNumberScheduled")) ?? 0)
      : (num(get(obj, "spec", "replicas")) ?? 1),
    created: str(obj.metadata?.creationTimestamp),
  };
}

export const NODE_ROWS: RowKind<NodeRow> = { id: "nodes", kind: NODE, category: "nodes", toRow: nodeRow };
export const POD_ROWS: RowKind<PodRow> = { id: "pods", kind: POD, category: "pods", toRow: podRow };
export const WORKLOAD_ROWS: readonly RowKind<WorkloadRow>[] = [DEPLOYMENT, STATEFULSET, DAEMONSET].map((kind) => ({
  id: kind.kind,
  kind,
  category: "workloads" as const,
  toRow: (obj: KubeObject) => workloadRow(kind, obj),
}));

// ---------- Cluster health ----------

export interface NodeSummary {
  total: number;
  ready: number;
  /** Distinct kubelet versions, lowest first. */
  versions: string[];
  /** Allocatable over all nodes; `undefined` when no node says. */
  cpu?: number;
  memory?: number;
}

const byVersion = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

export function summarizeNodes(rows: Iterable<NodeRow>): NodeSummary {
  let total = 0;
  let ready = 0;
  let cpu: number | undefined;
  let memory: number | undefined;
  const versions = new Set<string>();
  for (const row of rows) {
    total++;
    if (row.ready) ready++;
    if (row.version) versions.add(row.version);
    if (row.cpu !== undefined) cpu = (cpu ?? 0) + row.cpu;
    if (row.memory !== undefined) memory = (memory ?? 0) + row.memory;
  }
  return { total, ready, versions: [...versions].sort(byVersion), cpu, memory };
}

/** Active problems by category, at `now`. */
export function countByCategory(problems: Iterable<Problem>, now: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of problems) {
    if (!isActive(p, now)) continue;
    counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  return counts;
}

// ---------- Tables ----------

/** How bad a pod status reads: crash loops and failures first, then anything not running, then the rest. */
export function podRank(row: PodRow): number {
  const tone = status.statusTone(row.status);
  if (tone === "danger") return 0;
  if (tone === "warning") return 1;
  if (row.ready < row.containers && row.status === "Running") return 1;
  return 2;
}

export function comparePods(a: PodRow, b: PodRow): number {
  return podRank(a) - podRank(b) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);
}

export function compareWorkloads(a: WorkloadRow, b: WorkloadRow): number {
  const behind = (w: WorkloadRow) => (w.ready < w.desired ? 0 : 1);
  return (
    behind(a) - behind(b) ||
    a.namespace.localeCompare(b.namespace) ||
    a.name.localeCompare(b.name) ||
    a.kind.kind.localeCompare(b.kind.kind)
  );
}

export interface EventRow {
  /** The problem's key: unique within the cluster. */
  key: string;
  namespace: string;
  /** The involved object (or the event itself). */
  object: Problem["object"];
  reason: string;
  message?: string;
  since?: string;
  /** For the order: when it happened (ms), else when Sextant saw it. */
  at: number;
}

/** The Warning events among `problems`, newest first, at most `limit`. */
export function eventRows(problems: Iterable<Problem>, limit: number): EventRow[] {
  const rows: EventRow[] = [];
  for (const p of problems) {
    if (p.category !== "events") continue;
    const since = p.since ? Date.parse(p.since) : Number.NaN;
    rows.push({
      key: p.key,
      namespace: p.object.namespace ?? "",
      object: p.object,
      reason: p.reason,
      message: p.message,
      since: p.since,
      at: Number.isNaN(since) ? p.firstSeen : since,
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, limit);
}

/** The first `limit` of `rows` that pass `keep`, and how many more pass it. */
export function capRows<R>(rows: readonly R[], keep: (row: R) => boolean, limit: number): { shown: R[]; more: number } {
  const shown: R[] = [];
  let more = 0;
  for (const row of rows) {
    if (!keep(row)) continue;
    if (shown.length < limit) shown.push(row);
    else more++;
  }
  return { shown, more };
}
