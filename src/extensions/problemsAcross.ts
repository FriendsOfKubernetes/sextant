// An extension's problem rules across objects (ADR-0144), judged by the window on the problems store's own sources —
// no extension code runs for them. A rule's object-by-object verdict (`problemRules.ts`) is kept only where these hold:
//
// - `missing`: none of the objects its `lookups` name exists. The names come from the rows of the category's source
//   of that kind (the problems store's tap, `SourceDef.judge`); a source that is not read in full (loading, failed,
//   capped), a kind not served or not readable there, or a namespace the source does not watch is "cannot tell", which
//   is no problem.
// - `toldThroughOwner`: the object's controller has no problem of the extension (counted or in its grace).
// - `newestPer`: the object is the newest (by `creationTimestamp`, then by name) of its namespace's objects with the
//   same value of that label; one without the label is judged alone. Until the rows are read, no problem.
//
//   judgeAcross(problems, context, { rules, targets })   // the problems that stand
import type { JudgedNeed, KubeObject, ProblemCondition, ProblemContribution } from "../api";
import {
  evaluate,
  FACT_MARK,
  factKey,
  FOUND_MARK,
  labelSelectorOf,
  MAX_MESSAGE_CHARS,
  MAX_VALUE_CHARS,
  MISSING_MARK,
  numberOf,
  SELECTS_IN_MARK,
  selectingKey,
  selectorMatches,
  valueAt,
  type LabelSelector,
  type Lookup,
  type SelectingLookup,
} from "./problemRules";

/** The extension API whose additions the window applies only to manifests that name it (ADR-0169). */
export const PARITY_API = 5;
import type { JudgedEntry, JudgedRowPart } from "./problemJudges";
import { cleanText } from "../resources/uri";
import { formatList } from "../i18n/format";
import type { Problem } from "../features/problems/model";
import type { JudgeContext, JudgedRows, SourceDef } from "../features/problems/sources";

/** What the store keeps of each object of a judged source. */
export interface AcrossRow {
  namespace: string;
  name: string;
  /** `metadata.creationTimestamp` in ms; `undefined` when it does not parse. */
  created: number | undefined;
  /** What a `newestBy` path reads, the number ranking newest (#404). */
  rank?: number;
  /** The values of the labels `newestPer` names. */
  labels: Record<string, string>;
  /** Whether each `related` condition's own `when` on this kind holds for it (#409), by `factKey`. */
  facts?: Record<string, boolean>;
  /** The texts at the paths a `relatedBy` compares on this kind (#404), by path. */
  values?: Record<string, string>;
  /** `namespace/name` of the objects it names in a `toldThroughReferrer` list (#404), at most `MAX_ROW_REFS`. */
  refs?: string[];
  /** Every label, for a kind a `selectsNone` selects from (#404); at most `MAX_ROW_LABELS`. */
  allLabels?: Record<string, string>;
  /**
   * For a kind whose objects select others (`selectedByNone`, `selectsNone.selectedBy`, ADR-0169): its selectors by
   * `selectingKey` — `selector` `null` selecting nothing; `namespaces` `null` its own namespace, `false` none.
   */
  selectors?: Record<string, SelectorPair>;
  /** For a kind a problem judge reads (ADR-0168): its apiVersion, creation time and the judges' declared paths. */
  judged?: JudgedRowPart;
  /**
   * For a definition kind of a `kindsFrom` (ADR-0137 amendment): the group and kinds it names, as `group/kind`
   * texts, so a change of them makes the window ask Rust again which kinds are defined.
   */
  defines?: string[];
}

/** A selecting object's selectors, as Prometheus Operator reads them (ADR-0169). */
export interface SelectorPair {
  selector: LabelSelector | null;
  namespaces: LabelSelector | null | false;
}

/** The selectors at `selector` and `namespaceSelector` of an object (ADR-0169): a null or missing one as the operator reads it. */
export function selectorPairOf(obj: unknown, selector: string, namespaceSelector: string): SelectorPair {
  const sel = valueAt(obj, selector);
  const ns = valueAt(obj, namespaceSelector);
  return {
    // Null or missing selects nothing; anything but an object nothing too.
    selector: sel === undefined || sel === null ? null : (labelSelectorOf(sel) ?? null),
    // Null or missing: the object's own namespace; anything but an object no namespace.
    namespaces: ns === undefined || ns === null ? null : (labelSelectorOf(ns) ?? false),
  };
}

const isEmptySelector = (s: LabelSelector) => Object.keys(s.matchLabels).length === 0 && s.matchExpressions.length === 0;

/** How a rule names others of its kind (`toldThroughReferrer`, #404). */
export type ReferrerRule = NonNullable<ProblemContribution["toldThroughReferrer"]>;

