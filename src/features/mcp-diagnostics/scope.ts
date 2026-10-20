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

/** Namespaces a namespaced view for an agent covers at most (the rules may name more; the rest are left out). */
export const MAX_AGENT_NAMESPACES = 50;

/**
 * The namespaces the agent's rules name (in order, without repeats, at most `MAX_AGENT_NAMESPACES`): where a view
 * watches a kind the agent may not read in every namespace. `truncated`: the rules name more.
 */
export function ruleNamespaces(reads: readonly ReadRule[]): { namespaces: string[]; truncated: boolean } {
  const all = new Set<string>();
  for (const rule of reads) {
    if (rule.namespaces.type === "all") continue;
    for (const ns of rule.namespaces.namespaces) if (ns.trim() !== "") all.add(ns);
  }
  const list = [...all];
  return { namespaces: list.slice(0, MAX_AGENT_NAMESPACES), truncated: list.length > MAX_AGENT_NAMESPACES };
}

/**
 * Where a view for an agent watches `kind`: `null` — in every namespace (the agent may read them all); a list — only
 * there (the asked namespace, else the namespaces of the rules, each one readable); empty — nowhere.
 */
export function watchedNamespaces(
  reads: readonly ReadRule[],
  kind: Kind,
  asked: string | null,
  ruled: readonly string[],
): string[] | null {
  if (!asked && canRead(reads, kind, null)) return null;
  return (asked ? [asked] : ruled).filter((ns) => canRead(reads, kind, ns));
}

/** A list (a kind in a namespace, or in all of them) or one object of it that an answer rests on or names. */
export interface ListRef {
  group: string;
  kind: string;
  namespace: string | null;
  name?: string;
}
