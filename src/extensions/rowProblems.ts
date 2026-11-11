// What an extension's own problem rules say of a table's row (ADR-0169), for a computed column's `problem` case: a
// problem of them stands (counted or still in its grace), they cannot tell (a list a rule looks up is not read in
// full or not watched there, the row's kind is not judged where it is), or they are still reading their lists — as the
// former built-in Traefik view's "References" column did. The column holds the extension's problem sources while it
// is shown (as that view held its store), whether or not the user turned an opt-in category on: the category decides
// what the problems screen, the counter and the notifications show, not what a column may read. Pure but for the hook.
//
//   const read = useRowProblemState(clusterId, extensionId, kind); read(obj)   // "found" | "unknown" | "checking" | undefined
import { useEffect, useMemo } from "react";
import type { ClusterId, KindRef, KubeObject } from "../api";
import type { ProblemCategory } from "../features/problems/model";
import { scopesKnown, useExtensionCategories } from "../features/problems/extensionCategories";
import { useNow, useProblemSources } from "../features/problems/hooks";
import { sourcesOf, type SourceState } from "../features/problems/store";
import { kindKeyOf } from "./problemRules";

export type RowProblemState = "found" | "unknown" | "checking";

/** The categories of an extension among the registered ones: its main one and those of its own (#410). */
export const extensionCategoriesOf = (all: readonly ProblemCategory[], extensionId: string): ProblemCategory[] =>
  all.filter((c) => c === `ext:${extensionId}` || c.startsWith(`ext:${extensionId}:`));

/**
 * The state of `obj` (of `kind`) by the extension's sources in a cluster, at `now`: `found` before anything else, then
 * `checking` while a source lists (or Rust has not said where the rules run), then `unknown`.
 */
export function rowProblemState(
  sources: readonly SourceState[],
  kind: Pick<KindRef, "group" | "kind">,
  obj: KubeObject,
  now: number,
  scopes: boolean,
): RowProblemState | undefined {
  const uid = obj.metadata?.uid;
  if (!uid) return undefined;
  for (const source of sources) {
    for (const p of source.problems) {
      if (p.uid !== uid) continue;
      // Counted or in its grace; not one that only counts later (`activeFrom`) or has ended.
      if ((p.activeFrom === undefined || p.activeFrom <= now) && (p.until === undefined || now < p.until)) return "found";
    }
  }
  if (!scopes || sources.some((s) => s.status === "loading")) return "checking";
  if (sources.some((s) => s.untold?.has(uid))) return "unknown";
  const own = sources.filter((s) => kindKeyOf(s.def.kind) === kindKeyOf(kind));
  // Not judged where it is: no source of its kind (not agreed to, not readable), or none watching its namespace.
  const namespace = obj.metadata?.namespace ?? "";
  const watching = own.filter((s) => s.def.namespaces === undefined || s.def.namespaces.includes(namespace));
  if (watching.length === 0) return "unknown";
  if (watching.some((s) => s.status === "error" || s.truncated)) return "unknown";
  return undefined;
}

/** `rowProblemState` of the sources open now (a filter's value, which has no hook). */
export function rowProblemStateNow(
  clusterId: ClusterId,
  extensionId: string,
  categories: readonly ProblemCategory[],
  kind: Pick<KindRef, "group" | "kind">,
  obj: KubeObject,
): RowProblemState | undefined {
  const own = extensionCategoriesOf(categories, extensionId);
  const sources = sourcesOf(clusterId).filter((s) => own.includes(s.category));
  return rowProblemState(sources, kind, obj, Date.now(), scopesKnown(clusterId, own));
}

/**
 * Holds the extension's problem sources in the cluster while mounted and reads a row's state by them; `onChange` (a
 * filter's observer) is told when they change.
 */
export function useRowProblemState(
  clusterId: ClusterId,
  extensionId: string,
  kind: Pick<KindRef, "group" | "kind">,
  onChange?: () => void,
): (obj: KubeObject) => RowProblemState | undefined {
  const all = useExtensionCategories();
  const key = extensionCategoriesOf(all, extensionId).join(",");
  const categories = useMemo(() => (key === "" ? [] : (key.split(",") as ProblemCategory[])), [key]);
  const sources = useProblemSources(clusterId, categories);
  // Grace periods and ends pass without an update.
  const tick = useNow();
  const scopes = scopesKnown(clusterId, categories);
  const read = useMemo(() => {
    void tick;
    const now = Date.now();
    return (obj: KubeObject) => rowProblemState(sources, kind, obj, now, scopes);
  }, [sources, kind, tick, scopes]);
  useEffect(() => {
    onChange?.();
  }, [read, onChange]);
  return read;
}