/** The most references a row keeps for `toldThroughReferrer` (#404). */
export const MAX_ROW_REFS = 200;

/** The most labels a row keeps for `selectsNone` (#404). */
export const MAX_ROW_LABELS = 64;

/** The row of `obj`, keeping only the labels `labelKeys` name and the `facts` the rules ask of its kind (#409). */
export function rowOf(
  labelKeys: readonly string[],
  facts: readonly ProblemCondition[] = [],
  keepLabels = false,
  valuePaths: readonly string[] = [],
  referrers: readonly ReferrerRule[] = [],
  rankPath?: string,
  judgedPaths: readonly string[] = [],
  defines?: { groupPath: string; kindPaths: readonly string[] },
  selecting: readonly { selector: string; namespaceSelector: string }[] = [],
): (obj: KubeObject) => AcrossRow {
  return (obj) => {
    const meta = (obj.metadata ?? {}) as { name?: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, unknown> };
    const all = meta.labels ?? {};
    const labels: Record<string, string> = {};
    for (const key of labelKeys) {
      const value = all[key];
      if (typeof value === "string") labels[key] = value;
    }
    const created = Date.parse(meta.creationTimestamp ?? "");
    const row: AcrossRow = { namespace: meta.namespace ?? "", name: meta.name ?? "", created: Number.isNaN(created) ? undefined : created, labels };
    if (facts.length > 0) row.facts = Object.fromEntries(facts.map((when) => [factKey(when), evaluate(when, obj).holds]));
    if (rankPath !== undefined) {
      const rank = numberOf(valueAt(obj, rankPath));
      if (rank !== undefined) row.rank = rank;
    }
    if (referrers.length > 0) {
      const refs = new Set<string>();
      for (const { path, alsoPaths, namePath, namespacePath } of referrers) {
        // Each path a list, or one object read as a list of one (`.spec.tcpproxy.include`, #404).
        const items = [path, ...(alsoPaths ?? [])].flatMap((p) => {
          const v = valueAt(obj, p);
          return Array.isArray(v) ? v : v !== null && typeof v === "object" ? [v] : [];
        });
        for (const item of items) {
          const name = valueAt(item, namePath);
          const ns = namespacePath === undefined ? undefined : valueAt(item, namespacePath);
          if (typeof name !== "string" || name === "") continue;
          refs.add(`${typeof ns === "string" && ns !== "" ? ns : (meta.namespace ?? "")}/${name}`);
          if (refs.size >= MAX_ROW_REFS) break;
        }
      }
      row.refs = [...refs];
    }
    if (valuePaths.length > 0) {
      row.values = {};
      for (const path of valuePaths) {
        const value = valueAt(obj, path);
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") row.values[path] = String(value);
      }
    }
    if (judgedPaths.length > 0) {
      // Only the values of the paths the judges declare (ADR-0168), read as rules read them.
      const values: Record<string, unknown> = {};
      for (const path of judgedPaths) {
        const value = valueAt(obj, path);
        if (value !== undefined) values[path] = value;
      }
      row.judged = {
        apiVersion: typeof obj.apiVersion === "string" ? obj.apiVersion : "",
        ...(meta.creationTimestamp ? { creationTimestamp: meta.creationTimestamp } : {}),
        values,
      };
    }
    if (defines) {
      const group = valueAt(obj, defines.groupPath);
      row.defines = defines.kindPaths.map((path) => {
        const kind = valueAt(obj, path);
        return `${typeof group === "string" ? group : ""}/${typeof kind === "string" ? kind : ""}`;
      });
    }
    if (selecting.length > 0) {
      row.selectors = Object.fromEntries(selecting.map(({ selector, namespaceSelector }) => [selectingKey(selector, namespaceSelector), selectorPairOf(obj, selector, namespaceSelector)]));
    }
    if (keepLabels) {
      row.allLabels = Object.fromEntries(
        Object.entries(all)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .slice(0, MAX_ROW_LABELS),
      );
    }
    return row;
  };
}

/** A kind a `missing` condition looks up, with the source whose rows hold its names. */
export interface AcrossTarget {
  group: string;
  kind: string;
  namespaced: boolean;
  def: SourceDef;
}

export interface AcrossRules {
  /** The extension's rules by id (a problem's `group`). */
  rules: ReadonlyMap<string, ProblemContribution>;
  targets: readonly AcrossTarget[];
  /**
   * Whether the cluster serves a kind (discovery said), for a `missing` with `alsoKinds` (ADR-0169): a kind it does not
   * serve has no objects. Without it every kind counts as served (a kind without a target cannot tell).
   */
  served?: (kind: { group: string; kind: string }) => boolean;
  /** The extension's `sextantApi`: from 5 `{{missing}}` names what a plain `missing` did not find too (ADR-0169). */
  api?: number;
  /**
   * The texts of a judge's fact for an object by the judge's latest answer (ADR-0168), `null` when it gives none or
   * cannot tell; and what the judge read (each kind and the namespaces its source watched).
   */
  judges?: {
    fact(judge: string, fact: string, uid: string): Record<string, string> | null;
    reads(judge: string): NonNullable<NonNullable<Lookup["judged"]>["reads"]>;
    /** Every entry of the fact for the object (a rule judged `each`, ADR-0168 amendment); `null` when none or cannot tell. */
    entries?(judge: string, fact: string, uid: string): readonly JudgedEntry[] | null;
  };
}

