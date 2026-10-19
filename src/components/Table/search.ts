// Search in resource tables, as in Lens: every word must match. A word with "=" is a selector term: a label term
// (`app=web`, `tier!=db`, `app=` = has the label) or, for a field the API server can filter by (`status.phase=Running`
// on pods, `metadata.name=web`, see `selectors.ts`), a field term; any other word matches part of the name, the
// namespace or a `key=value` label, ignoring case. The table also sends the selector terms to the API server
// (`serverSelectors`), so a watch lists only what they keep (#157); matching them here as well keeps the rows right
// while the narrower watch starts.
import type { KubeObject } from "../../api";
import { fieldValueOf, isFieldKey, selectorTerm } from "./selectors";

/** The words of a search. */
export function searchTerms(query: string): string[] {
  return query
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * The search compiled once for many objects: the predicate a table runs over every row (the terms are split and
 * lowered once, not per object). `kind` (`group/Kind`) tells which `key=value` terms are fields.
 */
export function compileSearch(query: string, kind?: string): (obj: KubeObject) => boolean {
  const terms = searchTerms(query);
  if (terms.length === 0) return () => true;
  const tests = terms.map((term): ((obj: KubeObject) => boolean) => {
    const selector = selectorTerm(term);
    if (selector) {
      const { key, op, value } = selector;
      if (kind !== undefined && isFieldKey(kind, key) && value !== "") {
        return (obj) => (fieldValueOf(obj, kind, key) === value) !== (op === "!=");
      }
      return (obj) => {
        const actual = labelsOf(obj)[key];
        if (op === "!=") return actual !== value;
        if (value === "") return actual !== undefined;
        return actual === value;
      };
    }
    const lower = term.toLowerCase();
    return (obj) => {
      const meta = obj.metadata ?? {};
      if ((meta.name ?? "").toLowerCase().includes(lower)) return true;
      if ((meta.namespace ?? "").toLowerCase().includes(lower)) return true;
      for (const [k, v] of Object.entries(labelsOf(obj))) if (`${k}=${v}`.toLowerCase().includes(lower)) return true;
      return false;
    };
  });
  return (obj) => tests.every((test) => test(obj));
}

function labelsOf(obj: KubeObject): Record<string, string> {
  const labels = obj.metadata?.labels;
  return (labels && typeof labels === "object" ? labels : {}) as Record<string, string>;
}

export function matchesSearch(obj: KubeObject, query: string): boolean {
  return compileSearch(query)(obj);
}
