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
import type { KubeObject, ProblemContribution } from "../api";
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
}

/** The row of `obj`, keeping only the labels `labelKeys` name. */
export function rowOf(labelKeys: readonly string[]): (obj: KubeObject) => AcrossRow {
  return (obj) => {
    const meta = (obj.metadata ?? {}) as { name?: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, unknown> };
    const all = meta.labels ?? {};
    const labels: Record<string, string> = {};
    for (const key of labelKeys) {
      const value = all[key];
      if (typeof value === "string") labels[key] = value;
    }
    const created = Date.parse(meta.creationTimestamp ?? "");
    return { namespace: meta.namespace ?? "", name: meta.name ?? "", created: Number.isNaN(created) ? undefined : created, labels };
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
  // Names per target, built once per look.
  const names = new Map<AcrossTarget, Set<string> | null>();
  const namesOf = (target: AcrossTarget): Set<string> | null => {
    if (!names.has(target)) {
      const rows = context.target(target.def);
      names.set(target, usable(rows) ? new Set([...rows.rows.values()].map((r) => `${(r as AcrossRow).namespace}/${(r as AcrossRow).name}`)) : null);
    }
    return names.get(target)!;
  };
  const missing = (p: Problem): boolean =>
    (p.lookups ?? []).every((lookup) => {
      const target = targets.find((t) => sameKind(t, lookup));
      if (!target) return false;
      const known = namesOf(target);
      if (!known) return false;
      const namespace = target.namespaced ? (p.object.namespace ?? "") : "";
      const watched = context.target(target.def)?.namespaces;
      if (target.namespaced && watched !== null && !watched?.includes(namespace)) return false;
      return !known.has(`${namespace}/${lookup.name}`);
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

  return problems.filter((p) => {
    const rule = rules.get(p.group ?? "");
    if (!rule) return true;
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
  return rule.toldThroughOwner || rule.newestPer !== undefined || lookedUp(rule.when).length > 0;
}

/** The kinds a condition looks up (`missing`). */
export function lookedUp(condition: ProblemContribution["when"]): { group: string; kind: string }[] {
  if (condition.type === "missing") return [condition.kind];
  if (condition.type === "all" || condition.type === "any") return condition.of.flatMap(lookedUp);
  return [];
}
