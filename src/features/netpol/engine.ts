// The connectivity engine: may traffic go from a source to a destination, under the policies the cluster holds?
// Pure and exhaustive over the model in `model.ts`; every policy flavour is normalised first (`kubernetes.ts`,
// `cilium.ts`, `calico.ts`).
//
// Kubernetes semantics (networking.k8s.io/v1), the base of the answer:
//  - a pod is isolated for ingress (egress) iff a policy whose types include Ingress (Egress) selects it;
//  - traffic is allowed iff the source's egress allows it (when the source is isolated for egress) AND the
//    destination's ingress allows it (when the destination is isolated for ingress); the two sides are evaluated
//    separately (`SideResult`);
//  - an isolated side allows what any rule of any selecting policy allows (union).
//
// Cilium adds deny rules (they win over any allow) and an empty rule that matches nothing; Calico evaluates policies
// in `order`, the first matching Allow/Deny rule deciding, Kubernetes NetworkPolicies counting as order 1000. A part
// Sextant does not model (an L7 rule, toFQDNs, a Calico tier, …) makes the answer "unknown", never "allowed". Not
// subject to policy: hostNetwork pods, and addresses outside the cluster for their own side.
import {
  and,
  or,
  policyKey,
  type Check,
  type Ctx,
  type Direction,
  type Endpoint,
  type Peer,
  type PeerReason,
  type PodInfo,
  type Policy,
  type PolicyRef,
  type PortReason,
  type PortSpec,
  type Protocol,
  type Rule,
  type ServiceInfo,
  type Tri,
  type Verdict,
} from "./model";
import { matches } from "../resource-map/selectors";
import { resolveTargetPort } from "./model";

/** What travels: the destination port (on the destination pod, after a Service's translation) and protocol. */
export interface Traffic {
  protocol: Protocol;
  port: number;
}

/** A list the engine needed and could not read: its policies are unknown. */
export interface Unreadable {
  /** The kind as shown ("NetworkPolicy", "CiliumNetworkPolicy", …). */
  kind: string;
  /** `null`: a cluster-wide list. */
  namespace: string | null;
}

/** Everything the engine reasons over. */
export interface World extends Ctx {
  policies: readonly Policy[];
  /** Lists that could not be read (or are still loading); a side whose policies they may hold is "unknown". */
  unreadable: readonly Unreadable[];
  /**
   * Objects of policy kinds Sextant does not evaluate (AdminNetworkPolicy, Antrea, …): `unknown` for the pods they could
   * select — those of their namespace, or every pod for a cluster-wide one (`namespace` null).
   */
  unevaluated?: readonly { kind: string; name: string; namespace?: string | null }[];
  /**
   * Host policies (a Cilium policy with `nodeSelector`, every Calico GlobalNetworkPolicy): not evaluated, they may
   * govern a node's own traffic, so a hostNetwork pod's coverage is "unknown" while any exists (coverage.ts).
   */
  hostPolicies?: readonly { kind: string; name: string }[];
}

export interface PortCheck {
  port: PortSpec;
  check: Check<PortReason>;
}

export interface PeerCheck {
  peer: Peer;
  check: Check<PeerReason>;
}

export interface RuleCheck {
  rule: Rule;
  result: Tri;
  /** `null`: the rule has no peers (every peer). */
  peers: PeerCheck[] | null;
  peerResult: Tri;
  ports: PortCheck[] | null;
  portResult: Tri;
  local?: Check<PeerReason>;
}

export interface PolicyCheck {
  policy: Policy;
  selected: Tri;
  rules: RuleCheck[];
}

/** One rule that decides: the policy, the rule, and the peer and port of it that matched. */
export interface Match {
  policy: PolicyRef;
  rule: Rule;
  /** Index of the peer that matched; `null` when the rule has no peers. */
  peer: number | null;
  /** Index of the port that matched; `null` when the rule has no ports. */
  port: number | null;
}

export type SideWhy =
  /** No policy selects the pod for this direction. */
  | "notIsolated"
  | "allowedByRule"
  | "deniedByRule"
  /** Selected by policies none of whose rules match. */
  | "noRuleMatches"
  | "hostNetwork"
  /** The side is an address outside the cluster: no policy of the cluster applies to it. */
  | "external"
  /** From a hostNetwork pod on the destination's node: node traffic is always allowed. */
  | "nodeTraffic"
  | "unknown";

