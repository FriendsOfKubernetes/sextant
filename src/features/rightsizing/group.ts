// From live pods and usage to right-sizing rows (#137), pure: one row per workload and container. A pod belongs to the
// workload that controls it (a ReplicaSet of a Deployment counts as the Deployment); a bare pod is its own workload.
// Requests and limits come from the newest running pod of the workload, for its containers and its native sidecars
// (init containers with `restartPolicy: Always`, which run as long as the pod). History of a pod that is still there
// counts only for the workload that owns it; a pod that is gone is matched to a workload by the exact names its
// controller gives pods, so a rollout inside the window does not lose the history.
import type { ContainerHistory, KubeObject, KindRef, ObjectRef, PodUsage, UsageHistory } from "../../api";
import { podResourceAmounts, type ContainerAmounts } from "../metrics/requests";
import { assess, type Assessment, type UsageStats } from "./recommend";

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Job" | "Pod";

export interface WorkloadRef {
  kind: WorkloadKind;
  namespace: string;
  name: string;
}

/** An OOMKill this recent counts as "recent". */
export const OOM_RECENT_MS = 7 * 24 * 3600 * 1000;

const KIND_REFS: Record<WorkloadKind, KindRef> = {
  Deployment: { group: "apps", version: "v1", kind: "Deployment" },
  StatefulSet: { group: "apps", version: "v1", kind: "StatefulSet" },
  DaemonSet: { group: "apps", version: "v1", kind: "DaemonSet" },
  ReplicaSet: { group: "apps", version: "v1", kind: "ReplicaSet" },
  Job: { group: "batch", version: "v1", kind: "Job" },
  Pod: { group: "", version: "v1", kind: "Pod" },
};

export function workloadObjectRef(w: WorkloadRef): ObjectRef {
  return { kind: KIND_REFS[w.kind], namespace: w.namespace, name: w.name };
}

