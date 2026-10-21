// Network policy coverage (#239): which pods no policy selects, for ingress and egress separately, and whether a
// namespace has a default deny. Pure, over the engine's `World` (`engine.ts`) and the normalised policies of every
// flavour (Kubernetes NetworkPolicy, CiliumNetworkPolicy / CiliumClusterwideNetworkPolicy, Calico NetworkPolicy /
// GlobalNetworkPolicy).
//
// A pod is "isolated" for a direction when at least one evaluated policy whose types include it (Kubernetes:
// `policyTypes`, defaulted to Ingress plus Egress when there are egress rules; Cilium: a spec with rules of the
// direction and default deny on; Calico: `types`) certainly selects it. It is "unknown" — never "not isolated" — when
// a policy might select it (a selector Sextant cannot evaluate, a policy feature it does not model such as a Calico
// tier or `serviceAccountSelector`), when a policy list of its namespace or a cluster-wide one could not be read, and
// when an object of a policy kind Sextant does not evaluate (`UNEVALUATED_KINDS`) could apply to it. hostNetwork pods
// are not subject to pod policy: they are "not isolated", with that reason.
//
// A namespace's default deny for a direction: an evaluated policy that selects every pod of the namespace whatever its
// labels (`Policy.everyPodIn`) and allows nothing for the direction by itself (no rules, Cilium's `{}`, or only
// Deny/Log rules). "maybe" when such a policy has an unmodelled feature or a list that could hold one is unreadable.
import { or, policyKey, type Direction, type PodInfo, type PolicyRef, type Rule, type Tri } from "./model";
import type { World } from "./engine";

export type CoverageState = "isolated" | "notIsolated" | "unknown";

/** Why a pod's coverage cannot be told. */
export type CoverageCause =
  | { type: "unreadable"; kind: string; namespace: string | null }
  | { type: "unevaluated"; kind: string; name: string }
  /** A selector of the policy Sextant cannot evaluate for this pod. */
  | { type: "maybeSelected"; policy: PolicyRef }
  /** The policy selects the pod but has features Sextant does not model (a Calico tier, …). */
  | { type: "unmodelledPolicy"; policy: PolicyRef; features: string[] };

export interface DirectionCoverage {
  state: CoverageState;
  /** A hostNetwork pod: not subject to pod policy, so never isolated. */
  hostNetwork: boolean;
  /** The policies that certainly isolate the pod for the direction. */
  by: PolicyRef[];
  /** The policies that may isolate it. */
  maybe: PolicyRef[];
  unknown: CoverageCause[];
}

/** The lists and objects of other kinds that leave a pod of `namespace` (or a whole namespace) undecided. */
export function openCauses(world: World, namespace: string): CoverageCause[] {
  const causes: CoverageCause[] = [];
  for (const u of world.unreadable) {
    if (u.namespace === null || u.namespace === namespace) causes.push({ type: "unreadable", kind: u.kind, namespace: u.namespace });
  }
  for (const u of world.unevaluated ?? []) {
    if (!u.namespace || u.namespace === namespace) causes.push({ type: "unevaluated", kind: u.kind, name: u.name });
  }
  return causes;
}

/** Whether `pod` is isolated for `direction` by the policies of `world`. */
export function podCoverage(pod: PodInfo, direction: Direction, world: World): DirectionCoverage {
  if (pod.hostNetwork) return { state: "notIsolated", hostNetwork: true, by: [], maybe: [], unknown: [] };
  const by: PolicyRef[] = [];
  const maybe: PolicyRef[] = [];
  const unknown: CoverageCause[] = [];
  for (const policy of world.policies) {
    if (!policy.isolates[direction]) continue;
    const selected = policy.selects(pod, world).result;
    if (selected === "no") continue;
    if (selected === "maybe") {
      maybe.push(policy.ref);
      unknown.push({ type: "maybeSelected", policy: policy.ref });
    } else if (policy.unmodelled.length > 0) {
      maybe.push(policy.ref);
      unknown.push({ type: "unmodelledPolicy", policy: policy.ref, features: policy.unmodelled });
    } else {
      by.push(policy.ref);
    }
  }
  if (by.length > 0) return { state: "isolated", hostNetwork: false, by, maybe, unknown: [] };
  unknown.push(...openCauses(world, pod.namespace));
  return { state: unknown.length > 0 ? "unknown" : "notIsolated", hostNetwork: false, by, maybe, unknown };
}

export interface PodCoverage {
  pod: PodInfo;
  ingress: DirectionCoverage;
  egress: DirectionCoverage;
}

export const coverageOf = (pod: PodInfo, world: World): PodCoverage => ({
  pod,
  ingress: podCoverage(pod, "ingress", world),
  egress: podCoverage(pod, "egress", world),
});