export type UnknownReason =
  | { type: "unreadable"; kind: string; namespace: string | null }
  | { type: "unevaluated"; kind: string; name: string }
  | { type: "maybeSelected"; policy: PolicyRef; feature: string | null }
  | { type: "maybeRule"; policy: PolicyRef; rule: RuleCheck }
  | { type: "unmodelledRule"; policy: PolicyRef; rule: RuleCheck; features: string[] }
  | { type: "unmodelledPolicy"; policy: PolicyRef; features: string[] }
  | { type: "maybeIsolated"; policy: PolicyRef }
  | { type: "hostNetworkSource" }
  | { type: "mixed" };

export interface SideResult {
  direction: Direction;
  verdict: Verdict;
  why: SideWhy;
  /** Whether the subject pod is isolated for the direction. */
  isolated: Tri;
  /** The policies that select the subject for this direction, with every rule checked. */
  policies: PolicyCheck[];
  allowedBy: Match[];
  deniedBy: Match[];
  unknown: UnknownReason[];
  /** For "ordered" (Calico) evaluation: the rules were walked in this policy order. */
  ordered: boolean;
}

// ---------- Ports and rules ----------

export function portCheck(spec: PortSpec, traffic: Traffic, destination: PodInfo | null): Check<PortReason> {
  const check = l4Check(spec, traffic, destination);
  // Rules above L4 (Cilium's HTTP rules, …) on a port the traffic uses: it may or may not pass them.
  if (spec.unmodelled && check.result !== "no") return { result: "maybe", reason: { type: "unmodelled", feature: spec.unmodelled } };
  return check;
}

function l4Check(spec: PortSpec, traffic: Traffic, destination: PodInfo | null): Check<PortReason> {
  if (spec.protocol === "OTHER") return { result: "no", reason: { type: "protocol", expected: "other" } };
  if (spec.protocol !== "ANY" && spec.protocol !== traffic.protocol) {
    return { result: "no", reason: { type: "protocol", expected: spec.protocol } };
  }
  if (spec.port === null || spec.port === 0) return { result: "yes", reason: { type: "match" } };
  if (typeof spec.port === "number") {
    const end = spec.endPort ?? spec.port;
    const inside = traffic.port >= spec.port && traffic.port <= end;
    return inside
      ? { result: "yes", reason: { type: "match" } }
      : { result: "no", reason: { type: "port", expected: end !== spec.port ? `${spec.port}-${end}` : String(spec.port) } };
  }
  const name = spec.port;
  if (!destination) return { result: "no", reason: { type: "namedExternal", name } };
  const named = destination.ports.filter(
    (p) => p.name === name && (spec.protocol === "ANY" || p.protocol === spec.protocol),
  );
  if (named.length === 0) {
    // A pod known only by labels has no container ports to look at.
    return destination.name === null
      ? { result: "maybe", reason: { type: "namedUnresolved", name } }
      : { result: "no", reason: { type: "namedUnresolved", name } };
  }
  return named.some((p) => p.port === traffic.port)
    ? { result: "yes", reason: { type: "match" } }
    : { result: "no", reason: { type: "namedOther", name, resolved: named[0]!.port } };
}

export function ruleCheck(
  rule: Rule,
  peer: Endpoint,
  subject: PodInfo,
  traffic: Traffic,
  destination: PodInfo | null,
  ctx: Ctx,
): RuleCheck {
  if (rule.empty) {
    return { rule, result: "no", peers: [], peerResult: "no", ports: null, portResult: "yes" };
  }
  const peers = rule.peers?.map((p) => ({ peer: p, check: p.match(peer, ctx) })) ?? null;
  const peerResult = peers ? or(...peers.map((p) => p.check.result)) : "yes";
  const ports = rule.ports?.map((p) => ({ port: p, check: portCheck(p, traffic, destination) })) ?? null;
  const portResult = ports ? or(...ports.map((p) => p.check.result)) : "yes";
  const local = rule.local?.match({ type: "pod", pod: subject }, ctx);
  const unmodelled: Tri = rule.unmodelled.length > 0 ? "maybe" : "yes";
  return {
    rule,
    result: and(peerResult, portResult, local?.result ?? "yes", unmodelled),
    peers,
    peerResult,
    ports,
    portResult,
    local,
  };
}

