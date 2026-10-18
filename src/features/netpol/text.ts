// How the connectivity views say things: the engine's phrases, reasons and references as translated text (keys under
// `netpol:`), built outside JSX.
import { formatList, formatParts } from "../../i18n";
import type { RuleCheck, UnknownReason } from "./engine";
import { unmodelledFeatures } from "./engine";
import type { Labels, PeerReason, Phrase, PolicyRef, PortReason, Rule, Tri, Verdict } from "./model";

export type T = (key: string, options?: Record<string, unknown>) => string;

export const phrase = (t: T, p: Phrase): string => t(`netpol:${p.key}`, p.params);

export const labelsText = (labels: Labels): string =>
  Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

/** `ns/name` (or the name of a cluster-wide policy), with the spec index of a multi-spec Cilium policy. */
export function policyName(ref: PolicyRef): string {
  const base = ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
  return ref.part === null ? base : `${base} [${ref.part}]`;
}

export const flavorText = (t: T, ref: PolicyRef) => t(`netpol:flavor.${ref.flavor}`);

export const ruleText = (t: T, rule: Rule) => t(`netpol:rule.${rule.list}`, { n: rule.index + 1 });

export const verdictText = (t: T, v: Verdict) => t(`netpol:verdict.${v}`);

export const VERDICT_TONE = { allowed: "success", denied: "danger", unknown: "warning" } as const;

export const triMark = (t: T, v: Tri) => t(`netpol:tri.${v}`);

export function peerReasonText(t: T, r: PeerReason): string {
  switch (r.type) {
    case "namespace":
      return t("netpol:peerReason.namespace", { actual: r.actual, expected: r.expected });
    case "namespaceSelector":
      if (r.labels === null) return t("netpol:peerReason.namespaceLabelsUnknown", { namespace: r.namespace });
      if (!r.selector) return t("netpol:peerReason.namespaceNoMatch", { namespace: r.namespace, labels: labelsText(r.labels) });
      return t("netpol:peerReason.namespaceSelector", { namespace: r.namespace, labels: labelsText(r.labels), selector: r.selector });
    case "podSelector":
      if (Object.keys(r.labels).length === 0) return t("netpol:peerReason.podNoLabels", { selector: r.selector || "*" });
      if (!r.selector) return t("netpol:peerReason.podNoMatch", { labels: labelsText(r.labels) });
      return t("netpol:peerReason.podSelector", { labels: labelsText(r.labels), selector: r.selector });
    case "ipBlock":
      return t("netpol:peerReason.ipBlock", { cidr: r.cidr });
    case "ipBlockExcept":
      return t("netpol:peerReason.ipBlockExcept", { cidr: r.cidr, except: r.except });
    case "ipBlockPod":
      return t("netpol:peerReason.ipBlockPod", { cidr: r.cidr });
    case "entity":
      return t("netpol:peerReason.entity", { entity: r.entity });
    case "unmodelled":
      return t("netpol:reason.unmodelled", { feature: r.feature });
    default:
      return t(`netpol:peerReason.${r.type}`);
  }
}

export function portReasonText(t: T, r: PortReason): string {
  switch (r.type) {
    case "protocol":
      return r.expected === "other" ? t("netpol:portReason.otherProtocol") : t("netpol:portReason.protocol", { protocol: r.expected });
    case "port":
      return t("netpol:portReason.port", { port: r.expected });
    case "namedUnresolved":
      return t("netpol:portReason.namedUnresolved", { name: r.name });
    case "namedOther":
      return t("netpol:portReason.namedOther", { name: r.name, port: r.resolved });
    case "namedExternal":
      return t("netpol:portReason.namedExternal", { name: r.name });
    case "unmodelled":
      return t("netpol:reason.unmodelled", { feature: r.feature });
    default:
      return t("netpol:portReason.match");
  }
}

