// What an agent may read, as the backend sent it with a diagnostic request (`DiagnosticRequest.reads`, the Read rules
// in force for the agent, ADR-0094): the same matching as `sextant_core::access` — a kind by group and name ignoring
// case, a namespace only from a rule's list, an object without a namespace (or a list over all namespaces) only under
// a rule for all namespaces. The window feeds its engines only what this allows; the backend checks every object of
// the answer again.
import type { KindRef, KubeObject, ReadRule } from "../../api";

type Kind = Pick<KindRef, "group" | "kind">;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function coversKind(rule: ReadRule, kind: Kind): boolean {
  if (rule.kinds.type === "all") return true;
  return rule.kinds.kinds.some((k) => same(k.group, kind.group) && same(k.kind, kind.kind));
}

function coversNamespace(rule: ReadRule, namespace: string | null): boolean {
  if (rule.namespaces.type === "all") return true;
  return namespace !== null && namespace.trim() !== "" && rule.namespaces.namespaces.includes(namespace);
}

/** Whether the agent may read an object of `kind` in `namespace` (`null`: without one, or in every namespace). */
export function canRead(reads: readonly ReadRule[], kind: Kind, namespace: string | null): boolean {
  return reads.some((rule) => coversKind(rule, kind) && coversNamespace(rule, namespace));
}

/** The objects of a list of `kind` the agent may read. */
export function readable<T extends KubeObject>(reads: readonly ReadRule[], kind: Kind, items: readonly T[]): T[] {
  return items.filter((o) => canRead(reads, kind, o.metadata?.namespace ?? null));
}

/** An object as the answers name it. */
export interface ObjectName {
  group: string;
  kind: string;
  namespace: string | null;
  name: string;
}

export const objectName = (kind: Kind, namespace: string | null | undefined, name: string): ObjectName => ({
  group: kind.group,
  kind: kind.kind,
  namespace: namespace || null,
  name,
});