function matchOf(policy: Policy, check: RuleCheck): Match {
  return {
    policy: policy.ref,
    rule: check.rule,
    peer: check.peers ? (check.peers.find((p) => p.check.result === "yes")?.peer.index ?? null) : null,
    port: check.ports ? (check.ports.find((p) => p.check.result === "yes")?.port.index ?? null) : null,
  };
}

const isDeny = (rule: Rule) => rule.action === "deny";

/** The features Sextant does not model that leave a rule's match open. */
export function unmodelledFeatures(check: RuleCheck): string[] {
  const features = [...check.rule.unmodelled];
  for (const p of check.peers ?? []) if (p.check.result === "maybe" && p.check.reason.type === "unmodelled") features.push(p.check.reason.feature);
  for (const p of check.ports ?? []) if (p.check.result === "maybe" && p.check.reason.type === "unmodelled") features.push(p.check.reason.feature);
  if (check.local?.result === "maybe" && check.local.reason.type === "unmodelled") features.push(check.local.reason.feature);
  return [...new Set(features)];
}

function maybeReason(policy: Policy, check: RuleCheck): UnknownReason {
  const features = unmodelledFeatures(check);
  return features.length > 0
    ? { type: "unmodelledRule", policy: policy.ref, rule: check, features }
    : { type: "maybeRule", policy: policy.ref, rule: check };
}

// ---------- One side ----------

/**
 * The policies of `subject` for `direction` against `peer`: `destination` is the pod receiving the traffic (named
 * ports are resolved on it), `null` for an address outside the cluster.
 */
export function evaluateSide(
  direction: Direction,
  subject: PodInfo,
  peer: Endpoint,
  traffic: Traffic,
  destination: PodInfo | null,
  world: World,
): SideResult {
  const base: Pick<SideResult, "direction" | "allowedBy" | "deniedBy" | "unknown"> = { direction, allowedBy: [], deniedBy: [], unknown: [] };
  if (subject.hostNetwork) return exempt(direction, "hostNetwork");

  const checks: PolicyCheck[] = [];
  for (const policy of world.policies) {
    if (!policy.applies[direction] && !policy.isolates[direction]) continue;
    const selected = policy.selects(subject, world);
    if (selected.result === "no") continue;
    const rules = policy.rules[direction].map((r) => ruleCheck(r, peer, subject, traffic, destination, world));
    checks.push({ policy, selected: selected.result, rules });
  }

  const unknown: UnknownReason[] = [];
  for (const u of world.unreadable) {
    if (u.namespace === null || u.namespace === subject.namespace) unknown.push({ type: "unreadable", kind: u.kind, namespace: u.namespace });
  }
  for (const u of world.unevaluated ?? []) {
    if (!u.namespace || u.namespace === subject.namespace) unknown.push({ type: "unevaluated", kind: u.kind, name: u.name });
  }

  const isolated = or(...checks.filter((c) => c.policy.isolates[direction]).map((c) => c.selected));
  const ordered = checks.some((c) => c.policy.semantics === "ordered");
  const result = ordered
    ? orderedVerdict(direction, checks, unknown)
    : unionVerdict(direction, checks, unknown, isolated);

  // A hostNetwork source reaches the destination from its node's address: pod selectors do not match it, and traffic
  // from the destination's own node is always allowed.
  if (direction === "ingress" && peer.type === "pod" && peer.pod.hostNetwork && isolated !== "no") {
    if (peer.pod.nodeName && peer.pod.nodeName === subject.nodeName) {
      return { ...base, policies: checks, verdict: "allowed", why: "nodeTraffic", isolated, ordered };
    }
    return { ...base, policies: checks, unknown: [{ type: "hostNetworkSource" }, ...unknown], verdict: "unknown", why: "unknown", isolated, ordered };
  }
  return { ...base, ...result, policies: checks, isolated, ordered };
}

