// A source seen from its annotations (#241): which of the cluster's namespaces it may be mirrored to, where Reflector
// keeps automatic mirrors, which mirrors name it and how each is doing. Pure, over the store's lookup.
import type { KubeObject } from "../../api";
import { canAutoReflect, canReflect, judgeMirror, type MirrorJudgement, type NamespaceLabels } from "./judge";
import { reflectionOf, type Reflection, type ReflectedKind } from "./model";
import { patternsReady } from "./patterns";
import type { Lookup } from "./store";

/** Namespaces listed by name in a view at most. */
export const MAX_LISTED_NAMESPACES = 30;

export interface NamespaceSplit {
  yes: string[];
  /** The patterns or the selector cannot be evaluated for these. */
  unknown: string[];
}

function split(names: readonly string[], test: (ns: string) => boolean | undefined): NamespaceSplit {
  const yes: string[] = [];
  const unknown: string[] = [];
  for (const ns of names) {
    const r = test(ns);
    if (r === true) yes.push(ns);
    else if (r === undefined) unknown.push(ns);
  }
  return { yes, unknown };
}

/** The namespaces a mirror of the source may live in, and those Reflector fills automatically (not its own). */
export function targetsOf(source: Reflection, sourceNamespace: string, names: readonly string[], labels: NamespaceLabels): { allowed: NamespaceSplit; auto: NamespaceSplit } {
  return {
    allowed: split(names, (ns) => canReflect(source, ns, labels)),
    auto: split(
      names.filter((ns) => ns !== sourceNamespace),
      (ns) => canAutoReflect(source, ns, labels),
    ),
  };
}

/**
 * The namespaces worth listing for a source's details: its own, then the automatic targets, then the other allowed
 * ones (the store keeps the first `MAX_NAMESPACES`).
 */
export function namespacesToRead(source: Reflection, sourceNamespace: string, names: readonly string[] | undefined, labels: NamespaceLabels): string[] {
  if (!names || !source.allowed) return [sourceNamespace];
  // Until the core has matched the patterns every namespace would be "cannot tell": list nothing more meanwhile.
  if (!patternsReady([source.allowedNamespaces, source.autoNamespaces], names)) return [sourceNamespace];
  const { allowed, auto } = targetsOf(source, sourceNamespace, names, labels);
  return [...new Set([sourceNamespace, ...auto.yes, ...auto.unknown, ...allowed.yes, ...allowed.unknown])];
}

export type ExpectedState = "notCreated" | "conflict";

export interface SourceView {
  reflection: Reflection;
  targets?: { allowed: NamespaceSplit; auto: NamespaceSplit };
  /** The mirrors found in the namespaces read, judged against this source. */
  mirrors: { obj: KubeObject; judgement: MirrorJudgement }[];
  /** Automatic targets read in full where no mirror of it is: none yet, or another object holds the name. */
  expected: { namespace: string; state: ExpectedState }[];
  /** Namespaces it may be mirrored to that were not read. */
  notChecked: string[];
}

export function sourceView(kind: ReflectedKind, obj: KubeObject, lookup: Lookup): SourceView {
  const namespace = obj.metadata?.namespace ?? "";
  const name = obj.metadata?.name ?? "";
  const reflection = reflectionOf(obj);
  const names = lookup.namespaceNames();
  const targets = names ? targetsOf(reflection, namespace, names, lookup.labels) : undefined;
  // The listed object is the one the mirrors are compared with (the same resourceVersion as the details' own).
  const current = lookup.get(kind, namespace, name) ?? obj;
  const mirrors = lookup
    .mirrorsOf(kind, namespace, name)
    .filter((m) => !(m.metadata?.namespace === namespace && m.metadata?.name === name))
    .map((m) => ({ obj: m, judgement: judgeMirror(m, current, lookup.labels)! }))
    .sort((a, b) => (a.obj.metadata?.namespace ?? "").localeCompare(b.obj.metadata?.namespace ?? ""));
  const expected: SourceView["expected"] = [];
  const notChecked: string[] = [];
  const mirrored = new Set(mirrors.map((m) => m.obj.metadata?.namespace ?? ""));
  for (const ns of targets?.auto.yes ?? []) {
    if (mirrored.has(ns)) continue;
    if (!lookup.readIn(kind, ns)) continue;
    expected.push({ namespace: ns, state: lookup.get(kind, ns, name) ? "conflict" : "notCreated" });
  }
  for (const ns of targets ? [...targets.allowed.yes, ...targets.allowed.unknown] : []) if (!lookup.readIn(kind, ns)) notChecked.push(ns);
  return { reflection, ...(targets ? { targets } : {}), mirrors, expected, notChecked };
}
