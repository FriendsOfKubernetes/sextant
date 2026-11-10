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
import type { KubeObject, ProblemCondition, ProblemContribution } from "../api";
import { evaluate, factKey, selectorMatches, valueAt } from "./problemRules";
import type { Problem } from "../features/problems/model";
import type { JudgeContext, JudgedRows, SourceDef } from "../features/problems/sources";

/** What the store keeps of each object of a judged source. */
export interface AcrossRow {
  namespace: string;
  name: string;
  /** `metadata.creationTimestamp` in ms; `undefined` when it does not parse. */
  created: number | undefined;
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
}

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
    if (referrers.length > 0) {
      const refs = new Set<string>();
      for (const { path, namePath, namespacePath } of referrers) {
        const items = valueAt(obj, path);
        for (const item of Array.isArray(items) ? items : []) {
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
}

const usable = (rows: JudgedRows | undefined): rows is JudgedRows =>
  rows !== undefined && (rows.status === "ready" || rows.status === "reconnecting") && !rows.truncated;

const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) =>
  a.group.toLowerCase() === b.group.toLowerCase() && a.kind.toLowerCase() === b.kind.toLowerCase();

/** The problems of `problems` that stand once the rows of the cluster say what their rules look up. */
export function judgeAcross(problems: readonly Problem[], context: JudgeContext, { rules, targets }: AcrossRules): Problem[] {
  // Rows per target by `namespace/name`, built once per look.
  const names = new Map<AcrossTarget, Map<string, AcrossRow> | null>();
  const namesOf = (target: AcrossTarget): Map<string, AcrossRow> | null => {
    if (!names.has(target)) {
      const rows = context.target(target.def);
      names.set(target, usable(rows) ? new Map([...rows.rows.values()].map((r) => [`${(r as AcrossRow).namespace}/${(r as AcrossRow).name}`, r as AcrossRow])) : null);
    }
    return names.get(target)!;
  };
  const missing = (p: Problem): boolean =>
    (p.lookups ?? []).every((lookup) => {
      const target = targets.find((t) => sameKind(t, lookup));
      if (!target) return false;
      const known = namesOf(target);
      if (!known) return false;
      const watched = context.target(target.def)?.namespaces;
      // `selectsNone` (#404): no row in the namespaces it covers has labels its selector picks; a source that does not
      // watch all of them cannot tell.
      if (lookup.selects) {
        const { selector, namespaces } = lookup.selects;
        if (target.namespaced && watched !== null && (namespaces === null || namespaces.some((ns) => !watched?.includes(ns)))) return false;
        for (const row of known.values()) {
          if (target.namespaced && namespaces !== null && !namespaces.includes(row.namespace)) continue;
          if (row.allLabels === undefined) return false;
          if (selectorMatches(selector, row.allLabels)) return false;
        }
        return true;
      }
      const namespace = target.namespaced ? (p.object.namespace ?? "") : "";
      // `relatedBy` (#404): a row of the namespace holding every text, with its fact holding.
      if (lookup.by) {
        if (target.namespaced && watched !== null && !watched?.includes(namespace)) return false;
        const by = lookup.by;
        return [...known.values()].some(
          (row) =>
            (!target.namespaced || row.namespace === namespace) &&
            by.every(([path, value]) => row.values?.[path] === value) &&
            (lookup.fact === undefined || row.facts?.[lookup.fact] === true),
        );
      }
      if (target.namespaced && watched !== null && !watched?.includes(namespace)) return false;
      const row = known.get(`${namespace}/${lookup.name}`);
      // `related` (#409): there, with its fact holding; `missing`: not there.
      if (lookup.fact !== undefined) return row?.facts?.[lookup.fact] === true;
      return row === undefined;
    });

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
    if (!index || !row) return false;
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
    if (!index) return true;
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

  return problems.filter((p) => {
    // By the rule that found it, never by its group: a group may name no rule, and then its lookups would be skipped.
    const rule = rules.get(p.rule ?? p.group ?? "");
    if (!rule) return true;
    if (rule.toldThroughReferrer && toldByReferrer(p, rule.toldThroughReferrer)) return false;
    if (p.ownerUid !== undefined && context.problemUids().has(p.ownerUid)) return false;
    if (p.lookups && !missing(p)) return false;
    if (rule.newestPer !== undefined && !isNewest(p, rule.newestPer)) return false;
    return true;
  });
}

/** `a` is newer than `b`: created later, or at the same time (or both unknown) with a later name. */
function newer(a: AcrossRow, b: AcrossRow): boolean {
  const at = a.created ?? -Infinity;
  const bt = b.created ?? -Infinity;
  return at !== bt ? at > bt : a.name > b.name;
}

/** Whether a rule needs the rows of other objects: `missing`, `toldThroughOwner` or `newestPer`. */
export function judgedAcross(rule: ProblemContribution): boolean {
  return rule.toldThroughOwner || rule.toldThroughReferrer !== undefined || rule.newestPer !== undefined || lookedUp(rule.when).length > 0;
}

/** The kinds a condition looks up (`missing`). */
export function lookedUp(condition: ProblemContribution["when"]): { group: string; kind: string }[] {
  if (condition.type === "missing" || condition.type === "related" || condition.type === "relatedBy" || condition.type === "selectsNone") return [condition.kind];
  if (condition.type === "all" || condition.type === "any") return condition.of.flatMap(lookedUp);
  return [];
}

/** The `group/kind` keys (by `keyOf`) a `selectsNone` of `rules` selects from: their rows keep every label (#404). */
export function selectedKinds(rules: readonly ProblemContribution[], keyOf: (kind: { group: string; kind: string }) => string): Set<string> {
  const out = new Set<string>();
  const visit = (condition: ProblemCondition) => {
    if (condition.type === "selectsNone") out.add(keyOf(condition.kind));
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

/** The `related` conditions' own `when`s of `rules`, by the `group/kind` (lower case) they name (#409). */
export function factsOf(rules: readonly ProblemContribution[], keyOf: (kind: { group: string; kind: string }) => string): Map<string, ProblemCondition[]> {
  const out = new Map<string, ProblemCondition[]>();
  const visit = (condition: ProblemCondition) => {
    if (condition.type === "related" || condition.type === "relatedBy") {
      const key = keyOf(condition.kind);
      const list = out.get(key) ?? [];
      if (!list.some((c) => factKey(c) === factKey(condition.when))) list.push(condition.when);
      out.set(key, list);
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
