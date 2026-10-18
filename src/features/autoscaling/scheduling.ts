// Why a Pending pod has no node — pure, no React. Two views of the same question:
//
//  1. The scheduler's own message ("0/5 nodes are available: 2 Insufficient cpu, 3 node(s) had untolerated taint
//     {node-role.kubernetes.io/control-plane: }. preemption: …") parsed into reasons with node counts. Cluster
//     Autoscaler's NotTriggerScaleUp lists ("2 max node group size reached") use the same shape.
//  2. A local check of the pod against the watched nodes, filter by filter as the default scheduler runs them:
//     cordoned nodes, nodeSelector and required node affinity (matchExpressions, matchFields), taints the pod does not
//     tolerate (NoSchedule, NoExecute), resources (allocatable minus the requests of the pods bound to the node),
//     required pod (anti-)affinity and DoNotSchedule topology spread in the pod's namespace (when its pods are known),
//     and the node affinity of bound PersistentVolumes (when visible). Bounded to `MAX_NODES` nodes.
//
// What it does not check is said in the result (`unchecked`): the anti-affinity of other pods against this one, host
// ports, volume limits, a namespaceSelector of an affinity term (namespace labels are not watched), and DRA claims.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { labelSelector, matches, type Labels, type Selector } from "../resource-map/selectors";
import { formatAmount, phrase, quantity, type Phrase } from "./model";

const { arr, get, num, record, str } = status;

/** Nodes the local check looks at, at most. */
export const MAX_NODES = 200;

// ---------- The scheduler's message ----------

export type ReasonCode =
  | "insufficient"
  | "taint"
  | "unschedulable"
  | "notReady"
  | "nodeAffinity"
  | "podAffinity"
  | "podAntiAffinity"
  | "existingAntiAffinity"
  | "topologySpread"
  | "volumeAffinity"
  | "volumeBinding"
  | "volumeZone"
  | "volumeCount"
  | "unboundPvc"
  | "ports"
  | "noNodes"
  | "maxGroupSize"
  | "backoff"
  | "clusterLimit"
  | "other";

export interface MessageReason {
  /** Nodes (or node groups) the reason applies to; `undefined` for a pod-level reason. */
  count?: number;
  code: ReasonCode;
  /** The resource, the taint, or the raw text of an unknown reason. */
  detail?: string;
  /** The reason as the cluster wrote it. */
  text: string;
}

export interface SchedulerMessage {
  total?: number;
  available?: number;
  reasons: MessageReason[];
  /** The preemption part, as written. */
  preemption?: string;
}

