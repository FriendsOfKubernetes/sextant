// Network policies on the way to the backend pods, with the connectivity engine (#148), from the pods' side: are they
// isolated for ingress, and does a rule let the traffic in? The source is the Ingress controller's pods when they are
// known; otherwise any client outside the backend's namespace, whose labels are not known — so a rule that selects
// sources by labels makes the answer "depends on the source" (unknown), never "allowed" or "denied" by guess. The
// controller's own egress is not judged: the policies of its namespace are not listed here.
import { evaluateSide, type SideResult, type Traffic, type World } from "../netpol/engine";
import { describedPod, type PodInfo, type Verdict } from "../netpol/model";
import { phrase, type Finding, type Phrase, type TrafficSource } from "./model";

/** A namespace no object can be in (a space is not allowed in names): "somewhere else", labels unknown. */
export const OUTSIDE = " outside";

/** One backend pod and the port the traffic reaches it on. */
export interface BackendTraffic {
  pod: PodInfo;
  traffic: Traffic;
}

const combine = (verdicts: readonly Verdict[]): Verdict =>
  verdicts.includes("denied") ? "denied" : verdicts.includes("unknown") ? "unknown" : "allowed";

/** Whether some source other than the described one could be let in by a rule that did not match it. */
function couldMatchOtherSources(side: SideResult): boolean {
  return side.policies.some((p) =>
    p.rules.some(
      (r) =>
        r.rule.action === "allow" &&
        r.portResult !== "no" &&
        (r.peers ?? []).some((peer) => peer.check.result !== "yes" && peer.check.reason.type !== "namespace"),
    ),
  );
}

/** The ingress side of one backend pod for traffic from `source`. */
export function backendSide(backend: BackendTraffic, source: TrafficSource, world: World): { verdict: Verdict; sides: SideResult[] } {
  if (source.type === "controller" && source.pods.length > 0) {
    const sides = source.pods.map((pod) =>
      evaluateSide("ingress", backend.pod, { type: "pod", pod }, backend.traffic, backend.pod, world),
    );
    return { verdict: combine(sides.map((s) => s.verdict)), sides };
  }
  const outsideWorld: World = { ...world, namespaceLabels: (ns) => (ns === OUTSIDE ? undefined : world.namespaceLabels(ns)) };
  const side = evaluateSide("ingress", backend.pod, { type: "pod", pod: describedPod(OUTSIDE, {}) }, backend.traffic, backend.pod, outsideWorld);
  const verdict = side.verdict === "denied" && side.why === "noRuleMatches" && couldMatchOtherSources(side) ? "unknown" : side.verdict;
  return { verdict, sides: [side] };
}

export function sourcePhrase(source: TrafficSource, namespace: string): Phrase {
  return source.type === "controller"
    ? phrase("policies.source.controller", { controller: source.controller })
    : phrase("policies.source.outside", { namespace });
}

/** The policy finding for the ready backend pods of a Service; `undefined` when there is nothing to judge. */
export function policyFinding(
  backends: readonly BackendTraffic[],
  source: TrafficSource,
  world: World | undefined,
  namespace: string,
): Finding | undefined {
  if (backends.length === 0) return undefined;
  const from = sourcePhrase(source, namespace);
  const id = "policies";
  if (!world) return { id, status: "unknown", text: phrase("policies.unreadable", { source: from }) };
  const results = backends.map((b) => backendSide(b, source, world));
  const sides = results.flatMap((r) => r.sides);
  const verdicts = results.map((r) => r.verdict);
  const notes: Phrase[] = [phrase("policies.enforcement")];
  if (source.type === "controller") notes.push(phrase("policies.egressNotChecked"));
  const isolated = sides.some((s) => s.isolated !== "no");
  if (verdicts.every((v) => v === "allowed")) {
    const text = isolated ? phrase("policies.allowed", { source: from }) : phrase("policies.notIsolated", { source: from });
    return { id, status: "ok", text, notes, policies: sides };
  }
  if (verdicts.every((v) => v === "denied")) {
    return { id, status: "broken", text: phrase("policies.denied", { source: from }), notes, policies: sides };
  }
  if (verdicts.includes("unknown")) {
    const outsideOpen = source.type === "outside" && !verdicts.includes("denied");
    const key = outsideOpen ? "policies.dependsOnSource" : "policies.unknown";
    return { id, status: "unknown", text: phrase(key, { source: from }), notes, policies: sides };
  }
  const allowed = verdicts.filter((v) => v === "allowed").length;
  return {
    id,
    status: "warn",
    text: phrase("policies.partial", { source: from, count: allowed, total: verdicts.length }),
    notes,
    policies: sides,
  };
}