const usable = (rows: JudgedRows | undefined): rows is JudgedRows =>
  rows !== undefined && (rows.status === "ready" || rows.status === "reconnecting") && !rows.truncated;

const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) =>
  a.group.toLowerCase() === b.group.toLowerCase() && a.kind.toLowerCase() === b.kind.toLowerCase();

/**
 * The problems of `problems` that stand once the rows of the cluster say what their rules look up. `untold` gets the
 * uids of the objects whose problems the rows cannot tell yet (a list not read in full, not served where it must be,
 * not watched there): a table's `problem` case says "cannot tell" for them (ADR-0169).
 */
export function judgeAcross(
  problems: readonly Problem[],
  context: JudgeContext,
  { rules, targets, judges, served, api }: AcrossRules,
  untold?: Set<string>,
): Problem[] {
  // Rows per target by `namespace/name`, built once per look.
  const names = new Map<AcrossTarget, Map<string, AcrossRow> | null>();
  const namesOf = (target: AcrossTarget): Map<string, AcrossRow> | null => {
    if (!names.has(target)) {
      const rows = context.target(target.def);
      names.set(target, usable(rows) ? new Map([...rows.rows.values()].map((r) => [`${(r as AcrossRow).namespace}/${(r as AcrossRow).name}`, r as AcrossRow])) : null);
    }
    return names.get(target)!;
  };
  /** The labels of a Namespace by its rows (ADR-0169); `undefined` when they cannot tell. */
  const namespaceLabels = (name: string): Record<string, string> | undefined => {
    if (served !== undefined && !served({ group: "", kind: "Namespace" })) return undefined;
    const target = targets.find((t) => sameKind(t, { group: "", kind: "Namespace" }));
    const known = target ? namesOf(target) : null;
    return known?.get(`/${name}`)?.allLabels;
  };
  /**
   * The rows of the objects that select a judged object (`selectedByNone`, `selectsNone.selectedBy`, ADR-0169), and how
   * many objects of their kinds there are; `undefined` when the rows cannot tell — a list not read in full or not of
   * every namespace, a selector not kept, a Namespace's labels needed and unknown — and none was found selecting it.
   */
  const selecting = (by: SelectingLookup): { rows: AcrossRow[]; total: number } | undefined => {
    let unknown = false;
    let total = 0;
    const rows: AcrossRow[] = [];
    const key = selectingKey(by.selector, by.namespaceSelector);
    for (const kind of by.kinds) {
      // Not served: no objects of it.
      if (served !== undefined && !served(kind)) continue;
      const target = targets.find((t) => sameKind(t, kind));
      const known = target ? namesOf(target) : null;
      // Every namespace: an object anywhere may select it.
      if (!target || !known || (target.namespaced && context.target(target.def)?.namespaces !== null)) {
        unknown = true;
        continue;
      }
      for (const row of known.values()) {
        total += 1;
        const pair = row.selectors?.[key];
        if (pair === undefined) {
          unknown = true;
          continue;
        }
        if (pair.selector === null || !selectorMatches(pair.selector, by.labels)) continue;
        if (pair.namespaces === false) continue;
        if (pair.namespaces === null) {
          // Its own namespace only.
          if (row.namespace !== by.namespace) continue;
        } else if (!isEmptySelector(pair.namespaces)) {
          const labels = namespaceLabels(by.namespace);
          if (labels === undefined) {
            unknown = true;
            continue;
          }
          if (!selectorMatches(pair.namespaces, labels)) continue;
        }
        rows.push(row);
      }
    }
    if (rows.length > 0) return { rows, total };
    return unknown ? undefined : { rows, total };
  };
  /**
   * Where a `selectsNone` looks (ADR-0169): as written, unless the objects that select it (`by`, all of them known)
   * narrow it — every one with `ownNamespaceWhen` holding: its own namespace only; some: its own too.
   */
  const lookedIn = (selects: NonNullable<Lookup["selects"]>): string[] | null => {
    const sorted = (names: Iterable<string>) => [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const written = selects.namespaces === null ? null : sorted(selects.namespaces);
    if (!selects.by || selects.own === undefined) return written;
    const found = selecting(selects.by);
    if (!found || found.rows.length === 0) return written;
    const fact = selects.by.fact;
    const narrowing = found.rows.filter((row) => fact !== undefined && row.facts?.[fact] === true).length;
    if (narrowing === found.rows.length) return [selects.own];
    if (narrowing === 0 || written === null) return written;
    return sorted([...written, selects.own]);
  };
  /** Whether one lookup holds: `missing` not there, `related` there with its fact, … (`false`: cannot tell, or not). */
  const holds = (p: Problem, lookup: NonNullable<Problem["lookups"]>[number]): boolean => tell(p, lookup) === true;
  /**
   * `missing` with `alsoKinds` (ADR-0169): not there in any kind the cluster serves (one it does not serve has no
   * objects); `undefined` while a served kind's list cannot tell.
   */
  const missingInAll = (p: Problem, lookup: NonNullable<Problem["lookups"]>[number]): boolean | undefined => {
    let unknown = false;
    for (const kind of [lookup, ...(lookup.also ?? [])]) {
      // Not served: no objects of it.
      if (served !== undefined && !served(kind)) continue;
      const target = targets.find((t) => sameKind(t, kind));
      if (!target) {
        unknown = true;
        continue;
      }
      const known = namesOf(target);
      const watched = context.target(target.def)?.namespaces;
      const namespace = target.namespaced ? (lookup.namespace ?? p.object.namespace ?? "") : "";
      if (known?.has(`${namespace}/${lookup.name}`)) return false;
      if (!known || (target.namespaced && watched !== null && !watched?.includes(namespace))) unknown = true;
    }
    return unknown ? undefined : true;
  };
  /** Whether one lookup holds; `undefined` when the rows cannot tell (a list not read in full, not watched there). */
  const tell = (p: Problem, lookup: NonNullable<Problem["lookups"]>[number]): boolean | undefined => {
    // `judged` (ADR-0168) is told apart, by `factsOf`.
    if (lookup.judged) return true;
    // `selectedByNone` (ADR-0169): some object of the kinds exists and none selects it.
    if (lookup.selectedBy) {
      const found = selecting(lookup.selectedBy);
      if (!found) return undefined;
      return found.rows.length === 0 && found.total > 0;
    }
    if (lookup.also !== undefined) return missingInAll(p, lookup);
    {
      const target = targets.find((t) => sameKind(t, lookup));
      if (!target) return undefined;
      const known = namesOf(target);
      if (!known) return undefined;
      const watched = context.target(target.def)?.namespaces;
      // `selectsNone` (#404): no row in the namespaces it covers has labels its selector picks; a source that does not
      // watch all of them cannot tell.
      if (lookup.selects) {
        const { selector } = lookup.selects;
        // Where the objects that select it make it look (ADR-0169), else as written.
        const namespaces = lookup.selects.by ? lookedIn(lookup.selects) : lookup.selects.namespaces;
        // Every namespace and judged only where named (`namedOnly`): not judged.
        if (namespaces === null && lookup.selects.namedOnly === true) return false;
        if (target.namespaced && watched !== null && (namespaces === null || namespaces.some((ns) => !watched?.includes(ns)))) return undefined;
        for (const row of known.values()) {
          if (target.namespaced && namespaces !== null && !namespaces.includes(row.namespace)) continue;
          if (row.allLabels === undefined) return undefined;
          if (selectorMatches(selector, row.allLabels)) return false;
        }
        return true;
      }
      const namespace = target.namespaced ? (lookup.namespace ?? p.object.namespace ?? "") : "";
      // `relatedBy` (#404): a row of the namespace holding every text, with its fact holding.
      if (lookup.by) {
        if (target.namespaced && watched !== null && !watched?.includes(namespace)) return undefined;
        return relatedRows(p, lookup).length > 0;
      }
      if (target.namespaced && watched !== null && !watched?.includes(namespace)) return undefined;
      const row = known.get(`${namespace}/${lookup.name}`);
      // `related` (#409): there, with its fact holding; `missing`: not there.
      if (lookup.fact !== undefined) return row?.facts?.[lookup.fact] === true;
      return row === undefined;
    }
  };
  /** The rows a `relatedBy` finds: of the namespace, holding every text, with its fact; none while it cannot tell. */
  const relatedRows = (p: Problem, lookup: NonNullable<Problem["lookups"]>[number]): AcrossRow[] => {
    const target = targets.find((t) => sameKind(t, lookup));
    const known = target ? namesOf(target) : null;
    if (!target || !known || !lookup.by) return [];
    const watched = context.target(target.def)?.namespaces;
    const namespace = target.namespaced ? (lookup.namespace ?? p.object.namespace ?? "") : "";
    if (target.namespaced && watched !== null && !watched?.includes(namespace)) return [];
    const by = lookup.by;
    return [...known.values()].filter(
      (row) =>
        (!target.namespaced || row.namespace === namespace) &&
        by.every(([path, value]) => row.values?.[path] === value) &&
        (lookup.fact === undefined || row.facts?.[lookup.fact] === true),
    );
  };
  /** The names the `related` and `relatedBy` lookups found (`{{found}}`), each once, in their order. */
  const foundNames = (p: Problem): string[] => {
    const out: string[] = [];
    const shown = (namespace: string | undefined, name: string) => (namespace && namespace !== p.object.namespace ? `${namespace}/${name}` : name);
    for (const lookup of p.lookups ?? []) {
      if (lookup.by) for (const row of relatedRows(p, lookup)) out.push(shown(row.namespace, row.name));
      else if (lookup.fact !== undefined && holds(p, lookup)) out.push(shown(lookup.namespace, lookup.name));
    }
    return [...new Set(out)];
  };
  /**
   * The names a problem's lookups found missing, when its lookups hold: each plain one, and of each `missing` of a
   * list (#404) at least one; `null` when they do not.
   */
  const missingNames = (p: Problem): string[] | null => {
    const lists = new Map<string, string[]>();
    /** The lists some of whose lookups cannot tell. */
    const unsure = new Set<string>();
    const plain: string[] = [];
    // The namespace only when it is not the object's own (#404).
    const shown = (lookup: NonNullable<Problem["lookups"]>[number]) =>
      lookup.namespace && lookup.namespace !== p.object.namespace ? `${lookup.namespace}/${lookup.name}` : lookup.name;
    for (const lookup of p.lookups ?? []) {
      const told = tell(p, lookup);
      if (lookup.anyOf === undefined) {
        if (told === undefined) untold?.add(p.uid);
        if (told !== true) return null;
        // From sextantApi 5 `{{missing}}` names it too, with its namespace (ADR-0169).
        if ((api ?? 0) >= PARITY_API && lookup.fact === undefined && !lookup.by && !lookup.selects && !lookup.selectedBy && !lookup.judged) plain.push(shown(lookup));
        continue;
      }
      const found = lists.get(lookup.anyOf) ?? [];
      if (told === true) found.push(shown(lookup));
      else if (told === undefined) unsure.add(lookup.anyOf);
      lists.set(lookup.anyOf, found);
    }
    for (const [key, found] of lists) {
      if (found.length > 0) continue;
      if (unsure.has(key)) untold?.add(p.uid);
      return null;
    }
    return [...new Set([...plain, ...[...lists.values()].flat()])];
  };

  let newest: Map<string, string> | null | undefined;
  /** `namespace|label|value` → the uid of the newest object with it; `null` while the rows are not read in full. */
  const newestOf = (): Map<string, string> | null => {
    if (newest !== undefined) return newest;
    const rows = context.rows;
    if (!usable(rows)) return (newest = null);
    const keys = new Set([...rules.values()].flatMap((r) => (r.newestPer ? [r.newestPer] : [])));
    const best = new Map<string, { uid: string; row: AcrossRow }>();
    for (const [uid, value] of rows.rows) {
      const row = value as AcrossRow;
      for (const key of keys) {
        const label = row.labels[key];
        if (label === undefined) continue;
        const slot = `${row.namespace}|${key}|${label}`;
        const held = best.get(slot);
        if (!held || newer(row, held.row)) best.set(slot, { uid, row });
      }
    }
    return (newest = new Map([...best].map(([slot, { uid }]) => [slot, uid])));
  };
  const isNewest = (p: Problem, key: string): boolean => {
    const index = newestOf();
    const row = context.rows?.rows.get(p.uid) as AcrossRow | undefined;
    if (!index || !row) {
      untold?.add(p.uid);
      return false;
    }
    const label = row.labels[key];
    return label === undefined || index.get(`${row.namespace}|${key}|${label}`) === p.uid;
  };

  // Who names whom (`toldThroughReferrer`, #404), built once from the source's own rows: `namespace/name` → referrers.
  let referrers: Map<string, AcrossRow[]> | null | undefined;
  const referrersIndex = (): Map<string, AcrossRow[]> | null => {
    if (referrers !== undefined) return referrers;
    const rows = context.rows;
    if (!usable(rows)) return (referrers = null);
    const out = new Map<string, AcrossRow[]>();
    for (const value of rows.rows.values()) {
      const row = value as AcrossRow;
      for (const ref of row.refs ?? []) out.set(ref, [...(out.get(ref) ?? []), row]);
    }
    return (referrers = out);
  };
  /** Whether an object of its kind naming `p`'s object, directly or through others, holds the rule's `when`. */
  const toldByReferrer = (p: Problem, ref: ReferrerRule): boolean => {
    const index = referrersIndex();
    // Not read in full: cannot tell, so not told on its own either.
    if (!index) {
      untold?.add(p.uid);
      return true;
    }
    const fact = factKey(ref.when);
    const start = `${p.object.namespace ?? ""}/${p.object.name}`;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      for (const parent of index.get(queue.shift()!) ?? []) {
        const key = `${parent.namespace}/${parent.name}`;
        if (seen.has(key)) continue;
        if (parent.facts?.[fact] === true) return true;
        seen.add(key);
        queue.push(key);
      }
    }
    return false;
  };

  return problems.flatMap((p) => {
    // By the rule that found it, never by its group: a group may name no rule, and then its lookups would be skipped.
    const rule = rules.get(p.rule ?? p.group ?? "");
    if (!rule) return [p];
    if (rule.toldThroughReferrer && toldByReferrer(p, rule.toldThroughReferrer)) return [];
    if (p.ownerUid !== undefined && context.problemUids().has(p.ownerUid)) return [];
    const names = p.lookups ? missingNames(p) : [];
    if (names === null) return [];
    if (rule.newestPer !== undefined && !isNewest(p, rule.newestPer)) return [];
    // A rule judged `each` (ADR-0168 amendment): one problem per entry of the fact, told apart by its texts.
    if (rule.when.type === "judged" && rule.when.each === true) return eachJudged(p, rule.when, judges);
    const facts = judgedFacts(p, judges);
    if (facts === null) return [];
    let out = p;
    // `{{missing}}` (#404): the names a `missing` of a list did not find, in the UI language's list.
    if (out.message?.includes(MISSING_MARK)) out = { ...out, message: out.message.split(MISSING_MARK).join(formatList(names)) };
    // `{{selectsNone:namespaces}}` (ADR-0169): where its `selectsNone` looked, sorted, in the UI language's list.
    if (out.message?.includes(SELECTS_IN_MARK)) {
      const selects = (p.lookups ?? []).find((l) => l.selects)?.selects;
      out = { ...out, message: out.message.split(SELECTS_IN_MARK).join(formatList(selects ? (lookedIn(selects) ?? []) : [])) };
    }
    // `{{found}}` (ADR-0167 amendment): the objects a `related` or `relatedBy` found, an HPA fighting a VPA.
    if (out.message?.includes(FOUND_MARK)) out = { ...out, message: out.message.split(FOUND_MARK).join(formatList(foundNames(out))) };
    if (facts.judged) out = { ...out, lookups: facts.lookups, ...(out.message !== undefined ? { message: withFacts(out.message, facts.values) } : {}) };
    return [out];
  });
}