/** Why a rule matched, did not, or could not be told — one line per reason. */
export function ruleWhy(t: T, check: RuleCheck): string[] {
  const { rule } = check;
  if (rule.empty) return [t("netpol:ruleWhy.empty")];
  if (check.result === "yes") return [t(rule.action === "deny" ? "netpol:ruleWhy.denies" : "netpol:ruleWhy.allows")];
  const lines: string[] = [];
  const wanted: Tri = check.result === "no" ? "no" : "maybe";
  if (check.local && check.local.result === wanted) lines.push(t("netpol:ruleWhy.local", { reason: peerReasonText(t, check.local.reason) }));
  if (check.peers && check.peerResult === wanted) {
    const shown = check.peers.filter((p) => p.check.result === wanted);
    for (const p of shown) {
      const reason = peerReasonText(t, p.check.reason);
      lines.push(check.peers.length > 1 ? t("netpol:ruleWhy.peerN", { n: p.peer.index + 1, reason }) : reason);
    }
  }
  if (check.ports && check.portResult === wanted) {
    const shown = check.ports.filter((p) => p.check.result === wanted);
    for (const p of shown) {
      const reason = portReasonText(t, p.check.reason);
      lines.push(check.ports.length > 1 ? t("netpol:ruleWhy.portN", { n: p.port.index + 1, reason }) : reason);
    }
  }
  const features = unmodelledFeatures(check).filter((f) => rule.unmodelled.includes(f));
  if (features.length > 0) lines.push(t("netpol:reason.unmodelled", { feature: formatList(features) }));
  return lines;
}

/** "Could not read the NetworkPolicy objects of namespace shop." */
export const unreadableText = (t: T, u: { kind: string; namespace: string | null }) => unknownText(t, { type: "unreadable", ...u });

/** "AdminNetworkPolicy x may apply, and Sextant does not evaluate AdminNetworkPolicy objects." */
export const unevaluatedText = (t: T, u: { kind: string; name: string }) => unknownText(t, { type: "unevaluated", kind: u.kind, name: u.name });

export function unknownText(t: T, u: UnknownReason): string {
  switch (u.type) {
    case "unreadable":
      return u.namespace
        ? t("netpol:unknown.unreadable", { kind: u.kind, namespace: u.namespace })
        : t("netpol:unknown.unreadableClusterwide", { kind: u.kind });
    case "unevaluated":
      return t("netpol:unknown.unevaluated", { kind: u.kind, name: u.name });
    case "maybeSelected":
      return t("netpol:unknown.maybeSelected", { policy: policyName(u.policy) });
    case "maybeIsolated":
      return t("netpol:unknown.maybeIsolated", { policy: policyName(u.policy) });
    case "maybeRule":
      return t("netpol:unknown.maybeRule", {
        policy: policyName(u.policy),
        rule: ruleText(t, u.rule.rule),
        reason: ruleWhy(t, u.rule).join(" "),
      });
    case "unmodelledRule":
      return t("netpol:unknown.unmodelledRule", {
        flavor: flavorText(t, u.policy),
        policy: policyName(u.policy),
        rule: ruleText(t, u.rule.rule),
        features: formatList(u.features),
      });
    case "unmodelledPolicy":
      return t("netpol:unknown.unmodelledPolicy", { flavor: flavorText(t, u.policy), policy: policyName(u.policy), features: formatList(u.features) });
    default:
      return t(`netpol:unknown.${u.type}`);
  }
}

/** "Ingress rule 2 · peer 1: pods app=web · port 1: TCP 80" for one deciding rule (the policy is linked apart). */
export function matchText(t: T, rule: Rule, peer: number | null, port: number | null): string {
  const peerDef = peer === null ? null : rule.peers?.find((p) => p.index === peer);
  const portDef = port === null ? null : rule.ports?.find((p) => p.index === port);
  return formatParts([
    ruleText(t, rule),
    peerDef ? t("netpol:match.peer", { n: peerDef.index + 1, peer: phrase(t, peerDef.text) }) : t("netpol:match.anyPeer"),
    portDef ? t("netpol:match.port", { n: portDef.index + 1, port: phrase(t, portDef.text) }) : t("netpol:match.anyPort"),
  ]);
}
