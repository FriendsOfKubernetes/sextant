// The connectivity engine's input as an agent may see it, and its results in English words. A policy list the agent
// may not read is "unreadable" to the engine (so a side it could decide is unknown, never allowed, ADR-0082), the
// namespaces' labels count as unknown without Read on Namespaces, and pods it may not read are not there.
import type { KindRef, ReadRule } from "../../api";
import type { Match, SideResult, World } from "../netpol/engine";
import { kindLabel, NAMESPACE, POD, type NetpolData, type ServedPolicyKinds } from "../netpol/hooks";
import type { PolicyRef } from "../netpol/model";
import { matchText, ruleText, ruleWhy, sideWhyText, unknownText } from "../netpol/text";
import { en } from "./english";
import { canRead, objectName, type ObjectName } from "./scope";

const groupOf = (apiVersion: string) => (apiVersion.includes("/") ? apiVersion.split("/")[0]! : "");

/** A policy as the answers name it. */
export const policyObject = (ref: PolicyRef): ObjectName =>
  objectName({ group: groupOf(ref.apiVersion), kind: ref.kind }, ref.namespace, ref.name);

/** `world` with only what the agent may read; lists it may not read in `namespaces` (and cluster-wide) unreadable. */
export function restrictWorld(
  world: World,
  served: ServedPolicyKinds | undefined,
  namespaces: readonly string[],
  reads: readonly ReadRule[],
): World {
  const unreadable = [...world.unreadable];
  const hide = (kind: KindRef, namespace: string | null) => unreadable.push({ kind: kindLabel(kind), namespace });
  const visible = (kind: KindRef, namespaced: boolean) => {
    if (!namespaced) {
      if (!canRead(reads, kind, null)) hide(kind, null);
      return;
    }
    for (const ns of namespaces) if (!canRead(reads, kind, ns)) hide(kind, ns);
  };
  if (served) {
    for (const kind of [served.networkPolicy, served.cilium, served.calico]) if (kind) visible(kind, true);
    for (const kind of [served.ciliumClusterwide, served.calicoGlobal]) if (kind) visible(kind, false);
    for (const u of served.unevaluated) visible(u.kind, u.namespaced);
  }
  const unevaluatedKind = (label: string) => served?.unevaluated.find((u) => kindLabel(u.kind) === label)?.kind;
  const namespacesReadable = canRead(reads, NAMESPACE, null);
  return {
    ...world,
    policies: world.policies.filter((p) => canRead(reads, { group: groupOf(p.ref.apiVersion), kind: p.ref.kind }, p.ref.namespace)),
    unreadable,
    unevaluated: (world.unevaluated ?? []).filter((u) => {
      const kind = unevaluatedKind(u.kind);
      return kind !== undefined && canRead(reads, kind, u.namespace ?? null);
    }),
    namespaceLabels: (name) => (namespacesReadable ? world.namespaceLabels(name) : undefined),
  };
}

/** `data` with only what the agent may read (pods, Services, DNS pods, the policy world). */
export function restrictNetpol(data: NetpolData, namespaces: readonly string[], reads: readonly ReadRule[]): NetpolData {
  const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
  return {
    ...data,
    world: restrictWorld(data.world, data.served, namespaces, reads),
    namespaces: canRead(reads, NAMESPACE, null) ? data.namespaces : null,
    pods: (ns) => (canRead(reads, POD, ns) ? data.pods(ns) : undefined),
    services: (ns) => (canRead(reads, SERVICE, ns) ? data.services(ns) : undefined),
    dnsPods: data.dnsPods.filter((p) => canRead(reads, POD, p.namespace)),
  };
}

const matchOut = (m: Match) => ({ policy: policyObject(m.policy), text: matchText(en, m.rule, m.peer, m.port) });

/** One side of a connection in words, as `check_connectivity` answers it. */
export function sideOut(side: SideResult) {
  return {
    direction: side.direction,
    verdict: side.verdict,
    why: sideWhyText(en, side),
    allowedBy: side.allowedBy.map(matchOut),
    deniedBy: side.deniedBy.map(matchOut),
    unknown: side.unknown.map((u) => unknownText(en, u)),
    policies: side.policies.map((p) => ({
      policy: policyObject(p.policy.ref),
      rules: p.rules.map((r) => ({ rule: ruleText(en, r.rule), result: r.result, why: ruleWhy(en, r) })),
    })),
  };
}