/**
 * Whether the `judged` lookups of a problem hold by the judges' latest answers (ADR-0168): the texts of their facts
 * and the lookups marked with what each judge read; `null` when one does not hold or cannot tell.
 */
function judgedFacts(
  p: Problem,
  judges: AcrossRules["judges"],
): { judged: boolean; values: Record<string, string>; lookups: Lookup[] | undefined } | null {
  const lookups = p.lookups as Lookup[] | undefined;
  if (!lookups?.some((l) => l.judged)) return { judged: false, values: {}, lookups };
  if (!judges) return null;
  const values: Record<string, string> = {};
  const marked: Lookup[] = [];
  for (const lookup of lookups) {
    if (!lookup.judged) {
      marked.push(lookup);
      continue;
    }
    const given = judges.fact(lookup.judged.judge, lookup.judged.fact, p.uid);
    if (given === null) return null;
    for (const [name, text] of Object.entries(given)) values[name] ??= text;
    // What the first entry rests on, when its fact says (`needs`): what an agent must be able to read.
    const needs = judges.entries?.(lookup.judged.judge, lookup.judged.fact, p.uid)?.[0]?.needs;
    marked.push({ ...lookup, judged: { ...lookup.judged, reads: judges.reads(lookup.judged.judge), ...needsOf(needs) } });
  }
  return { judged: true, values, lookups: marked };
}