function classify(text: string): Omit<MessageReason, "count" | "text"> {
  const insufficient = /^Insufficient (\S+)/.exec(text);
  if (insufficient) return { code: "insufficient", detail: insufficient[1]! };
  if (/^Too many pods/i.test(text)) return { code: "insufficient", detail: "pods" };
  const taint = /taint(?:\(s\))?\s*\{([^}]*)\}/.exec(text);
  if (/taint/.test(text)) {
    const key = taint?.[1]?.split(":")[0]?.trim() ?? "";
    if (key === "node.kubernetes.io/unschedulable") return { code: "unschedulable" };
    if (key === "node.kubernetes.io/not-ready" || key === "node.kubernetes.io/unreachable") return { code: "notReady", detail: taint![1]! };
    return taint ? { code: "taint", detail: taint[1]!.trim() } : { code: "taint" };
  }
  if (/were unschedulable/.test(text)) return { code: "unschedulable" };
  if (/node affinity\/selector|node\(s\) didn't match Pod's node affinity/.test(text)) return { code: "nodeAffinity" };
  if (/didn't satisfy existing pods anti-affinity/.test(text)) return { code: "existingAntiAffinity" };
  if (/didn't match pod anti-affinity/.test(text)) return { code: "podAntiAffinity" };
  if (/didn't match pod affinity/.test(text)) return { code: "podAffinity" };
  if (/topology spread constraints/.test(text)) return { code: "topologySpread" };
  if (/volume node affinity conflict/.test(text)) return { code: "volumeAffinity" };
  if (/available persistent volumes to bind/.test(text)) return { code: "volumeBinding" };
  if (/no available volume zone/.test(text)) return { code: "volumeZone" };
  if (/max volume count/.test(text)) return { code: "volumeCount" };
  if (/unbound immediate PersistentVolumeClaims/.test(text)) return { code: "unboundPvc" };
  if (/free ports/.test(text)) return { code: "ports" };
  if (/were not ready|not-ready/.test(text)) return { code: "notReady" };
  if (/max node group size reached/.test(text)) return { code: "maxGroupSize" };
  if (/in backoff after failed scale-up/.test(text)) return { code: "backoff" };
  if (/max cluster \S+ limit reached|cluster-wide limit|max total nodes in cluster reached/.test(text)) return { code: "clusterLimit" };
  return { code: "other", detail: text };
}

/** A comma-separated list of "<count> <reason>" parts (the scheduler's and Cluster Autoscaler's). */
export function parseReasonList(body: string): MessageReason[] {
  const trimmed = body.trim().replace(/\.$/, "");
  if (!trimmed) return [];
  return trimmed
    .split(/,\s+(?=\d+\s)/)
    .flatMap((part) => part.split(/\.\s+(?=\d+\s)/))
    .map((part) => {
      const m = /^(\d+)\s+(.*)$/s.exec(part.trim());
      const text = (m ? m[2]! : part).trim().replace(/\.$/, "");
      const reason: MessageReason = { ...classify(text), text };
      if (m) reason.count = Number(m[1]);
      return reason;
    });
}

/** The scheduler's FailedScheduling / Unschedulable message, parsed; `undefined` for a message of another shape. */
export function parseSchedulerMessage(message: string | undefined): SchedulerMessage | undefined {
  if (!message) return undefined;
  if (/^no nodes available to schedule pods/i.test(message.trim())) {
    return { reasons: [{ code: "noNodes", text: message.trim() }] };
  }
  const head = /(\d+)\/(\d+) nodes are available:?\s*/.exec(message);
  if (!head) return undefined;
  let body = message.slice(head.index + head[0].length);
  let preemption: string | undefined;
  const cut = body.search(/\s*preemption:\s*/);
  if (cut >= 0) {
    preemption = body.slice(cut).replace(/^\s*preemption:\s*/, "").trim();
    body = body.slice(0, cut);
  }
  const out: SchedulerMessage = { available: Number(head[1]), total: Number(head[2]), reasons: parseReasonList(body) };
  if (preemption) out.preemption = preemption;
  return out;
}

// ---------- Pods, nodes and their amounts ----------

/** Amounts by resource name, in base units (cores, bytes, count). */
export type Amounts = Record<string, number>;

function add(into: Amounts, from: Amounts): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

function containerRequests(c: unknown): Amounts {
  const out: Amounts = {};
  // A limit without a request is the request (the API server defaults it; extended resources only have limits).
  for (const [k, v] of Object.entries(record(get(c, "resources", "limits")))) {
    const n = quantity(v);
    if (n !== undefined) out[k] = n;
  }
  for (const [k, v] of Object.entries(record(get(c, "resources", "requests")))) {
    const n = quantity(v);
    if (n !== undefined) out[k] = n;
  }
  return out;
}

/**
 * What a pod asks of a node, as the scheduler sums it: its containers and restartable init containers (sidecars),
 * or the largest regular init container with the sidecars started before it, whichever is more; plus the pod
 * overhead, plus one pod.
 */
export function podRequests(pod: unknown): Amounts {
  const running: Amounts = {};
  for (const c of arr(get(pod, "spec", "containers"))) add(running, containerRequests(c));
  const sidecars: Amounts = {};
  const peak: Amounts = {};
  for (const c of arr(get(pod, "spec", "initContainers"))) {
    const req = containerRequests(c);
    if (str(get(c, "restartPolicy")) === "Always") {
      add(sidecars, req);
      continue;
    }
    for (const key of new Set([...Object.keys(req), ...Object.keys(sidecars)])) {
      peak[key] = Math.max(peak[key] ?? 0, (req[key] ?? 0) + (sidecars[key] ?? 0));
    }
  }
  add(running, sidecars);
  const out: Amounts = {};
  for (const key of new Set([...Object.keys(running), ...Object.keys(peak)])) {
    out[key] = Math.max(running[key] ?? 0, peak[key] ?? 0);
  }
  for (const [k, v] of Object.entries(record(get(pod, "spec", "overhead")))) {
    const n = quantity(v);
    if (n !== undefined) out[k] = (out[k] ?? 0) + n;
  }
  out.pods = 1;
  return out;
}

export interface Taint {
  key: string;
  value?: string;
  effect: string;
}

/** What the local check needs of a node (a row of the shared node watch). */
export interface NodeRow {
  name: string;
  labels: Labels;
  taints: Taint[];
  unschedulable: boolean;
  allocatable: Amounts;
}

export function nodeRow(node: KubeObject): NodeRow {
  const allocatable: Amounts = {};
  for (const [k, v] of Object.entries(record(get(node, "status", "allocatable")))) {
    const n = quantity(v);
    if (n !== undefined) allocatable[k] = n;
  }
  return {
    name: node.metadata?.name ?? "",
    labels: Object.fromEntries(Object.entries(record(node.metadata?.labels)).map(([k, v]) => [k, String(v)])),
    taints: arr(get(node, "spec", "taints")).map((t) => {
      const taint: Taint = { key: str(get(t, "key")) ?? "", effect: str(get(t, "effect")) ?? "" };
      const value = str(get(t, "value"));
      if (value) taint.value = value;
      return taint;
    }),
    unschedulable: get(node, "spec", "unschedulable") === true,
    allocatable,
  };
}

/** A pod bound to a node and still holding its requests: the node and the requests. */
export interface BoundPodRow {
  node: string;
  requests: Amounts;
}

/** The row of a pod for the per-node sums; `null` for a pod that holds nothing (not bound, finished). */
export function boundPodRow(pod: KubeObject): BoundPodRow | null {
  const node = str(get(pod, "spec", "nodeName"));
  const phase = str(get(pod, "status", "phase"));
  if (!node || phase === "Succeeded" || phase === "Failed") return null;
  return { node, requests: podRequests(pod) };
}

/** Requests of the bound pods summed per node. */
export function usedByNode(rows: Iterable<BoundPodRow | null>): Map<string, Amounts> {
  const out = new Map<string, Amounts>();
  for (const row of rows) {
    if (!row) continue;
    const sum = out.get(row.node) ?? {};
    add(sum, row.requests);
    out.set(row.node, sum);
  }
  return out;
}

/** A pod of the pending pod's namespace, for pod affinity and topology spread. */
export interface PeerPod {
  name: string;
  node?: string;
  labels: Labels;
}

export function peerPod(pod: KubeObject): PeerPod | null {
  const phase = str(get(pod, "status", "phase"));
  if (phase === "Succeeded" || phase === "Failed" || pod.metadata?.deletionTimestamp) return null;
  const out: PeerPod = {
    name: pod.metadata?.name ?? "",
    labels: Object.fromEntries(Object.entries(record(pod.metadata?.labels)).map(([k, v]) => [k, String(v)])),
  };
  const node = str(get(pod, "spec", "nodeName"));
  if (node) out.node = node;
  return out;
}

// ---------- Filters ----------

interface Toleration {
  key: string;
  operator: string;
  value: string;
  effect: string;
}

function tolerationsOf(pod: unknown): Toleration[] {
  return arr(get(pod, "spec", "tolerations")).map((t) => ({
    key: str(get(t, "key")) ?? "",
    operator: str(get(t, "operator")) ?? "Equal",
    value: str(get(t, "value")) ?? "",
    effect: str(get(t, "effect")) ?? "",
  }));
}

/** The API's ToleratesTaint. */
export function tolerates(t: Toleration, taint: Taint): boolean {
  if (t.effect !== "" && t.effect !== taint.effect) return false;
  if (t.key !== "" && t.key !== taint.key) return false;
  if (t.operator === "Exists") return true;
  if (t.key === "") return false;
  return t.value === (taint.value ?? "");
}

export function taintText(taint: Taint): string {
  return `${taint.key}${taint.value ? `=${taint.value}` : ""}:${taint.effect}`;
}

interface NodeRequirement {
  key: string;
  operator: string;
  values: string[];
}

function requirementsOf(value: unknown): NodeRequirement[] {
  return arr(value).map((e) => ({
    key: str(get(e, "key")) ?? "",
    operator: str(get(e, "operator")) ?? "",
    values: arr(get(e, "values")).map(String),
  }));
}

function nodeRequirementMatches(r: NodeRequirement, value: string | undefined): boolean {
  switch (r.operator) {
    case "In":
      return value !== undefined && r.values.includes(value);
    case "NotIn":
      return value === undefined || !r.values.includes(value);
    case "Exists":
      return value !== undefined;
    case "DoesNotExist":
      return value === undefined;
    case "Gt":
    case "Lt": {
      const n = Number.parseInt(value ?? "", 10);
      const bound = Number.parseInt(r.values[0] ?? "", 10);
      if (!Number.isFinite(n) || !Number.isFinite(bound)) return false;
      return r.operator === "Gt" ? n > bound : n < bound;
    }
    default:
      return false;
  }
}

/** A nodeSelectorTerm: every expression and field matches; an empty term matches nothing. */
export function termMatches(term: unknown, node: Pick<NodeRow, "name" | "labels">): boolean {
  const expressions = requirementsOf(get(term, "matchExpressions"));
  const fields = requirementsOf(get(term, "matchFields"));
  if (expressions.length === 0 && fields.length === 0) return false;
  return (
    expressions.every((r) => nodeRequirementMatches(r, node.labels[r.key])) &&
    fields.every((r) => r.key === "metadata.name" && nodeRequirementMatches(r, node.name))
  );
}

/** Required node affinity: one of the terms matches (no terms: every node). */
export function nodeSelectorMatches(selector: unknown, node: Pick<NodeRow, "name" | "labels">): boolean {
  const terms = arr(get(selector, "nodeSelectorTerms"));
  if (selector === undefined || selector === null) return true;
  return terms.some((t) => termMatches(t, node));
}

function nodeSelectorFits(pod: unknown, node: NodeRow): boolean {
  const selector = record(get(pod, "spec", "nodeSelector"));
  return Object.entries(selector).every(([k, v]) => node.labels[k] === String(v));
}

function nodeAffinityFits(pod: unknown, node: NodeRow): boolean {
  return nodeSelectorMatches(get(pod, "spec", "affinity", "nodeAffinity", "requiredDuringSchedulingIgnoredDuringExecution"), node);
}

function blockingTaints(pod: unknown, node: NodeRow): Taint[] {
  const tolerations = tolerationsOf(pod);
  return node.taints.filter(
    (taint) => (taint.effect === "NoSchedule" || taint.effect === "NoExecute") && !tolerations.some((t) => tolerates(t, taint)),
  );
}

const UNSCHEDULABLE_TAINT: Taint = { key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" };

// ---------- Pod affinity and topology spread ----------

interface AffinityTerm {
  selector: Selector;
  topologyKey: string;
}

/** The terms of `field` that can be judged from the pod's own namespace; `unchecked` when some cannot. */
function affinityTerms(pod: KubeObject, field: "podAffinity" | "podAntiAffinity"): { terms: AffinityTerm[]; unchecked: boolean } {
  const namespace = pod.metadata?.namespace ?? "";
  const labels = record(pod.metadata?.labels);
  let unchecked = false;
  const terms: AffinityTerm[] = [];
  for (const term of arr(get(pod, "spec", "affinity", field, "requiredDuringSchedulingIgnoredDuringExecution"))) {
    const namespaces = arr(get(term, "namespaces")).map(String);
    if (get(term, "namespaceSelector") || namespaces.some((n) => n !== namespace)) {
      unchecked = true;
      continue;
    }
    const raw = get(term, "labelSelector");
    let selector = raw === undefined || raw === null ? ({ type: "nothing" } as Selector) : labelSelector(raw);
    const keys = arr(get(term, "matchLabelKeys")).map(String);
    if (keys.length > 0 && selector.type !== "nothing") selector = withKeys(selector, keys, labels);
    terms.push({ selector, topologyKey: str(get(term, "topologyKey")) ?? "" });
  }
  return { terms, unchecked };
}

function withKeys(selector: Selector, keys: string[], labels: Record<string, unknown>): Selector {
  const extra = keys.filter((k) => labels[k] !== undefined).map((k) => ({ key: k, operator: "In", values: [String(labels[k])] }));
  if (extra.length === 0) return selector;
  if (selector.type === "everything") return { type: "terms", matchLabels: [], expressions: extra };
  if (selector.type === "nothing") return selector;
  return { ...selector, expressions: [...selector.expressions, ...extra] };
}

interface SpreadConstraint {
  maxSkew: number;
  topologyKey: string;
  selector: Selector;
  minDomains?: number;
  honorAffinity: boolean;
  honorTaints: boolean;
}

function spreadConstraints(pod: KubeObject): SpreadConstraint[] {
  const labels = record(pod.metadata?.labels);
  return arr(get(pod, "spec", "topologySpreadConstraints"))
    .filter((c) => str(get(c, "whenUnsatisfiable")) === "DoNotSchedule")
    .map((c) => {
      const raw = get(c, "labelSelector");
      let selector = raw === undefined || raw === null ? ({ type: "nothing" } as Selector) : labelSelector(raw);
      const keys = arr(get(c, "matchLabelKeys")).map(String);
      if (keys.length > 0) selector = withKeys(selector, keys, labels);
      const out: SpreadConstraint = {
        maxSkew: num(get(c, "maxSkew")) ?? 1,
        topologyKey: str(get(c, "topologyKey")) ?? "",
        selector,
        honorAffinity: str(get(c, "nodeAffinityPolicy")) !== "Ignore",
        honorTaints: str(get(c, "nodeTaintsPolicy")) === "Honor",
      };
      const min = num(get(c, "minDomains"));
      if (min !== undefined) out.minDomains = min;
      return out;
    });
}

/** Whether the local check needs the pods of the pod's namespace (pod affinity or topology spread). */
export function needsPeers(pod: KubeObject): boolean {
  return (
    spreadConstraints(pod).length > 0 ||
    arr(get(pod, "spec", "affinity", "podAffinity", "requiredDuringSchedulingIgnoredDuringExecution")).length > 0 ||
    arr(get(pod, "spec", "affinity", "podAntiAffinity", "requiredDuringSchedulingIgnoredDuringExecution")).length > 0
  );
}

// ---------- The check ----------

export interface VolumeAffinity {
  /** The PersistentVolume's name. */
  pv: string;
  /** `spec.nodeAffinity.required` of the PersistentVolume. */
  required: unknown;
}

export interface CheckInput {
  pod: KubeObject;
  nodes: readonly NodeRow[];
  /** Requests of the bound pods per node. */
  used: ReadonlyMap<string, Amounts>;
  /** Pods of the pod's namespace; `undefined` when not known (pod affinity and spread are then not checked). */
  peers?: readonly PeerPod[];
  volumes?: readonly VolumeAffinity[];
}

export interface NodeVerdict {
  node: string;
  fits: boolean;
  /** Why not, in the scheduler's order; one phrase per failed filter. */
  reasons: Phrase[];
  /** The code of the first failed filter. */
  first?: ReasonCode;
}

export interface CheckResult {
  requests: Amounts;
  verdicts: NodeVerdict[];
  /** Nodes in the cluster (the check looks at `MAX_NODES` at most). */
  total: number;
  /** Failed nodes by their first reason. */
  byReason: Map<ReasonCode, number>;
  /** What the check could not judge. */
  unchecked: Phrase[];
}

export function checkNodes(input: CheckInput): CheckResult {
  const { pod } = input;
  const requests = podRequests(pod);
  const tolerations = tolerationsOf(pod);
  const nodes = [...input.nodes].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_NODES);
  const byName = new Map(input.nodes.map((n) => [n.name, n]));
  const unchecked: Phrase[] = [];

  const affinity = affinityTerms(pod, "podAffinity");
  const anti = affinityTerms(pod, "podAntiAffinity");
  const spread = spreadConstraints(pod);
  const ownLabels = Object.fromEntries(Object.entries(record(pod.metadata?.labels)).map(([k, v]) => [k, String(v)]));
  const peers = input.peers?.filter((p) => p.name !== pod.metadata?.name);
  if (affinity.unchecked || anti.unchecked) unchecked.push(phrase("check.uncheckedNamespaces"));
  if ((affinity.terms.length > 0 || anti.terms.length > 0 || spread.length > 0) && !peers) unchecked.push(phrase("check.uncheckedPeers"));

  // Pods per topology domain, for affinity and spread.
  const domainOf = (nodeName: string | undefined, key: string) => (nodeName ? byName.get(nodeName)?.labels[key] : undefined);
  const matchingIn = (selector: Selector, key: string) => {
    const counts = new Map<string, number>();
    for (const p of peers ?? []) {
      if (!p.node || !matches(selector, p.labels)) continue;
      const domain = domainOf(p.node, key);
      if (domain !== undefined) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return counts;
  };
  const anyAffinityPeer = peers?.some((p) => affinity.terms.every((t) => matches(t.selector, p.labels))) ?? false;
  const selfMatchesAffinity = affinity.terms.every((t) => matches(t.selector, ownLabels));

  // Topology spread: the smallest count over the eligible domains.
  const spreadState = spread.map((c) => {
    const counts = matchingIn(c.selector, c.topologyKey);
    const domains = new Set<string>();
    for (const n of input.nodes) {
      const value = n.labels[c.topologyKey];
      if (value === undefined) continue;
      if (spread.some((o) => n.labels[o.topologyKey] === undefined)) continue;
      if (c.honorAffinity && !(nodeSelectorFits(pod, n) && nodeAffinityFits(pod, n))) continue;
      if (c.honorTaints && blockingTaints(pod, n).length > 0) continue;
      domains.add(value);
    }
    let min = domains.size === 0 ? 0 : Math.min(...[...domains].map((d) => counts.get(d) ?? 0));
    if (c.minDomains !== undefined && domains.size < c.minDomains) min = 0;
    return { counts, min, self: matches(c.selector, ownLabels) ? 1 : 0 };
  });

  const verdicts = nodes.map((node): NodeVerdict => {
    const reasons: { code: ReasonCode; phrase: Phrase }[] = [];
    const fail = (code: ReasonCode, p: Phrase) => reasons.push({ code, phrase: p });

    if (node.unschedulable && !tolerations.some((t) => tolerates(t, UNSCHEDULABLE_TAINT))) fail("unschedulable", phrase("node.unschedulable"));
    if (!nodeSelectorFits(pod, node)) fail("nodeAffinity", phrase("node.nodeSelector"));
    else if (!nodeAffinityFits(pod, node)) fail("nodeAffinity", phrase("node.nodeAffinity"));
    for (const taint of blockingTaints(pod, node)) {
      if (taint.key === UNSCHEDULABLE_TAINT.key && node.unschedulable) continue;
      fail(taint.key.startsWith("node.kubernetes.io/not-ready") || taint.key === "node.kubernetes.io/unreachable" ? "notReady" : "taint", phrase("node.taint", { taint: taintText(taint) }));
    }
    const used = input.used.get(node.name) ?? {};
    for (const [resource, asked] of Object.entries(requests)) {
      if (asked <= 0) continue;
      const allocatable = node.allocatable[resource] ?? 0;
      const free = allocatable - (used[resource] ?? 0);
      if (asked > free + 1e-9) {
        fail(
          "insufficient",
          phrase("node.insufficient", {
            resource,
            requested: formatAmount(resource, asked),
            free: formatAmount(resource, Math.max(0, free)),
            allocatable: formatAmount(resource, allocatable),
          }),
        );
      }
    }
    if (peers) {
      for (const term of affinity.terms) {
        const domain = node.labels[term.topologyKey];
        const counts = matchingIn(term.selector, term.topologyKey);
        if (domain === undefined) {
          fail("podAffinity", phrase("node.missingTopologyLabel", { key: term.topologyKey }));
        } else if ((counts.get(domain) ?? 0) === 0 && !(!anyAffinityPeer && selfMatchesAffinity)) {
          fail("podAffinity", phrase("node.podAffinity", { key: term.topologyKey }));
        }
      }
      for (const term of anti.terms) {
        const domain = node.labels[term.topologyKey];
        if (domain !== undefined && (matchingIn(term.selector, term.topologyKey).get(domain) ?? 0) > 0) {
          fail("podAntiAffinity", phrase("node.podAntiAffinity", { key: term.topologyKey }));
        }
      }
      spread.forEach((c, i) => {
        const state = spreadState[i]!;
        const domain = node.labels[c.topologyKey];
        if (domain === undefined) {
          fail("topologySpread", phrase("node.missingTopologyLabel", { key: c.topologyKey }));
          return;
        }
        const skew = (state.counts.get(domain) ?? 0) + state.self - state.min;
        if (skew > c.maxSkew) fail("topologySpread", phrase("node.topologySkew", { key: c.topologyKey, skew, maxSkew: c.maxSkew }));
      });
    }
    for (const volume of input.volumes ?? []) {
      if (!nodeSelectorMatches(volume.required, node)) fail("volumeAffinity", phrase("node.volumeAffinity", { pv: volume.pv }));
    }
    const verdict: NodeVerdict = { node: node.name, fits: reasons.length === 0, reasons: reasons.map((r) => r.phrase) };
    if (reasons[0]) verdict.first = reasons[0].code;
    return verdict;
  });

  const byReason = new Map<ReasonCode, number>();
  for (const v of verdicts) if (v.first) byReason.set(v.first, (byReason.get(v.first) ?? 0) + 1);
  unchecked.push(phrase("check.notChecked"));
  return { requests, verdicts, total: input.nodes.length, byReason, unchecked };
}

// ---------- The pod ----------

/** Whether a pod waits for a node: Pending and not scheduled (PodScheduled False, or no condition yet). */
export function isUnscheduled(pod: KubeObject): boolean {
  if (str(get(pod, "status", "phase")) !== "Pending" || str(get(pod, "spec", "nodeName"))) return false;
  const scheduled = arr(get(pod, "status", "conditions")).find((c) => get(c, "type") === "PodScheduled");
  return !scheduled || str(get(scheduled, "status")) !== "True";
}

/** The PodScheduled condition's message and reason. */
export function schedulingCondition(pod: KubeObject): { reason?: string; message?: string; since?: string } {
  const c = arr(get(pod, "status", "conditions")).find((x) => get(x, "type") === "PodScheduled");
  const out: { reason?: string; message?: string; since?: string } = {};
  const reason = str(get(c, "reason"));
  const message = str(get(c, "message"));
  const since = str(get(c, "lastTransitionTime"));
  if (reason) out.reason = reason;
  if (message) out.message = message;
  if (since) out.since = since;
  return out;
}

/** The claims the pod mounts (`persistentVolumeClaim` and generic ephemeral volumes, `<pod>-<volume>`). */
export function claimNames(pod: KubeObject): string[] {
  const name = pod.metadata?.name ?? "";
  return arr(get(pod, "spec", "volumes")).flatMap((v) => {
    const claim = str(get(v, "persistentVolumeClaim", "claimName"));
    if (claim) return [claim];
    if (get(v, "ephemeral")) return [`${name}-${str(get(v, "name")) ?? ""}`];
    return [];
  });
}
