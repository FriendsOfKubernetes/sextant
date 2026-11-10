// Karpenter (karpenter.sh v1, and v1beta1 where fields moved) as Sextant's former built-in autoscaling view read it
// (src/features/autoscaling/karpenter.ts and model.ts, ADR-0080), ported unchanged — pure, no DOM: which NodePool a
// NodeClaim belongs to, a NodePool's limits against what it has launched, its disruption settings, whether a NodeClaim
// launched, registered and initialized, and why Karpenter disrupts (or may not disrupt) it — drift, consolidation,
// emptiness, expiration — from conditions, annotations and events. `isProblem` is the built-in tables' "Only problems"
// filter, kept as the reference the manifest is tested against. A node's own Karpenter block stays in Sextant.
import type { KubeObject } from "@sextant/extension-sdk";
import { formatAmount, parseQuantity } from "./format";

/** The tone of a phrase or a status word, as Sextant's own views colour them. */
export type Tone = "success" | "warning" | "danger" | "muted" | "neutral";

export interface KindRef {
  group: string;
  version: string;
  kind: string;
}

export const KARPENTER_GROUP = "karpenter.sh";
export const NODE_POOL: KindRef = { group: KARPENTER_GROUP, version: "v1", kind: "NodePool" };
export const NODE_CLAIM: KindRef = { group: KARPENTER_GROUP, version: "v1", kind: "NodeClaim" };
export const EC2_NODE_CLASS: KindRef = { group: "karpenter.k8s.aws", version: "v1", kind: "EC2NodeClass" };
export const AKS_NODE_CLASS: KindRef = { group: "karpenter.azure.com", version: "v1beta1", kind: "AKSNodeClass" };
export const NODE: KindRef = { group: "", version: "v1", kind: "Node" };
export const EVENT: KindRef = { group: "", version: "v1", kind: "Event" };

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

// ---------- Untyped access, as Sextant's `status` helpers ----------

export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
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

// ---------- Phrases, conditions and events ----------

/** A text key and its values, with its tone (the built-in `Phrase`, keys as under `autoscaling:`). */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
  tone?: Tone;
}

export const phrase = (key: string, params?: Phrase["params"], tone?: Tone): Phrase =>
  params === undefined && tone === undefined ? { key } : { key, ...(params ? { params } : {}), ...(tone ? { tone } : {}) };

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

/** What the views need of an Event. */
export interface EventRow {
  uid: string;
  reason: string;
  message: string;
  type: string;
  /** The component that reported it ("karpenter", …). */
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

/** Events listed per table at most (the newest). */
export const MAX_EVENTS = 10;

/** Events newest first, at most `max`. */
export function newestEvents(rows: Iterable<EventRow>, max: number): EventRow[] {
  return [...rows].sort((a, b) => timeOf(b) - timeOf(a)).slice(0, max);
}

// ---------- Labels ----------

export const NODEPOOL_LABEL = "karpenter.sh/nodepool";
export const OLD_PROVISIONER_LABEL = "karpenter.sh/provisioner-name";
export const DO_NOT_DISRUPT = "karpenter.sh/do-not-disrupt";
export const CAPACITY_TYPE_LABEL = "karpenter.sh/capacity-type";
export const INSTANCE_TYPE_LABEL = "node.kubernetes.io/instance-type";
export const ZONE_LABEL = "topology.kubernetes.io/zone";

/** The NodePool a node or a NodeClaim belongs to, by its label. */
export function nodePoolOf(obj: KubeObject): string | undefined {
  const labels = record(obj.metadata?.labels);
  return str(labels[NODEPOOL_LABEL]) ?? str(labels[OLD_PROVISIONER_LABEL]);
}

// ---------- NodePool limits ----------

export interface LimitRow {
  resource: string;
  used?: string;
  limit: string;
  reached: boolean;
}

export function limitRows(pool: KubeObject): LimitRow[] {
  const used = record(get(pool, "status", "resources"));
  return Object.entries(record(get(pool, "spec", "limits"))).map(([resource, raw]) => {
    const limit = parseQuantity(raw);
    const now = parseQuantity(used[resource]);
    const row: LimitRow = {
      resource,
      limit: limit === undefined ? String(raw) : formatAmount(resource, limit),
      reached: limit !== undefined && now !== undefined && now >= limit,
    };
    if (now !== undefined) row.used = formatAmount(resource, now);
    return row;
  });
}

/** The Usage / limits column's text: `cpu 3920m/4, memory 16GiB/32GiB`. */
export function limitsText(pool: KubeObject): string {
  return limitRows(pool)
    .map((l) => `${l.resource} ${l.used ?? "0"}/${l.limit}`)
    .join(", ");
}

// ---------- Disruption settings ----------

/** A Go duration ("720h", "1h30m", "30s") in milliseconds; `undefined` for "Never" or text that does not parse. */
export function durationMs(text: string | undefined): number | undefined {
  if (!text || text === "Never") return undefined;
  const re = /(\d+(?:\.\d+)?)(h|ms|m|s)/g;
  let total = 0;
  let matched = "";
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
    matched += m[0];
  }
  return matched === text ? total : undefined;
}

export interface DisruptionSettings {
  consolidationPolicy?: string;
  consolidateAfter?: string;
  expireAfter?: string;
  /** Budgets as written: "10%", "0 (Drifted, during 0 9 * * mon-fri for 8h)". */
  budgets: { nodes: string; reasons: string[]; schedule?: string; duration?: string }[];
}