/**
 * The problems of a rule judged `each`: one per entry the judge's latest answer gives of its fact for the object,
 * each with its texts in the message, keyed (and notified) by them, and dated from when the entry first came where
 * the object says no time; none when the judge gives none or cannot tell.
 */
function eachJudged(p: Problem, when: { judge: string; fact: string }, judges: AcrossRules["judges"]): Problem[] {
  const entries = judges?.entries?.(when.judge, when.fact, p.uid) ?? null;
  if (!judges || entries === null) return [];
  const lookups = (p.lookups ?? []).map((lookup) =>
    lookup.judged ? { ...lookup, judged: { ...lookup.judged, reads: judges.reads(lookup.judged.judge) } } : lookup,
  );
  return entries.map((entry) => {
    const id = entryId(entry.key);
    // Each finding rests on what its own entry says (`needs`).
    const own = entry.needs === undefined ? lookups : lookups.map((l) => (l.judged ? { ...l, judged: { ...l.judged, ...needsOf(entry.needs) } } : l));
    // Later than the object: it began when the judge first gave it.
    const shift = p.since === undefined ? Math.max(0, entry.since - p.firstSeen) : 0;
    return {
      ...p,
      key: `${p.key}|${id}`,
      notifyKey: `${p.notifyKey}|${id}`,
      lookups: own,
      firstSeen: p.firstSeen + shift,
      activeAt: p.activeAt + shift,
      ...(p.message !== undefined ? { message: withFacts(p.message, entry.values) } : {}),
    };
  });
}

