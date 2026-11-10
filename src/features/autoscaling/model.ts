// Shared vocabulary of the autoscaling insights: the kinds they read (HPA, KEDA, Karpenter, Cluster Autoscaler's
// status ConfigMap), conditions, events, and `Phrase` — an i18n key under `autoscaling:` with its values, so the pure
// engines (hpa.ts, scheduling.ts, keda.ts, karpenter.ts, clusterAutoscaler.ts) return texts without React or i18next.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import { formatNumber } from "../../i18n";
import { formatBytes, formatCpu, parseQuantity } from "../metrics/format";

const { arr, get, num, str } = status;

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const HPA = k("autoscaling", "v2", "HorizontalPodAutoscaler");
export const POD = k("", "v1", "Pod");
export const NODE = k("", "v1", "Node");
export const EVENT = k("", "v1", "Event");
export const CONFIG_MAP = k("", "v1", "ConfigMap");
export const PVC = k("", "v1", "PersistentVolumeClaim");
export const PV = k("", "v1", "PersistentVolume");
export const DEPLOYMENT = k("apps", "v1", "Deployment");
export const STATEFULSET = k("apps", "v1", "StatefulSet");
export const REPLICASET = k("apps", "v1", "ReplicaSet");

// KEDA's and Karpenter's kinds the built-in sections read (their own views are Sextant's own extensions
// `extensions/keda` and `extensions/karpenter`).
export const SCALED_OBJECT = k("keda.sh", "v1alpha1", "ScaledObject");
export const NODE_POOL = k("karpenter.sh", "v1", "NodePool");
export const NODE_CLAIM = k("karpenter.sh", "v1", "NodeClaim");

/** Workload kinds an HPA (or a KEDA ScaledObject) usually scales; their details get the "Autoscaling" section. */
export const SCALABLE_KINDS: readonly KindRef[] = [DEPLOYMENT, STATEFULSET, REPLICASET];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

/** An i18n key under `autoscaling:` and its values. */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
  tone?: Tone;
}

export const phrase = (key: string, params?: Phrase["params"], tone?: Tone): Phrase =>
  params === undefined && tone === undefined ? { key } : { key, ...(params ? { params } : {}), ...(tone ? { tone } : {}) };

// ---------- Conditions ----------

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export function conditionsOf(obj: unknown): Condition[] {
  return arr(get(obj, "status", "conditions")).flatMap((c) => {
    const type = str(get(c, "type"));
    if (!type) return [];
    const out: Condition = { type, status: str(get(c, "status")) ?? "Unknown" };
    const reason = str(get(c, "reason"));
    const message = str(get(c, "message"));
    const time = str(get(c, "lastTransitionTime"));
    if (reason) out.reason = reason;
    if (message) out.message = message;
    if (time) out.lastTransitionTime = time;
    return [out];
  });
}

export function conditionOf(obj: unknown, type: string): Condition | undefined {
  return conditionsOf(obj).find((c) => c.type === type);
}

// ---------- Events ----------

/** What the views need of an Event. */
export interface EventRow {
  uid: string;
  reason: string;
  message: string;
  type: string;
  /** The component that reported it ("horizontal-pod-autoscaler", "karpenter", "cluster-autoscaler"). */
  source: string;
  time?: string;
  count: number;
  involvedKind: string;
  involvedName: string;
}

export function eventRow(e: KubeObject): EventRow {
  const time =
    str(get(e, "lastTimestamp")) ??
    str(get(e, "series", "lastObservedTime")) ??
    str(get(e, "eventTime")) ??
    str(get(e, "firstTimestamp")) ??
    str(e.metadata?.creationTimestamp);
  const row: EventRow = {
    uid: str(e.metadata?.uid) ?? `${e.metadata?.namespace ?? ""}/${e.metadata?.name ?? ""}`,
    reason: str(get(e, "reason")) ?? "",
    message: str(get(e, "message")) ?? "",
    type: str(get(e, "type")) ?? "Normal",
    source: str(get(e, "source", "component")) ?? str(get(e, "reportingComponent")) ?? str(get(e, "reportingController")) ?? "",
    count: num(get(e, "count")) ?? num(get(e, "series", "count")) ?? 1,
    involvedKind: str(get(e, "involvedObject", "kind")) ?? "",
    involvedName: str(get(e, "involvedObject", "name")) ?? "",
  };
  if (time) row.time = time;
  return row;
}

function timeOf(row: EventRow): number {
  const t = row.time ? Date.parse(row.time) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Events newest first, at most `max`. */
export function newestEvents(rows: Iterable<EventRow>, max: number): EventRow[] {
  return [...rows].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, max);
}

// ---------- Quantities ----------

/** A quantity as a number in base units (cores, bytes, count); `undefined` if it does not parse. */
export function quantity(value: unknown): number | undefined {
  return parseQuantity(value);
}

/** A text of a quantity in the units people read for `resource`: cores or millicores for cpu, binary bytes for memory. */
export function formatAmount(resource: string, value: number): string {
  if (resource === "cpu") {
    // Whole cores as Kubernetes writes them ("4"), anything else in millicores ("3920m").
    const milli = Math.round(value * 1000);
    return milli % 1000 === 0 && milli > 0 ? String(milli / 1000) : formatCpu(milli);
  }
  if (resource === "memory" || resource.endsWith("storage")) return formatBytes(value);
  return formatNumber(value, Number.isInteger(value) ? 0 : 2);
}