type Partial = Pick<SideResult, "verdict" | "why" | "allowedBy" | "deniedBy" | "unknown">;

function unionVerdict(direction: Direction, checks: PolicyCheck[], unknown: UnknownReason[], isolated: Tri): Partial {
  const allowedBy: Match[] = [];
  const deniedBy: Match[] = [];
  const allows: Tri[] = [];
  const denies: Tri[] = [];
  for (const c of checks) {
    if (c.policy.unmodelled.length > 0) unknown.push({ type: "unmodelledPolicy", policy: c.policy.ref, features: c.policy.unmodelled });
    if (c.selected === "maybe") unknown.push({ type: "maybeSelected", policy: c.policy.ref, feature: null });
    for (const r of c.rules) {
      const result = and(c.selected, r.result);
      (isDeny(r.rule) ? denies : allows).push(result);
      if (result === "yes") (isDeny(r.rule) ? deniedBy : allowedBy).push(matchOf(c.policy, r));
      if (r.result === "maybe") unknown.push(maybeReason(c.policy, r));
    }
  }
  const allow = or(...allows);
  const deny = or(...denies);
  const unreadable = unknown.some((u) => u.type === "unreadable" || u.type === "unevaluated");
  const unmodelled = unknown.some((u) => u.type === "unmodelledRule" || u.type === "unmodelledPolicy");
  const result = (verdict: Verdict, why: SideWhy): Partial => ({ verdict, why, allowedBy, deniedBy, unknown });

  if (deny === "yes") return result("denied", "deniedByRule");
  if (unreadable) return result("unknown", "unknown");
  if (isolated === "no") return deny === "maybe" ? result("unknown", "unknown") : result("allowed", "notIsolated");
  if (allow === "yes") return deny === "no" && !unmodelled ? result("allowed", "allowedByRule") : result("unknown", "unknown");
  if (allow === "no" && isolated === "yes" && deny === "no") return result("denied", "noRuleMatches");
  if (isolated === "maybe") {
    for (const c of checks) if (c.selected === "maybe" && c.policy.isolates[direction]) unknown.push({ type: "maybeIsolated", policy: c.policy.ref });
  }
  return result("unknown", "unknown");
}

const orderValue = (p: Policy) => p.order ?? Number.POSITIVE_INFINITY;

function orderedVerdict(direction: Direction, checks: PolicyCheck[], unknown: UnknownReason[]): Partial {
  const result = (verdict: Verdict, why: SideWhy, match?: Match): Partial => ({
    verdict,
    why,
    allowedBy: match && verdict === "allowed" ? [match] : [],
    deniedBy: match && verdict === "denied" ? [match] : [],
    unknown,
  });
  if (unknown.some((u) => u.type === "unreadable" || u.type === "unevaluated")) return result("unknown", "unknown");
  const sorted = [...checks].sort(
    (a, b) => orderValue(a.policy) - orderValue(b.policy) || a.policy.sortName.localeCompare(b.policy.sortName),
  );
  for (const c of sorted) {
    if (c.policy.semantics !== "ordered" && c.policy.ref.flavor !== "kubernetes") {
      // A Cilium policy among Calico ones: two engines' rules cannot be combined.
      unknown.push({ type: "mixed" });
      return result("unknown", "unknown");
    }
    if (!c.policy.isolates[direction]) continue;
    if (c.policy.unmodelled.length > 0) {
      unknown.push({ type: "unmodelledPolicy", policy: c.policy.ref, features: c.policy.unmodelled });
      return result("unknown", "unknown");
    }
    if (c.selected === "maybe") {
      unknown.push({ type: "maybeSelected", policy: c.policy.ref, feature: null });
      return result("unknown", "unknown");
    }
    for (const r of c.rules) {
      if (r.result === "no") continue;
      if (r.rule.action === "log") continue;
      if (r.rule.action === "pass") {
        unknown.push({ type: "unmodelledRule", policy: c.policy.ref, rule: r, features: ["Pass"] });
        return result("unknown", "unknown");
      }
      if (r.result === "maybe") {
        unknown.push(maybeReason(c.policy, r));
        return result("unknown", "unknown");
      }
      return r.rule.action === "allow"
        ? result("allowed", "allowedByRule", matchOf(c.policy, r))
        : result("denied", "deniedByRule", matchOf(c.policy, r));
    }
  }
  const isolated = sorted.some((c) => c.policy.isolates[direction] && c.selected === "yes");
  return isolated ? result("denied", "noRuleMatches") : result("allowed", "notIsolated");
}