/** A judged lookup's `needs` from a fact entry's (`group`, `kind`, `namespace`, `name`), none when it said none. */
function needsOf(needs: readonly JudgedNeed[] | undefined): { needs?: NonNullable<Lookup["judged"]>["needs"] } {
  if (needs === undefined) return {};
  return {
    needs: needs.map((n) => ({
      group: n.kind.group,
      kind: n.kind.kind,
      ...(n.namespace !== undefined ? { namespace: n.namespace } : {}),
      ...(n.name !== undefined ? { name: n.name } : {}),
    })),
  };
}

/** A short stable id of an entry's key (53-bit FNV/cyrb-style hash in base 36). */
export function entryId(key: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A message with each `{{fact:<name>}}` filled from `values` (cleaned and clipped; nothing for a missing one). */
function withFacts(message: string, values: Readonly<Record<string, string>>): string {
  const filled = message.replace(FACT_MARK, (_, name: string) => {
    const text = cleanText(values[name] ?? "") ?? "";
    const chars = Array.from(text);
    return chars.length > MAX_VALUE_CHARS ? `${chars.slice(0, MAX_VALUE_CHARS).join("")}…` : text;
  });
  const chars = Array.from(filled);
  return chars.length > MAX_MESSAGE_CHARS ? `${chars.slice(0, MAX_MESSAGE_CHARS).join("")}…` : filled;
}

/** `a` is newer than `b`: created later, or at the same time (or both unknown) with a later name. */
function newer(a: AcrossRow, b: AcrossRow): boolean {
  // `newestBy` (#404): the larger number, where both have one.
  if (a.rank !== undefined && b.rank !== undefined && a.rank !== b.rank) return a.rank > b.rank;
  const at = a.created ?? -Infinity;
  const bt = b.created ?? -Infinity;
  return at !== bt ? at > bt : a.name > b.name;
}

/** Whether a rule needs the rows of other objects: `missing`, `toldThroughOwner`, `newestPer`, or a judge's answer. */
export function judgedAcross(rule: ProblemContribution): boolean {
  return (
    rule.toldThroughOwner ||
    rule.toldThroughReferrer !== undefined ||
    rule.newestPer !== undefined ||
    lookedUp(rule.when).length > 0 ||
    judgesOf(rule.when).length > 0
  );
}

/** The judges a condition's `judged` conditions name (ADR-0168), each once. */
export function judgesOf(condition: ProblemCondition): string[] {
  if (condition.type === "judged") return [condition.judge];
  if (condition.type === "all" || condition.type === "any") return [...new Set(condition.of.flatMap(judgesOf))];
  if (condition.type === "not") return judgesOf(condition.of);
  return [];
}

/** The kinds a condition looks up (`missing`, with its `alsoKinds`). */
export function lookedUp(condition: ProblemContribution["when"]): { group: string; kind: string }[] {
  if (condition.type === "missing") return [condition.kind, ...(condition.alsoKinds ?? [])];
  if (condition.type === "related" || condition.type === "relatedBy") return [condition.kind];
  // The objects that select, and the Namespaces whose labels their namespace selectors match (ADR-0169).
  if (condition.type === "selectsNone") {
    const by = condition.selectedBy;
    return by === undefined ? [condition.kind] : [condition.kind, by.kind, ...(by.alsoKinds ?? []), NAMESPACE];
  }
  if (condition.type === "selectedByNone") return [condition.kind, ...(condition.alsoKinds ?? []), NAMESPACE];
  if (condition.type === "all" || condition.type === "any") return condition.of.flatMap(lookedUp);
  return [];
}

/** The Namespaces, looked up for their labels (ADR-0169). */
const NAMESPACE = { group: "", kind: "Namespace" };

/**
 * The `group/kind` keys (by `keyOf`) a `selectsNone` of `rules` selects from, and the Namespaces a namespace selector
 * matches (ADR-0169): their rows keep every label (#404).
 */
export function selectedKinds(rules: readonly ProblemContribution[], keyOf: (kind: { group: string; kind: string }) => string): Set<string> {
  const out = new Set<string>();
  const visit = (condition: ProblemCondition) => {
    if (condition.type === "selectsNone") {
      out.add(keyOf(condition.kind));
      if (condition.selectedBy) out.add(keyOf(NAMESPACE));
    } else if (condition.type === "selectedByNone") out.add(keyOf(NAMESPACE));
    else if (condition.type === "all" || condition.type === "any") condition.of.forEach(visit);
  };
  for (const rule of rules) visit(rule.when);
  return out;
}

/** The paths `relatedBy` compares on each kind, by the `group/kind` key (`keyOf`) it names (#404). */
export function comparedPaths(rules: readonly ProblemContribution[], keyOf: (kind: { group: string; kind: string }) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const visit = (condition: ProblemCondition) => {
    if (condition.type === "relatedBy") {
      const key = keyOf(condition.kind);
      out.set(key, [...new Set([...(out.get(key) ?? []), ...condition.pairs.map((p) => p.theirs)])]);
    } else if (condition.type === "all" || condition.type === "any") condition.of.forEach(visit);
  };
  for (const rule of rules) visit(rule.when);
  return out;
}

/**
 * The `related` conditions' own `when`s of `rules`, and a `selectsNone.selectedBy`'s `ownNamespaceWhen` (ADR-0169), by
 * the `group/kind` (lower case) they name (#409).
 */
export function factsOf(rules: readonly ProblemContribution[], keyOf: (kind: { group: string; kind: string }) => string): Map<string, ProblemCondition[]> {
  const out = new Map<string, ProblemCondition[]>();
  const add = (kind: { group: string; kind: string }, when: ProblemCondition) => {
    const key = keyOf(kind);
    const list = out.get(key) ?? [];
    if (!list.some((c) => factKey(c) === factKey(when))) list.push(when);
    out.set(key, list);
  };
  const visit = (condition: ProblemCondition) => {
    if (condition.type === "related" || condition.type === "relatedBy") add(condition.kind, condition.when);
    else if (condition.type === "selectsNone" && condition.selectedBy) {
      const by = condition.selectedBy;
      for (const kind of [by.kind, ...(by.alsoKinds ?? [])]) add(kind, by.ownNamespaceWhen);
    } else if (condition.type === "all" || condition.type === "any") condition.of.forEach(visit);
  };
  for (const rule of rules) {
    visit(rule.when);
    // A referrer's `when` is a fact of the rule's own kind (#404).
    const told = rule.toldThroughReferrer;
    if (told) {
      const key = keyOf(rule.kind);
      const list = out.get(key) ?? [];
      if (!list.some((c) => factKey(c) === factKey(told.when))) list.push(told.when);
      out.set(key, list);
    }
  }
  return out;
}

/**
 * The selector paths the objects of each kind select others by (`selectedByNone`, `selectsNone.selectedBy`, ADR-0169),
 * by the `group/kind` key (`keyOf`): their rows keep those selectors.
 */
export function selectingPaths(
  rules: readonly ProblemContribution[],
  keyOf: (kind: { group: string; kind: string }) => string,
): Map<string, { selector: string; namespaceSelector: string }[]> {
  const out = new Map<string, { selector: string; namespaceSelector: string }[]>();
  const add = (kinds: readonly { group: string; kind: string }[], selector: string, namespaceSelector: string) => {
    for (const kind of kinds) {
      const key = keyOf(kind);
      const list = out.get(key) ?? [];
      if (!list.some((p) => p.selector === selector && p.namespaceSelector === namespaceSelector)) list.push({ selector, namespaceSelector });
      out.set(key, list);
    }
  };
  const visit = (condition: ProblemCondition) => {
    if (condition.type === "selectedByNone") add([condition.kind, ...(condition.alsoKinds ?? [])], condition.selector, condition.namespaceSelector);
    else if (condition.type === "selectsNone" && condition.selectedBy) {
      const by = condition.selectedBy;
      add([by.kind, ...(by.alsoKinds ?? [])], by.selector, by.namespaceSelector);
    } else if (condition.type === "all" || condition.type === "any") condition.of.forEach(visit);
  };
  for (const rule of rules) visit(rule.when);
  return out;
}

/** The `toldThroughReferrer`s of `rules`, by the `group/kind` key (`keyOf`) of their own kind (#404). */
export function referrersOf(rules: readonly ProblemContribution[], keyOf: (kind: { group: string; kind: string }) => string): Map<string, ReferrerRule[]> {
  const out = new Map<string, ReferrerRule[]>();
  for (const rule of rules) {
    if (!rule.toldThroughReferrer) continue;
    const key = keyOf(rule.kind);
    out.set(key, [...(out.get(key) ?? []), rule.toldThroughReferrer]);
  }
  return out;
}
