// Cost math (#153), pure: totals of a report, the monthly estimate of a group, the unit prices an allocation implies
// and the savings a right-sizing recommendation would bring. Every derived number is an estimate from what OpenCost
// (or Kubecost) reported for the period; the views label them so.
import type { CostAggregate, CostRow, CostWindow, KindRef, ObjectRef } from "../../api";
import { rowWaste, type RightsizingRow } from "../rightsizing/group";

/** Hours in a month as the estimates count it: 30 days. */
export const MONTH_HOURS = 30 * 24;
export const GIB = 2 ** 30;

export const WINDOW_HOURS: Record<CostWindow, number> = { day: 24, week: 168, month: 720 };

/** The API's names of the special groups. */
export const IDLE = "__idle__";
export const UNALLOCATED = "__unallocated__";
export const UNMOUNTED = "__unmounted__";

export type CostPart = "cpu" | "memory" | "storage" | "network" | "gpu" | "other";
export const PARTS: CostPart[] = ["cpu", "memory", "storage", "network", "gpu", "other"];

export function partCost(row: CostRow, part: CostPart): number {
  switch (part) {
    case "cpu":
      return row.cpuCost;
    case "memory":
      return row.ramCost;
    case "storage":
      return row.pvCost;
    case "network":
      return row.networkCost;
    case "gpu":
      return row.gpuCost;
    case "other":
      return row.otherCost;
  }
}

export interface CostTotals {
  /** Per part, over the rows (the idle cost is not in them). */
  parts: Record<CostPart, number>;
  /** The rows' total. */
  allocated: number;
  idle: number;
  /** Allocated and idle. */
  total: number;
}

export function totalsOf(rows: readonly CostRow[], idle: CostRow | null): CostTotals {
  const parts = Object.fromEntries(PARTS.map((p) => [p, 0])) as Record<CostPart, number>;
  let allocated = 0;
  for (const row of rows) {
    for (const p of PARTS) parts[p] += partCost(row, p);
    allocated += row.totalCost;
  }
  const idleCost = idle?.totalCost ?? 0;
  return { parts, allocated, idle: idleCost, total: allocated + idleCost };
}

/** The parts worth a column: CPU, memory, storage and network always, GPU and other only when some row has them. */
export function shownParts(totals: CostTotals): CostPart[] {
  return PARTS.filter((p) => (p === "gpu" || p === "other" ? totals.parts[p] > 0 : true));
}

/**
 * Hours the group's costs cover: the minutes it ran when the API says (a workload started inside the period), at
 * least one hour and at most the period; otherwise the whole period.
 */
export function coveredHours(row: CostRow, window: CostWindow): number {
  const period = WINDOW_HOURS[window];
  if (!(row.minutes > 0)) return period;
  return Math.min(period, Math.max(1, row.minutes / 60));
}

/** The group's cost over the period scaled to 30 days (an estimate: it assumes the period's rate goes on). */
export function monthlyEstimate(row: CostRow, window: CostWindow): number {
  return (row.totalCost / coveredHours(row, window)) * MONTH_HOURS;
}

export interface UnitPrices {
  /** Cost of one CPU core for one hour; `null` when the allocation has no core-hours. */
  cpuPerCoreHour: number | null;
  /** Cost of one GiB of memory for one hour; `null` when the allocation has no byte-hours. */
  ramPerGiBHour: number | null;
}

/** The unit prices an allocation implies: its CPU cost per core-hour and its memory cost per GiB-hour. */
export function unitPrices(row: CostRow): UnitPrices {
  return {
    cpuPerCoreHour: row.cpuCoreHours > 0 ? row.cpuCost / row.cpuCoreHours : null,
    ramPerGiBHour: row.ramByteHours > 0 ? row.ramCost / (row.ramByteHours / GIB) : null,
  };
}

/** Requests above the recommendation, over all replicas: CPU in millicores, memory in bytes. */
export interface Reduction {
  cpuMillicores: number;
  memoryBytes: number;
}

export interface Savings {
  cpu: number;
  memory: number;
  total: number;
}

/**
 * Monthly savings of lowering requests by `reduction` at `prices` — (current − recommended) × unit price × 30 days.
 * `null` when a reduced resource has no price to set it against.
 */
export function savingsEstimate(reduction: Reduction, prices: UnitPrices): Savings | null {
  const cpuCores = Math.max(0, reduction.cpuMillicores) / 1000;
  const memoryGiB = Math.max(0, reduction.memoryBytes) / GIB;
  if (cpuCores > 0 && prices.cpuPerCoreHour === null) return null;
  if (memoryGiB > 0 && prices.ramPerGiBHour === null) return null;
  const cpu = cpuCores * (prices.cpuPerCoreHour ?? 0) * MONTH_HOURS;
  const memory = memoryGiB * (prices.ramPerGiBHour ?? 0) * MONTH_HOURS;
  return { cpu, memory, total: cpu + memory };
}

/** The allocation of a workload in a report grouped by workload (`controllerKind` is lower case in the API). */
export function findWorkload(rows: readonly CostRow[], namespace: string, kind: string, name: string): CostRow | null {
  const k = kind.toLowerCase();
  return (
    rows.find(
      (r) =>
        r.namespace === namespace &&
        r.controller === name &&
        (r.controllerKind ?? "").toLowerCase() === k,
    ) ??
    rows.find((r) => r.name === `${namespace}/${k}:${name}`) ??
    null
  );
}