// ---------- A connection ----------

export type Note =
  /** Source and destination are the same pod. */
  | "self"
  | "hostNetworkSource"
  | "hostNetworkDestination"
  /** A pod IP was inside an ipBlock: implementation-defined. */
  | "ipBlockPods"
  | "externalSource"
  | "externalDestination"
  | "calicoOrder";

export interface ConnectionResult {
  verdict: Verdict;
  egress: SideResult;
  ingress: SideResult;
  notes: Note[];
}

const combine = (a: Verdict, b: Verdict): Verdict =>
  a === "denied" || b === "denied" ? "denied" : a === "unknown" || b === "unknown" ? "unknown" : "allowed";

const exempt = (direction: Direction, why: SideWhy): SideResult => ({
  direction,
  verdict: "allowed",
  why,
  isolated: "no",
  policies: [],
  allowedBy: [],
  deniedBy: [],
  unknown: [],
  ordered: false,
});

/** Whether traffic from `source` to `destination` is allowed, egress and ingress evaluated separately. */
export function evaluate(source: Endpoint, destination: Endpoint, traffic: Traffic, world: World): ConnectionResult {
  const dstPod = destination.type === "pod" ? destination.pod : null;
  const egress =
    source.type === "external"
      ? exempt("egress", "external")
      : evaluateSide("egress", source.pod, destination, traffic, dstPod, world);
  const ingress =
    destination.type === "external"
      ? exempt("ingress", "external")
      : evaluateSide("ingress", destination.pod, source, traffic, destination.pod, world);
  const notes: Note[] = [];
  if (source.type === "pod" && dstPod && source.pod.name !== null && source.pod.name === dstPod.name && source.pod.namespace === dstPod.namespace) notes.push("self");
  if (source.type === "pod" && source.pod.hostNetwork) notes.push("hostNetworkSource");
  if (dstPod?.hostNetwork) notes.push("hostNetworkDestination");
  if (source.type === "external") notes.push("externalSource");
  if (destination.type === "external") notes.push("externalDestination");
  const ipBlockPods = [egress, ingress].some((s) =>
    s.policies.some((p) => p.rules.some((r) => r.peers?.some((c) => c.check.reason.type === "ipBlockPod"))),
  );
  if (ipBlockPods) notes.push("ipBlockPods");
  if (egress.ordered || ingress.ordered) notes.push("calicoOrder");
  return { verdict: combine(egress.verdict, ingress.verdict), egress, ingress, notes };
}

// ---------- Services ----------

export interface BackendResult {
  pod: PodInfo;
  /** The pod port the Service port reaches; `null` when a named target port is not on the pod. */
  port: number | null;
  result: ConnectionResult | null;
}

export interface ServiceResult {
  /** "partial": allowed to some of the pods and denied to the others. */
  verdict: Verdict | "partial";
  backends: BackendResult[];
  /** Why there is nothing to evaluate. */
  empty?: "externalName" | "noSelector" | "noPods" | "noPort";
}

/** Traffic to a Service port: checked against every pod it selects, at the pod port its target port names. */
export function evaluateService(
  source: Endpoint,
  service: ServiceInfo,
  portIndex: number,
  pods: readonly PodInfo[],
  world: World,
): ServiceResult {
  if (service.type === "ExternalName") return { verdict: "unknown", backends: [], empty: "externalName" };
  if (!service.hasSelector) return { verdict: "unknown", backends: [], empty: "noSelector" };
  const port = service.ports[portIndex];
  if (!port) return { verdict: "unknown", backends: [], empty: "noPort" };
  const backends = pods
    .filter((p) => p.namespace === service.namespace && matches(service.selector, p.labels))
    .map((pod): BackendResult => {
      const target = resolveTargetPort(port, pod);
      if (target === null) return { pod, port: null, result: null };
      return {
        pod,
        port: target,
        result: evaluate(source, { type: "pod", pod }, { protocol: port.protocol, port: target }, world),
      };
    });
  const reachable = backends.filter((b) => b.result !== null);
  if (reachable.length === 0) return { verdict: "unknown", backends, empty: backends.length === 0 ? "noPods" : "noPort" };
  const verdicts = reachable.map((b) => b.result!.verdict);
  const verdict: ServiceResult["verdict"] = verdicts.every((v) => v === "allowed")
    ? "allowed"
    : verdicts.every((v) => v === "denied")
      ? "denied"
      : verdicts.includes("unknown")
        ? "unknown"
        : "partial";
  return { verdict, backends };
}

