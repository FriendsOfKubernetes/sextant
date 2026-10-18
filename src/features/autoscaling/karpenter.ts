// Karpenter (karpenter.sh v1, and v1beta1 where fields moved) as the autoscaling views read it — pure, no React:
// which NodePool and NodeClaim a node belongs to, a NodePool's limits against what it has launched, whether a
// NodeClaim launched, registered and initialized, and why Karpenter disrupts (or may not disrupt) a node — drift,
// consolidation, emptiness, expiration — from conditions, taints, annotations and events.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { conditionOf, conditionsOf, formatAmount, phrase, quantity, type EventRow, type Phrase } from "./model";

const { arr, get, record, str } = status;

export const NODEPOOL_LABEL = "karpenter.sh/nodepool";
const OLD_PROVISIONER_LABEL = "karpenter.sh/provisioner-name";
export const DO_NOT_DISRUPT = "karpenter.sh/do-not-disrupt";
const DISRUPTED_TAINT = "karpenter.sh/disrupted";
const OLD_DISRUPTION_TAINT = "karpenter.sh/disruption";
export const CAPACITY_TYPE_LABEL = "karpenter.sh/capacity-type";
export const INSTANCE_TYPE_LABEL = "node.kubernetes.io/instance-type";
export const ZONE_LABEL = "topology.kubernetes.io/zone";

/** The NodePool a node or a NodeClaim belongs to, by its label. */
export function nodePoolOf(obj: KubeObject): string | undefined {
  const labels = record(obj.metadata?.labels);
  return str(labels[NODEPOOL_LABEL]) ?? str(labels[OLD_PROVISIONER_LABEL]);
}

export function isKarpenterNode(node: KubeObject): boolean {
  return nodePoolOf(node) !== undefined;
}

/** The NodeClaim of a node: by the node name it reports, or by the provider id. */
export function nodeClaimOf(node: KubeObject, claims: Iterable<KubeObject>): KubeObject | undefined {
  const name = node.metadata?.name;
  const provider = str(get(node, "spec", "providerID"));
  for (const claim of claims) {
    if (str(get(claim, "status", "nodeName")) === name) return claim;
    if (provider && str(get(claim, "status", "providerID")) === provider) return claim;
  }
  return undefined;
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
    const limit = quantity(raw);
    const now = quantity(used[resource]);
    const row: LimitRow = {
      resource,
      limit: limit === undefined ? String(raw) : formatAmount(resource, limit),
      reached: limit !== undefined && now !== undefined && now >= limit,
    };
    if (now !== undefined) row.used = formatAmount(resource, now);
    return row;
  });
}

/** The resources of a NodePool at or over their limit (it launches no more nodes). */
export function reachedLimits(pool: KubeObject): string[] {
  return limitRows(pool)
    .filter((r) => r.reached)
    .map((r) => r.resource);
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

// ---------- Disruption of a node ----------

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
 * Why Karpenter disrupts (or will not disrupt) a node: conditions of its NodeClaim (Drifted, Consolidatable, Empty,
 * Expired), the disruption taint, the do-not-disrupt annotation on the node or its pods' owner, and when it expires.
 */
export function disruptionOf(node: KubeObject | undefined, claim: KubeObject | undefined, pool: KubeObject | undefined): Phrase[] {
  const out: Phrase[] = [];
  const settings = pool ? disruptionSettings(pool) : undefined;
  const taints = arr(get(node, "spec", "taints"));
  if (taints.some((t) => str(get(t, "key")) === DISRUPTED_TAINT || (str(get(t, "key")) === OLD_DISRUPTION_TAINT && str(get(t, "value")) === "disrupting"))) {
    out.push(phrase("karpenter.disrupting", undefined, "warning"));
  }
  if (node?.metadata?.deletionTimestamp || claim?.metadata?.deletionTimestamp) out.push(phrase("karpenter.terminating", undefined, "warning"));
  for (const c of conditionsOf(claim)) {
    if (c.status !== "True") continue;
    if (c.type === "Drifted") out.push(phrase("karpenter.drifted", { reason: c.reason ?? c.type }, "warning"));
    else if (c.type === "Consolidatable")
      out.push(phrase("karpenter.consolidatable", { policy: settings?.consolidationPolicy ?? "WhenEmptyOrUnderutilized" }, "neutral"));
    else if (c.type === "Empty") out.push(phrase("karpenter.empty", undefined, "neutral"));
    else if (c.type === "Expired") out.push(phrase("karpenter.expired", undefined, "warning"));
  }
  const blocked = [node, claim].some((o) => str(record(o?.metadata?.annotations)[DO_NOT_DISRUPT]) === "true");
  if (blocked) out.push(phrase("karpenter.doNotDisrupt", { annotation: DO_NOT_DISRUPT }, "neutral"));
  const expire = str(get(claim, "spec", "expireAfter")) ?? settings?.expireAfter;
  const ms = durationMs(expire);
  const created = Date.parse(str(claim?.metadata?.creationTimestamp ?? node?.metadata?.creationTimestamp) ?? "");
  if (ms !== undefined && !Number.isNaN(created)) out.push(phrase("karpenter.expiresAt", { time: new Date(created + ms).toISOString() }, "neutral"));
  return out;
}

/** Karpenter's events about disruption (and older deprovisioning) — on nodes, NodeClaims and pods. */
export function isDisruptionEvent(e: EventRow): boolean {
  if (/^(Disruption|Deprovisioning|Unconsolidatable)/.test(e.reason)) return true;
  return isKarpenterEvent(e) && /disrupt|drift|expir|consolidat|empty/i.test(`${e.reason} ${e.message}`);
}

/** Karpenter's own events about a pod (nominations, its scheduling failures). */
export function isKarpenterEvent(e: EventRow): boolean {
  return /karpenter/i.test(e.source);
}

/** The NodeClaims (and nodes) Karpenter nominated a pod for: "Pod should schedule on: nodeclaim/default-x, node/y". */
export function nominationsOf(events: Iterable<EventRow>): { claims: string[]; nodes: string[] } {
  const claims = new Set<string>();
  const nodes = new Set<string>();
  for (const e of events) {
    if (e.reason !== "Nominated" || !isKarpenterEvent(e)) continue;
    for (const m of e.message.matchAll(/nodeclaim\/([a-z0-9.-]+)/g)) claims.add(m[1]!);
    for (const m of e.message.matchAll(/(?<![a-z])node\/([a-z0-9.-]+)/g)) nodes.add(m[1]!);
  }
  return { claims: [...claims], nodes: [...nodes] };
}