export function disruptionSettings(pool: KubeObject): DisruptionSettings {
  const d = get(pool, "spec", "disruption");
  const out: DisruptionSettings = {
    budgets: arr(get(d, "budgets")).map((b) => {
      const budget: DisruptionSettings["budgets"][number] = {
        nodes: str(get(b, "nodes")) ?? "10%",
        reasons: arr(get(b, "reasons")).map(String),
      };
      const schedule = str(get(b, "schedule"));
      const duration = str(get(b, "duration"));
      if (schedule) budget.schedule = schedule;
      if (duration) budget.duration = duration;
      return budget;
    }),
  };
  const policy = str(get(d, "consolidationPolicy"));
  const after = str(get(d, "consolidateAfter"));
  // v1 keeps expireAfter in the template; v1beta1 in `disruption`.
  const expire = str(get(pool, "spec", "template", "spec", "expireAfter")) ?? str(get(d, "expireAfter"));
  if (policy) out.consolidationPolicy = policy;
  if (after) out.consolidateAfter = after;
  if (expire) out.expireAfter = expire;
  return out;
}

// ---------- A NodeClaim's launch ----------

/** Why a NodeClaim has no working node yet: the first of Launched, Registered, Initialized that is not True. */
export function launchProblem(claim: KubeObject): Phrase | undefined {
  for (const [type, key] of [
    ["Launched", "karpenter.notLaunched"],
    ["Registered", "karpenter.notRegistered"],
    ["Initialized", "karpenter.notInitialized"],
  ] as const) {
    const c = conditionOf(claim, type);
    if (!c) return type === "Launched" ? phrase("karpenter.launching", undefined, "warning") : undefined;
    if (c.status !== "True") return phrase(key, { reason: c.reason ?? c.status }, c.status === "False" ? "danger" : "warning");
  }
  return undefined;
}

/** The NodeClaims' State column: the reason of the first launch step that is not done. */
export const claimState = (claim: KubeObject): string | undefined => launchProblem(claim)?.params?.reason as string | undefined;

// ---------- Disruption ----------

export type DisruptionCause = "drift" | "consolidation" | "emptiness" | "expiration" | "other";

/** What a disruption event or condition is about, by its words. */
export function causeOf(text: string): DisruptionCause {
  if (/drift/i.test(text)) return "drift";
  if (/empt/i.test(text)) return "emptiness";
  if (/underutili|consolidat/i.test(text)) return "consolidation";
  if (/expir/i.test(text)) return "expiration";
  return "other";
}

/**
 * Why Karpenter disrupts (or will not disrupt) a NodeClaim's node, as the built-in `disruptionOf` told it for a NodeClaim
 * (no node): conditions of the claim (Drifted, Consolidatable, Empty, Expired), the do-not-disrupt annotation, and when
 * it expires.
 */
export function disruptionOf(claim: KubeObject, pool: KubeObject | undefined): Phrase[] {
  const out: Phrase[] = [];
  const settings = pool ? disruptionSettings(pool) : undefined;
  if (claim.metadata?.deletionTimestamp) out.push(phrase("karpenter.terminating", undefined, "warning"));
  for (const c of conditionsOf(claim)) {
    if (c.status !== "True") continue;
    if (c.type === "Drifted") out.push(phrase("karpenter.drifted", { reason: c.reason ?? c.type }, "warning"));
    else if (c.type === "Consolidatable")
      out.push(phrase("karpenter.consolidatable", { policy: settings?.consolidationPolicy ?? "WhenEmptyOrUnderutilized" }, "neutral"));
    else if (c.type === "Empty") out.push(phrase("karpenter.empty", undefined, "neutral"));
    else if (c.type === "Expired") out.push(phrase("karpenter.expired", undefined, "warning"));
  }
  if (str(record(claim.metadata?.annotations)[DO_NOT_DISRUPT]) === "true") out.push(phrase("karpenter.doNotDisrupt", { annotation: DO_NOT_DISRUPT }, "neutral"));
  const expire = str(get(claim, "spec", "expireAfter")) ?? settings?.expireAfter;
  const ms = durationMs(expire);
  const created = Date.parse(str(claim.metadata?.creationTimestamp) ?? "");
  if (ms !== undefined && !Number.isNaN(created)) out.push(phrase("karpenter.expiresAt", { time: new Date(created + ms).toISOString() }, "neutral"));
  return out;
}

/** Karpenter's own events (by the component that reported them). */
export function isKarpenterEvent(e: EventRow): boolean {
  return /karpenter/i.test(e.source);
}

/** Karpenter's events about disruption (and older deprovisioning) — on nodes, NodeClaims and pods. */
export function isDisruptionEvent(e: EventRow): boolean {
  if (/^(Disruption|Deprovisioning|Unconsolidatable)/.test(e.reason)) return true;
  return isKarpenterEvent(e) && /disrupt|drift|expir|consolidat|empty/i.test(`${e.reason} ${e.message}`);
}

// ---------- Ready and "Only problems" ----------

/** The Ready condition's status, as the tables' Ready column, and its tone. */
export const readyOf = (o: KubeObject): string | undefined => conditionOf(o, "Ready")?.status;
export const readyTone = (value: string): Tone => (value === "True" ? "success" : value === "False" ? "danger" : "warning");

/** Whether a Karpenter object needs attention (the built-in tables' "Only problems": Ready False, or a reached limit). */
export function isProblem(o: KubeObject): boolean {
  const ready = conditionOf(o, "Ready");
  if (ready && ready.status === "False") return true;
  return limitRows(o).some((l) => l.reached);
}