export function workloadKey(w: WorkloadRef): string {
  return `${w.namespace}/${w.kind}/${w.name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The workload that controls `pod`; the pod itself when nothing known does. */
export function workloadOf(pod: KubeObject): WorkloadRef {
  const meta = pod.metadata ?? {};
  const namespace = meta.namespace ?? "";
  const name = meta.name ?? "";
  const owners = Array.isArray(meta.ownerReferences) ? meta.ownerReferences : [];
  const owner = owners.find((o) => isRecord(o) && o.controller === true) ?? owners[0];
  if (isRecord(owner)) {
    const kind = str(owner.kind);
    const ownerName = str(owner.name) ?? "";
    if (kind === "ReplicaSet") {
      const labels = isRecord(meta.labels) ? meta.labels : {};
      const hash = str(labels["pod-template-hash"]);
      if (hash && ownerName.endsWith(`-${hash}`))
        return { kind: "Deployment", namespace, name: ownerName.slice(0, -hash.length - 1) };
      return { kind: "ReplicaSet", namespace, name: ownerName };
    }
    if (kind === "StatefulSet" || kind === "DaemonSet" || kind === "Job") return { kind, namespace, name: ownerName };
  }
  return { kind: "Pod", namespace, name };
}

/**
 * What follows `<name>-` in the pod names of each controller (the same shapes as the core's history query). Generated
 * parts use Kubernetes' safe alphabet (no vowels, no 0, 1, 3), which also keeps out most pods of a CronJob
 * `<name>-<minutes>-<5>`.
 */
const POD_SUFFIX: Partial<Record<WorkloadKind, RegExp>> = {
  // pod-template-hash, then the ReplicaSet's 5 random characters
  Deployment: /^[bcdfghjklmnpqrstvwxz2456789]{6,10}-[bcdfghjklmnpqrstvwxz2456789]{5}$/,
  StatefulSet: /^[0-9]+$/,
  DaemonSet: /^[bcdfghjklmnpqrstvwxz2456789]{5}$/,
  ReplicaSet: /^[bcdfghjklmnpqrstvwxz2456789]{5}$/,
  Job: /^[bcdfghjklmnpqrstvwxz2456789]{5}$/,
};

/** Whether `pod` is a name the controller of `w` would give one of its pods. */
export function podNameMatches(w: WorkloadRef, pod: string): boolean {
  if (w.kind === "Pod") return pod === w.name;
  const suffix = POD_SUFFIX[w.kind];
  return !!suffix && pod.startsWith(`${w.name}-`) && suffix.test(pod.slice(w.name.length + 1));
}

/** Requests and limits of the containers and native sidecars of `pod`, by name. */
export function containerAmountsOf(pod: KubeObject): Map<string, ContainerAmounts> {
  const spec = isRecord(pod.spec) ? pod.spec : {};
  const sidecars = (Array.isArray(spec.initContainers) ? spec.initContainers : []).filter(
    (c) => isRecord(c) && c.restartPolicy === "Always",
  );
  const out = new Map(podResourceAmounts(pod).byContainer);
  for (const [name, amounts] of podResourceAmounts({ spec: { containers: sidecars } }).byContainer)
    if (!out.has(name)) out.set(name, amounts);
  return out;
}

function isLive(pod: KubeObject): boolean {
  const phase = isRecord(pod.status) ? str(pod.status.phase) : undefined;
  return phase !== "Succeeded" && phase !== "Failed" && !(pod.metadata && "deletionTimestamp" in pod.metadata && pod.metadata.deletionTimestamp);
}

function createdAt(pod: KubeObject): number {
  const value = str(pod.metadata?.creationTimestamp);
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Containers of `pod` that were OOMKilled within `OOM_RECENT_MS` of `now` (or are terminated by one now). */
export function oomKilledContainers(pod: KubeObject, now: number): Set<string> {
  const out = new Set<string>();
  const statuses = isRecord(pod.status) && Array.isArray(pod.status.containerStatuses) ? pod.status.containerStatuses : [];
  for (const s of statuses) {
    if (!isRecord(s)) continue;
    const name = str(s.name);
    if (!name) continue;
    for (const field of ["state", "lastState"]) {
      const state = s[field];
      const terminated = isRecord(state) && isRecord(state.terminated) ? state.terminated : undefined;
      if (!terminated || terminated.reason !== "OOMKilled") continue;
      const finished = Date.parse(str(terminated.finishedAt) ?? "");
      if (!Number.isFinite(finished) || now - finished <= OOM_RECENT_MS) out.add(name);
    }
  }
  return out;
}

export interface RightsizingRow {
  workload: WorkloadRef;
  container: string;
  /** Running (or starting) pods of the workload. */
  replicas: number;
  amounts: ContainerAmounts;
  oomKilled: boolean;
  usage?: UsageStats;
  assessment: Assessment;
}

/** Usage to set the rows against: Prometheus history, a metrics-server snapshot by `namespace/name`, or nothing. */
export type UsageSourceData =
  | { kind: "history"; history: UsageHistory }
  | { kind: "snapshot"; pods: Map<string, PodUsage> }
  | { kind: "none" };

interface Group {
  workload: WorkloadRef;
  pods: KubeObject[];
}

/** Live pods by workload, in namespace and name order. */
export function groupPods(pods: Iterable<KubeObject>): Group[] {
  const groups = new Map<string, Group>();
  for (const pod of pods) {
    if (!isLive(pod)) continue;
    const workload = workloadOf(pod);
    const key = workloadKey(workload);
    const group = groups.get(key) ?? { workload, pods: [] };
    group.pods.push(pod);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.workload.namespace.localeCompare(b.workload.namespace) ||
      a.workload.name.localeCompare(b.workload.name) ||
      a.workload.kind.localeCompare(b.workload.kind),
  );
}

interface HistoryAcc {
  cpuP95?: number;
  memoryMax?: number;
  throttledRatio?: number;
  firstSeen?: number;
}

const maxOf = (a: number | undefined, b: number | null): number | undefined =>
  b === null ? a : a === undefined ? b : Math.max(a, b);

/**
 * History per workload key and container: a pod among `groups` belongs to its workload; a pod Prometheus still sees
 * now but that is not among `groups` belongs to no one here (another workload's pod with a similar name); a pod that is
 * gone goes to the workload in its namespace whose generated pod names it matches (the longest workload name wins).
 */
export function historyByWorkload(groups: Group[], history: UsageHistory): Map<string, Map<string, HistoryAcc>> {
  const livePod = new Map<string, string>();
  const byNamespace = new Map<string, WorkloadRef[]>();
  for (const g of groups) {
    for (const p of g.pods) livePod.set(`${g.workload.namespace}/${p.metadata?.name ?? ""}`, workloadKey(g.workload));
    const list = byNamespace.get(g.workload.namespace) ?? [];
    list.push(g.workload);
    byNamespace.set(g.workload.namespace, list);
  }
  const out = new Map<string, Map<string, HistoryAcc>>();
  const ownerOf = (c: ContainerHistory): string | undefined => {
    const live = livePod.get(`${c.namespace}/${c.pod}`);
    if (live) return live;
    if (c.lastSeen !== null) return undefined;
    let best: WorkloadRef | undefined;
    for (const w of byNamespace.get(c.namespace) ?? [])
      if (w.kind !== "Pod" && podNameMatches(w, c.pod) && (!best || w.name.length > best.name.length)) best = w;
    return best && workloadKey(best);
  };
  for (const c of history.containers) {
    const key = ownerOf(c);
    if (!key) continue;
    const containers = out.get(key) ?? new Map<string, HistoryAcc>();
    const acc = containers.get(c.container) ?? {};
    acc.cpuP95 = maxOf(acc.cpuP95, c.cpuP95Millicores);
    acc.memoryMax = maxOf(acc.memoryMax, c.memoryMaxBytes);
    acc.throttledRatio = maxOf(acc.throttledRatio, c.throttledRatio);
    if (c.firstSeen !== null) acc.firstSeen = acc.firstSeen === undefined ? c.firstSeen : Math.min(acc.firstSeen, c.firstSeen);
    containers.set(c.container, acc);
    out.set(key, containers);
  }
  return out;
}

function snapshotOf(group: Group, container: string, pods: Map<string, PodUsage>): UsageStats | undefined {
  let cpuNow: number | undefined;
  let memoryNow: number | undefined;
  for (const pod of group.pods) {
    const usage = pods.get(`${pod.metadata?.namespace ?? ""}/${pod.metadata?.name ?? ""}`);
    const own = usage?.containers.find(([name]) => name === container)?.[1];
    if (!own) continue;
    cpuNow = Math.max(cpuNow ?? 0, own.cpuMillicores);
    memoryNow = Math.max(memoryNow ?? 0, own.memoryBytes);
  }
  return cpuNow === undefined && memoryNow === undefined ? undefined : { kind: "snapshot", cpuNow, memoryNow };
}

/** One row per workload and container of the live pods, assessed against `source`. `now` in milliseconds. */
export function buildRows(pods: Iterable<KubeObject>, source: UsageSourceData, now: number): RightsizingRow[] {
  const groups = groupPods(pods);
  const history = source.kind === "history" ? historyByWorkload(groups, source.history) : undefined;
  const rows: RightsizingRow[] = [];
  for (const group of groups) {
    const newest = group.pods.reduce((a, b) => (createdAt(b) > createdAt(a) ? b : a));
    const amounts = containerAmountsOf(newest);
    const oom = new Set<string>();
    for (const pod of group.pods) for (const name of oomKilledContainers(pod, now)) oom.add(name);
    const own = history?.get(workloadKey(group.workload));
    for (const [container, containerAmounts] of amounts) {
      let usage: UsageStats | undefined;
      if (source.kind === "history") {
        const acc = own?.get(container);
        if (acc) {
          const evaluatedAt = source.history.evaluatedAt;
          usage = {
            kind: "history",
            cpuP95: acc.cpuP95,
            memoryMax: acc.memoryMax,
            throttledRatio: acc.throttledRatio,
            // Unknown when Prometheus could not say; a container without a first sample has none in the window.
            coverageSecs: !source.history.coverageKnown
              ? undefined
              : acc.firstSeen === undefined
                ? 0
                : Math.max(0, evaluatedAt - acc.firstSeen),
            windowSecs: source.history.windowSecs,
          };
        }
      } else if (source.kind === "snapshot") {
        usage = snapshotOf(group, container, source.pods);
      }
      const oomKilled = oom.has(container);
      rows.push({
        workload: group.workload,
        container,
        replicas: group.pods.length,
        amounts: containerAmounts,
        oomKilled,
        usage,
        assessment: assess({ amounts: containerAmounts, usage, oomKilled }),
      });
    }
  }
  return rows;
}

/** Waste of a row over all its replicas. */
export function rowWaste(row: RightsizingRow): { cpu: number; memory: number } {
  const w = row.assessment.waste;
  return w ? { cpu: w.cpu * row.replicas, memory: w.memory * row.replicas } : { cpu: 0, memory: 0 };
}

export type SortBy = "cpuWaste" | "memoryWaste" | "name";

export interface NamespaceGroup {
  namespace: string;
  rows: RightsizingRow[];
  /** Over all replicas of the namespace's rows. */
  waste: { cpu: number; memory: number };
  requested: { cpu: number; memory: number };
  /** Rows with at least one risk flag. */
  atRisk: number;
}

function compareRows(by: SortBy) {
  return (a: RightsizingRow, b: RightsizingRow): number => {
    if (by !== "name") {
      const resource = by === "cpuWaste" ? "cpu" : "memory";
      const diff = rowWaste(b)[resource] - rowWaste(a)[resource];
      if (diff !== 0) return diff;
    }
    return (
      a.workload.name.localeCompare(b.workload.name) ||
      a.workload.kind.localeCompare(b.workload.kind) ||
      a.container.localeCompare(b.container)
    );
  };
}

/** Rows by namespace with the namespace's totals; namespaces and rows sorted by `by`. */
export function groupByNamespace(rows: RightsizingRow[], by: SortBy, isRisk: (row: RightsizingRow) => boolean): NamespaceGroup[] {
  const groups = new Map<string, NamespaceGroup>();
  for (const row of rows) {
    const ns = row.workload.namespace;
    const group = groups.get(ns) ?? {
      namespace: ns,
      rows: [],
      waste: { cpu: 0, memory: 0 },
      requested: { cpu: 0, memory: 0 },
      atRisk: 0,
    };
    const waste = rowWaste(row);
    group.rows.push(row);
    group.waste.cpu += waste.cpu;
    group.waste.memory += waste.memory;
    group.requested.cpu += (row.amounts.cpu.request ?? 0) * row.replicas;
    group.requested.memory += (row.amounts.memory.request ?? 0) * row.replicas;
    if (isRisk(row)) group.atRisk += 1;
    groups.set(ns, group);
  }
  const list = [...groups.values()];
  for (const g of list) g.rows.sort(compareRows(by));
  return list.sort((a, b) => {
    if (by !== "name") {
      const resource = by === "cpuWaste" ? "cpu" : "memory";
      const diff = b.waste[resource] - a.waste[resource];
      if (diff !== 0) return diff;
    }
    return a.namespace.localeCompare(b.namespace);
  });
}