// ---------- DNS ----------

export interface DnsCheck {
  /** Egress of the source to the cluster DNS on UDP 53 and TCP 53. */
  udp: Verdict;
  tcp: Verdict;
  /** The DNS pods the check used; `[]` when none are visible (a pod described by the usual kube-dns labels is used). */
  pods: PodInfo[];
}

export const DNS_LABELS = { "k8s-app": "kube-dns" } as const;
export const DNS_NAMESPACE = "kube-system";

const DESCRIBED_DNS: PodInfo = {
  namespace: DNS_NAMESPACE,
  name: null,
  labels: DNS_LABELS,
  ips: [],
  hostNetwork: false,
  nodeName: null,
  serviceAccount: null,
  ports: [
    { name: "dns", port: 53, protocol: "UDP" },
    { name: "dns-tcp", port: 53, protocol: "TCP" },
  ],
};

/**
 * Whether an egress-isolated source may reach the cluster DNS: `null` when the source is not isolated for egress (or
 * not subject to policy), otherwise the egress verdicts for UDP and TCP 53 (any one DNS pod allowed counts).
 */
export function dnsCheck(source: PodInfo, dnsPods: readonly PodInfo[], world: World): DnsCheck | null {
  if (source.hostNetwork) return null;
  const targets = dnsPods.length > 0 ? dnsPods : [DESCRIBED_DNS];
  const side = (protocol: Protocol): { verdict: Verdict; isolated: Tri } => {
    const results = targets.map((pod) =>
      evaluateSide("egress", source, { type: "pod", pod }, { protocol, port: 53 }, pod, world),
    );
    const isolated = or(...results.map((r) => r.isolated));
    const verdicts = results.map((r) => r.verdict);
    const verdict: Verdict = verdicts.includes("allowed") ? "allowed" : verdicts.includes("unknown") ? "unknown" : "denied";
    return { verdict, isolated };
  };
  const udp = side("UDP");
  if (udp.isolated === "no") return null;
  return { udp: udp.verdict, tcp: side("TCP").verdict, pods: [...dnsPods] };
}

export { policyKey };

// ---------- Isolation ----------

export interface Isolation {
  /** "unknown": a policy list of the pod's namespace (or a cluster-wide one) could not be read. */
  state: "isolated" | "notIsolated" | "maybe" | "hostNetwork" | "unknown";
  /** Policies that isolate the pod for the direction. */
  by: Policy[];
  /** Policies that may select it (a selector Sextant cannot evaluate). */
  maybe: Policy[];
}

/** Whether `pod` is isolated for `direction`, and by which policies. */
export function isolationOf(pod: PodInfo, direction: Direction, world: World): Isolation {
  if (pod.hostNetwork) return { state: "hostNetwork", by: [], maybe: [] };
  const by: Policy[] = [];
  const maybe: Policy[] = [];
  for (const p of world.policies) {
    if (!p.isolates[direction]) continue;
    const s = p.selects(pod, world).result;
    if (s === "yes") by.push(p);
    else if (s === "maybe") maybe.push(p);
  }
  const unreadable =
    world.unreadable.some((u) => u.namespace === null || u.namespace === pod.namespace) ||
    (world.unevaluated ?? []).some((u) => !u.namespace || u.namespace === pod.namespace);
  if (by.length > 0) return { state: "isolated", by, maybe };
  if (unreadable) return { state: "unknown", by, maybe };
  return { state: maybe.length > 0 ? "maybe" : "notIsolated", by, maybe };
}