// ---------- Default deny ----------

/** A rule that allows nothing by itself: Cilium's empty rule, a Deny or a Log rule. */
const allowsNothing = (rule: Rule) => rule.empty === true || rule.action === "deny" || rule.action === "log";

export interface DefaultDeny {
  /** "maybe": a policy that could be one has an unmodelled feature, or a list that could hold one is unreadable. */
  state: Tri;
  /** The policies that make it. */
  by: PolicyRef[];
}

/** Whether `namespace` has a default deny for `direction`: one policy selecting all its pods and allowing nothing. */
export function defaultDenyOf(namespace: string, direction: Direction, world: World): DefaultDeny {
  const by: PolicyRef[] = [];
  const results: Tri[] = [];
  for (const policy of world.policies) {
    if (!policy.isolates[direction] || !policy.rules[direction].every(allowsNothing)) continue;
    const every = policy.everyPodIn?.(namespace, world) ?? "no";
    if (every === "no") continue;
    const result: Tri = every === "yes" && policy.unmodelled.length === 0 ? "yes" : "maybe";
    if (result === "yes") by.push(policy.ref);
    results.push(result);
  }
  let state = or(...results);
  if (state === "no" && openCauses(world, namespace).length > 0) state = "maybe";
  return { state, by };
}

// ---------- A namespace ----------

/** How many of a namespace's pods are isolated: "noPods" when it has none, "unknown" when it cannot be told. */
export type CoverageLevel = "all" | "some" | "none" | "unknown" | "noPods";

export interface DirectionSummary {
  level: CoverageLevel;
  isolated: number;
  notIsolated: number;
  unknown: number;
  /** Of `notIsolated`: hostNetwork pods. */
  hostNetwork: number;
  defaultDeny: DefaultDeny;
}

export interface SelectingPolicy {
  ref: PolicyRef;
  /** Pods of the namespace it isolates, per direction. */
  ingress: number;
  egress: number;
}

export interface NamespaceCoverage {
  namespace: string;
  /** `null`: the namespace's pods could not be read. */
  pods: PodCoverage[] | null;
  ingress: DirectionSummary;
  egress: DirectionSummary;
  /** The policies that isolate at least one of its pods, by name. */
  policies: SelectingPolicy[];
  /** Lists and objects of other kinds that leave its pods undecided. */
  unknown: CoverageCause[];
}

/**
 * The level of a direction: "all" when no pod is open and none undecided, "none" when none is isolated and none
 * undecided, "some" when some are isolated and some certainly are not; undecided pods that could change the word make
 * it "unknown".
 */
export function levelOf(counts: { isolated: number; notIsolated: number; unknown: number }): CoverageLevel {
  const { isolated, notIsolated, unknown } = counts;
  if (isolated + notIsolated + unknown === 0) return "noPods";
  if (isolated > 0 && notIsolated > 0) return "some";
  if (unknown > 0) return "unknown";
  return notIsolated === 0 ? "all" : "none";
}

function summary(pods: PodCoverage[] | null, direction: Direction, namespace: string, world: World): DirectionSummary {
  const defaultDeny = defaultDenyOf(namespace, direction, world);
  if (pods === null) return { level: "unknown", isolated: 0, notIsolated: 0, unknown: 0, hostNetwork: 0, defaultDeny };
  const of = (state: CoverageState) => pods.filter((p) => p[direction].state === state).length;
  const counts = { isolated: of("isolated"), notIsolated: of("notIsolated"), unknown: of("unknown") };
  return { level: levelOf(counts), ...counts, hostNetwork: pods.filter((p) => p[direction].hostNetwork).length, defaultDeny };
}

/** The coverage of `namespace` from its running pods (`undefined`: not readable). */
export function namespaceCoverage(namespace: string, pods: readonly PodInfo[] | undefined, world: World): NamespaceCoverage {
  const covered = pods ? [...pods].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")).map((p) => coverageOf(p, world)) : null;
  const byKey = new Map<string, SelectingPolicy>();
  for (const p of covered ?? []) {
    for (const direction of ["ingress", "egress"] as const) {
      for (const ref of p[direction].by) {
        const key = policyKey(ref);
        const entry = byKey.get(key) ?? { ref, ingress: 0, egress: 0 };
        entry[direction]++;
        byKey.set(key, entry);
      }
    }
  }
  return {
    namespace,
    pods: covered,
    ingress: summary(covered, "ingress", namespace, world),
    egress: summary(covered, "egress", namespace, world),
    policies: [...byKey.values()].sort((a, b) => a.ref.name.localeCompare(b.ref.name)),
    unknown: openCauses(world, namespace),
  };
}
