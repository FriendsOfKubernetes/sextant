// Search in resource tables, as in Lens: every word must match. A word with "=" is a selector term: a label term
// (`app=web`, `tier!=db`, `app=` = has the label) or, for a field the API server can filter by (`status.phase=Running`
// on pods, `metadata.name=web`, see `selectors.ts`), a field term; any other word matches part of the name, the
// namespace, a `key=value` label or, in a table, the text of any shown column (status, node, restarts, the age as
// shown, a CRD's printer columns, custom columns; #279), ignoring case. The table also sends the selector terms to the
// API server (`serverSelectors`), so a watch lists only what they keep (#157); matching them here as well keeps the
// rows right while the narrower watch starts.
//
// A table can hold 20 000 rows, so a row's column texts are built once per object (`createRowText`: a cache by object,
// and the watch keeps an unchanged object's identity), lowered and joined into one string a word is looked up in; only
// the texts that change with time (an age) are rebuilt, from translations cached per unit and count.
import type { KubeObject } from "../../api";
import type { ColumnDef, SearchTextContext } from "../../resources/registry";
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
 * lowered once, not per object). `kind` (`group/Kind`) tells which `key=value` terms are fields. `extraText` gives
 * more texts a plain word may match; `rowText` one already lowered text of the row (`createRowText`: the shown
 * columns), which a word may match anywhere within a line.
 */
export function compileSearch(
  query: string,
  kind?: string,
  extraText?: (obj: KubeObject) => readonly string[],
  rowText?: (obj: KubeObject) => string,
): (obj: KubeObject) => boolean {
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
      if (extraText) for (const text of extraText(obj)) if (text.toLowerCase().includes(lower)) return true;
      if (rowText && rowText(obj).includes(lower)) return true;
      return false;
    };
  });
  return (obj) => tests.every((test) => test(obj));
}

/** Whether the search has a plain word (one the column texts may match), not only selector terms. */
export function hasPlainTerms(query: string): boolean {
  return searchTerms(query).some((term) => !selectorTerm(term));
}

/** A row's text for the search: the shown columns' texts, lowered, one per line (a word never spans two columns). */
export interface RowText {
  /** The text of `obj` at `now` (the table's clock; it matters only when `timed`). */
  textOf: (obj: KubeObject, now: number) => string;
  /** A column's text changes with time (an age): the table matches again as its clock ticks. */
  timed: boolean;
}

/** One column's text, or `undefined` when the cell shows nothing a word could match. */
function columnText(column: ColumnDef, obj: KubeObject, ctx: SearchTextContext): string | undefined {
  if (column.searchText) return column.searchText(obj, ctx) ?? undefined;
  const value = column.value(obj);
  if (value === null || value === undefined) return undefined;
  // A number under a renderer is not what the cell shows (container squares, an age drawn from a time).
  if (typeof value === "number" && column.render) return undefined;
  return String(value);
}

/**
 * The row texts of a table with `columns`, cached by object until the columns or the translation change (a new
 * `createRowText`). `t` translates the texts some columns build (an age); its answers are cached by key and count.
 */
export function createRowText(columns: readonly ColumnDef[], t: SearchTextContext["t"]): RowText {
  const fixed = columns.filter((c) => !c.searchTextTimed);
  const timed = columns.filter((c) => c.searchTextTimed);
  const translated = new Map<string, string>();
  const cachedT: SearchTextContext["t"] = (key, options) => {
    if (!options || Object.keys(options).length !== 1 || typeof options.count !== "number") return t(key, options);
    const id = `${key}\u0000${options.count}`;
    let text = translated.get(id);
    if (text === undefined) {
      text = t(key, options);
      translated.set(id, text);
    }
    return text;
  };
  // Per object: the fixed columns' text, and the whole text as of the clock it was built at.
  const texts = new WeakMap<KubeObject, { fixed: string; at: number; whole: string }>();
  const join = (list: readonly ColumnDef[], obj: KubeObject, now: number) => {
    const ctx: SearchTextContext = { now, t: cachedT };
    let out = "";
    for (const column of list) {
      const text = columnText(column, obj, ctx);
      if (text) out += `${text.toLowerCase()}\n`;
    }
    return out;
  };
  return {
    timed: timed.length > 0,
    textOf: (obj, now) => {
      let entry = texts.get(obj);
      if (entry === undefined) {
        const text = join(fixed, obj, now);
        entry = { fixed: text, at: now, whole: timed.length > 0 ? text + join(timed, obj, now) : text };
        texts.set(obj, entry);
      } else if (timed.length > 0 && entry.at !== now) {
        entry.at = now;
        entry.whole = entry.fixed + join(timed, obj, now);
      }
      return entry.whole;
    },
  };
}

function labelsOf(obj: KubeObject): Record<string, string> {
  const labels = obj.metadata?.labels;
  return (labels && typeof labels === "object" ? labels : {}) as Record<string, string>;
}

export function matchesSearch(obj: KubeObject, query: string): boolean {
  return compileSearch(query)(obj);
}