const KIND_REFS: Record<string, KindRef> = {
  deployment: { group: "apps", version: "v1", kind: "Deployment" },
  statefulset: { group: "apps", version: "v1", kind: "StatefulSet" },
  daemonset: { group: "apps", version: "v1", kind: "DaemonSet" },
  replicaset: { group: "apps", version: "v1", kind: "ReplicaSet" },
  job: { group: "batch", version: "v1", kind: "Job" },
  cronjob: { group: "batch", version: "v1", kind: "CronJob" },
  pod: { group: "", version: "v1", kind: "Pod" },
};
const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const NODE: KindRef = { group: "", version: "v1", kind: "Node" };
const NAMESPACE: KindRef = { group: "", version: "v1", kind: "Namespace" };

/** A controller kind as Kubernetes spells it (`deployment` → `Deployment`); unknown kinds as given. */
export function kindName(controllerKind: string | null): string {
  if (!controllerKind) return "";
  return KIND_REFS[controllerKind.toLowerCase()]?.kind ?? controllerKind;
}

/** The part of a group's name after its namespace (`shop/deployment:web` → `deployment:web`). */
function afterNamespace(row: CostRow): string {
  const ns = row.namespace;
  return ns && row.name.startsWith(`${ns}/`) ? row.name.slice(ns.length + 1) : row.name;
}

/** A workload's controller kind and name, from the properties or else from the group's name. */
function workloadOfRow(row: CostRow): { kind: string | null; name: string } {
  if (row.controller) return { kind: row.controllerKind, name: row.controller };
  const rest = afterNamespace(row);
  const colon = rest.indexOf(":");
  return colon > 0 ? { kind: rest.slice(0, colon), name: rest.slice(colon + 1) } : { kind: null, name: rest };
}

/** What a row is called in the table: the namespace, the workload (with its kind), the pod, the node, the value. */
export function rowLabel(row: CostRow, aggregate: CostAggregate): { kind: string | null; name: string } {
  switch (aggregate.type) {
    case "namespace":
      return { kind: null, name: row.namespace ?? row.name };
    case "workload": {
      const w = workloadOfRow(row);
      return { kind: w.kind ? kindName(w.kind) : null, name: w.name };
    }
    case "pod":
      return { kind: null, name: row.pod ?? afterNamespace(row) };
    case "node":
      return { kind: null, name: row.node ?? row.name };
    case "label": {
      // `key=value` or just the value, depending on the version.
      const eq = row.name.indexOf("=");
      return { kind: null, name: eq >= 0 ? row.name.slice(eq + 1) : row.name };
    }
  }
}

/** The object a row stands for, to open its details; `null` for labels and the special groups. */
export function rowObjectRef(row: CostRow, aggregate: CostAggregate): ObjectRef | null {
  if (isSpecial(row)) return null;
  const { name } = rowLabel(row, aggregate);
  if (!name) return null;
  switch (aggregate.type) {
    case "namespace":
      return { kind: NAMESPACE, namespace: null, name };
    case "node":
      return { kind: NODE, namespace: null, name };
    case "pod":
      return row.namespace ? { kind: POD, namespace: row.namespace, name } : null;
    case "workload": {
      const kind = KIND_REFS[(workloadOfRow(row).kind ?? "").toLowerCase()];
      return kind && row.namespace ? { kind, namespace: row.namespace, name } : null;
    }
    case "label":
      return null;
  }
}

/** Whether a row is one of the API's special groups (no single object behind it). */
export function isSpecial(row: CostRow): boolean {
  return row.name.endsWith(UNALLOCATED) || row.name.endsWith(UNMOUNTED);
}

/** Whether the aggregation shows a namespace column. */
export function hasNamespaceColumn(aggregate: CostAggregate): boolean {
  return aggregate.type === "workload" || aggregate.type === "pod";
}

/** A label key as the API accepts it (the backend checks it again). */
export function isLabelKey(key: string): boolean {
  return /^([a-z0-9.-]{1,253}\/)?[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/.test(key);
}

/** At most this many namespaces of the filter are sent (`MAX_FILTER_NAMESPACES` in the core). */
export const MAX_FILTER_NAMESPACES = 200;

/** The namespaces to send for a namespace filter: `null` for all (or none chosen), at most the cap. */
export function filterNamespaces(selected: readonly string[] | null): string[] | null {
  if (!selected || selected.length === 0) return null;
  return [...selected].sort().slice(0, MAX_FILTER_NAMESPACES);
}

/** The part of right-sizing rows that bears on costs: whether any has a recommendation, and the requests above it. */
export function reductionOf(rows: readonly RightsizingRow[]): { recommended: boolean; reduction: Reduction } {
  let recommended = false;
  const reduction: Reduction = { cpuMillicores: 0, memoryBytes: 0 };
  for (const row of rows) {
    if (!row.assessment.recommendation) continue;
    recommended = true;
    const waste = rowWaste(row);
    reduction.cpuMillicores += waste.cpu;
    reduction.memoryBytes += waste.memory;
  }
  return { recommended, reduction };
}
