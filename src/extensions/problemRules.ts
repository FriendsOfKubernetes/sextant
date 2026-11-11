// Problem rules of extensions (`contributes.problems`, ADR-0137), evaluated by the window on the problems store's own
// watches: no extension code runs for them. Pure functions; the manifest was checked in Rust when it was read
// (`crates/sextant-core/src/extensions/problems.rs`: the paths are field paths of the custom columns' grammar that
// read no secret, conditions nest at most 3 deep), so a path that does not parse here only matches nothing.
//
//   compileRules(rules)          // per kind: (obj) => Detected[]
//   renderMessage(template, obj) // `{{path}}` placeholders filled with scalar values, cleaned and capped
import type { KindRef, KubeObject, ObjectRef, ProblemCondition, ProblemContribution, ProblemScalar } from "../api";
import { parseFieldPath, pickStep, type PathStep } from "../features/custom-columns/path";
import { currentCertExpiryWarningMs, type Detected } from "../features/problems/model";
import { currentLanguage, formatList, formatNumber } from "../i18n/format";
import { formatBytes, formatCpu, parseQuantity } from "../features/metrics/format";
import { cleanText } from "../resources/uri";
import { hostsOf } from "../features/diagnose/traefikModel";

/** A placeholder shows at most this many characters of its value: a controller's whole condition message (#373). */
export const MAX_VALUE_CHARS = 1000;
/** A message shows at most this many characters (notifications and agents clip it further). */
export const MAX_MESSAGE_CHARS = 1200;
/** A reason from the object shows at most this many characters. */
export const MAX_REASON_CHARS = 100;

const MINUTE_MS = 60_000;

/** A text in lower case when `ignoreCase` asks (#405); anything else as it is. */
const folded = <T>(value: T, ignoreCase: boolean | undefined): T => (ignoreCase && typeof value === "string" ? (value.toLowerCase() as T) : value);

/** The sum of the numbers in a list, lists inside it included (#407); `undefined` without one. */
export function sumOf(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  let found = false;
  let total = 0;
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else {
      const n = numberOf(v);
      if (n !== undefined) {
        found = true;
        total += n;
      }
    }
  };
  visit(value);
  return found ? total : undefined;
}

/** The key of a `related` condition's own `when` (#409): what a row of the named kind remembers of it. */
export const factKey = (when: ProblemCondition): string => JSON.stringify(when);

/**
 * The value at a field path; `undefined` when the path does not parse or leads nowhere. In a list column's item
 * (ADR-0167 amendment) `.` is the item itself and a path starting with `$` reads `root`, the object.
 */
export function valueAt(obj: unknown, path: string, root?: unknown): unknown {
  // A compared path may end in `|sum` (a list's numbers added) or `|count` (a list's items, a map's entries; #407).
  const bar = path.lastIndexOf("|");
  if (bar >= 0) {
    const filter = path.slice(bar + 1).trim();
    const value = valueAt(obj, path.slice(0, bar), root);
    if (filter === "count") return Array.isArray(value) ? value.length : value !== null && typeof value === "object" ? Object.keys(value).length : undefined;
    if (filter === "sum") return sumOf(value);
    if (filter === "min" || filter === "max") return extremeOf(value, filter);
    // A Kubernetes quantity ("64Gi", "500m") as its amount (#404): a NodePool's usage against its limit.
    if (filter === "quantity") return parseQuantity(value);
    if (filter === "daysLeft") return daysLeftOf(value);
    return undefined;
  }
  const trimmed = path.trim();
  if (trimmed === ".") return obj;
  if (trimmed.startsWith("$")) return valueAt(root ?? obj, trimmed.slice(1));
  const steps = parseFieldPath(trimmed);
  return steps ? walk(obj, steps) : undefined;
}

function walk(obj: unknown, steps: readonly PathStep[]): unknown {
  let at: unknown = obj;
  for (const [n, step] of steps.entries()) {
    if (at === null || typeof at !== "object") return undefined;
    if ("index" in step) {
      if (!Array.isArray(at)) return undefined;
      at = at[step.index];
    } else if ("match" in step) {
      at = pickStep(at, step);
      // `*` (#404): the steps after it read each item; the ones that lead nowhere are left out.
      if (step.all && n < steps.length - 1) {
        const rest = steps.slice(n + 1);
        const read = (at as unknown[]).map((item) => walk(item, rest)).filter((v) => v !== undefined);
        // A second `*` later in the path (#404): its lists of every item are one flat list.
        return rest.some((s) => "match" in s && s.all) ? read.flatMap((v) => (Array.isArray(v) ? v : [v])) : read;
      }
    } else {
      if (Array.isArray(at) || !Object.prototype.hasOwnProperty.call(at, step.key)) return undefined;
      at = (at as Record<string, unknown>)[step.key];
    }
  }
  return at;
}

/**
 * The map at a compared path whose filter (`|quantity`, `|count`, …) reads each of its values (`eachKey`, ADR-0169):
 * key → its number, read when asked; `undefined` when the path holds no map.
 */
function mapValues(obj: unknown, path: string): Record<string, () => number | undefined> | undefined {
  const bar = path.lastIndexOf("|");
  const field = bar >= 0 ? path.slice(0, bar) : path;
  const filter = bar >= 0 ? path.slice(bar + 1).trim() : undefined;
  const map = valueAt(obj, field);
  if (map === null || typeof map !== "object" || Array.isArray(map)) return undefined;
  const out: Record<string, () => number | undefined> = {};
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    out[key] = () => numberOf(filter === undefined ? value : valueAt(value, `.|${filter}`));
  }
  return out;
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * A list's smallest or largest number, or — when its items are times — its earliest or latest time as written (#404):
 * the first of a stream's failing tags. Nothing for an empty list or one with neither.
 */
export function extremeOf(value: unknown, which: "min" | "max"): unknown {
  if (!Array.isArray(value)) return undefined;
  const items = value.flat(2).filter((v) => typeof v === "number" || typeof v === "string");
  const times = items.filter((v): v is string => typeof v === "string" && Number.isNaN(Number(v)) && !Number.isNaN(Date.parse(v)));
  const better = (a: number, b: number) => (which === "min" ? a < b : a > b);
  if (times.length > 0) return times.reduce((best, t) => (better(Date.parse(t), Date.parse(best)) ? t : best));
  const numbers = items.map((v) => numberOf(v)).filter((n): n is number => n !== undefined);
  return numbers.length === 0 ? undefined : numbers.reduce((best, n) => (better(n, best) ? n : best));
}

/** A number, a string that is nothing but one (`"85.5"`), or a list's length (ADR-0161); `undefined` otherwise. */
export function numberOf(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** An object a `missing` condition says must not exist for the rule to hold (the rest of the rule holds). */
export interface Lookup {
  group: string;
  kind: string;
  name: string;
  /** `related` (#409): the named object must exist with this fact (`factKey` of its `when`) holding; else it must not exist. */
  fact?: string;
  /** Where the named object is (#404), when not in the judged object's own namespace. */
  namespace?: string;
  /** A `missing` of a list (#404): of the lookups with the same key, any one not there is enough. */
  anyOf?: string;
  /** `relatedBy` (#404): an object of the kind in the judged object's namespace with these texts at these paths. */
  by?: [path: string, value: string][];
  /**
   * `missing` with `alsoKinds` (ADR-0169): more kinds the name is looked up in; missing only when none of them the
   * cluster serves has it, a kind it does not serve having no objects.
   */
  also?: { group: string; kind: string }[];
  /**
   * `selectsNone` (#404): no object of the kind in `namespaces` (`null`: every one) has labels `selector` matches. With
   * `by` (ADR-0169) the objects that select the judged one (in `own`, with `labels`) narrow where it looks; `namedOnly`:
   * a selector that still looks in every namespace is not judged.
   */
  selects?: { selector: LabelSelector; namespaces: string[] | null; own?: string; namedOnly?: boolean; by?: SelectingLookup };
  /**
   * `selectedByNone` (ADR-0169): no object of the kind (and `also`) selects the judged object, which has `labels` and
   * is in `namespace`; at least one such object exists.
   */
  selectedBy?: SelectingLookup;
  /**
   * `judged` (ADR-0168): the judge's latest answer must give this fact for the object (`group`, `kind` and `name` are
   * empty). `judgeAcross` adds what the judge read (`reads`: each kind and the namespaces its source watched,
   * `null` every one), which an agent must be able to read to be told the problem.
   */
  judged?: {
    judge: string;
    fact: string;
    reads?: { group: string; kind: string; namespaces: readonly string[] | null }[];
    /**
     * What the finding rests on, when the judge's fact says (`needs`, ADR-0168 amendment): an agent must be able to
     * read these, instead of every kind in `reads`.
     */
    needs?: { group: string; kind: string; namespace?: string; name?: string }[];
  };
}

/** Who may select a judged object (`selectedByNone`, `selectsNone.selectedBy`, ADR-0169), and what it is. */
export interface SelectingLookup {
  kinds: { group: string; kind: string }[];
  /** The paths of their selector and namespace selector: the key their rows keep them under (`selectingKey`). */
  selector: string;
  namespaceSelector: string;
  /** `ownNamespaceWhen`'s `factKey`, when the selectors narrow where a `selectsNone` looks. */
  fact?: string;
  labels: Record<string, string>;
  namespace: string;
}

/** The key a selecting object's row keeps the selectors at these paths under (ADR-0169). */
export const selectingKey = (selector: string, namespaceSelector: string): string => `${selector}|${namespaceSelector}`;

/** The labels of an object, its string values only. */
function labelsOf(obj: KubeObject): Record<string, string> {
  const raw = (obj.metadata?.labels ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** A Kubernetes label selector, as `selectsNone` reads it (#404). */
export interface LabelSelector {
  matchLabels: Record<string, string>;
  matchExpressions: { key: string; operator: string; values: string[] }[];
}

/** The selector at `value`; `undefined` when it is no object. An empty one selects everything. */
export function labelSelectorOf(value: unknown): LabelSelector | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as { matchLabels?: unknown; matchExpressions?: unknown };
  const matchLabels: Record<string, string> = {};
  if (raw.matchLabels !== null && typeof raw.matchLabels === "object" && !Array.isArray(raw.matchLabels)) {
    for (const [k, v] of Object.entries(raw.matchLabels as Record<string, unknown>)) if (typeof v === "string") matchLabels[k] = v;
  }
  const matchExpressions = (Array.isArray(raw.matchExpressions) ? raw.matchExpressions : []).flatMap((e) => {
    if (e === null || typeof e !== "object") return [];
    const { key, operator, values } = e as { key?: unknown; operator?: unknown; values?: unknown };
    if (typeof key !== "string" || typeof operator !== "string") return [];
    return [{ key, operator, values: Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [] }];
  });
  return { matchLabels, matchExpressions };
}

/** Whether `labels` are picked by `selector`, as the API server matches; an operator it does not know matches nothing. */
export function selectorMatches(selector: LabelSelector, labels: Readonly<Record<string, string>>): boolean {
  for (const [k, v] of Object.entries(selector.matchLabels)) if (labels[k] !== v) return false;
  return selector.matchExpressions.every(({ key, operator, values }) => {
    const has = Object.hasOwn(labels, key);
    switch (operator) {
      case "In":
        return has && values.includes(labels[key]!);
      case "NotIn":
        return !has || !values.includes(labels[key]!);
      case "Exists":
        return has;
      case "DoesNotExist":
        return !has;
      default:
        return false;
    }
  });
}

/** What a condition says of an object. */
export interface Verdict {
  /**
   * It holds (now, or from `activeFrom` on) — for a rule with `missing`, if none of `lookups` exists, which only the
   * rows of other sources tell (`judgeAcross`).
   */
  holds: boolean;
  lookups?: Lookup[];
  /** It holds only from this time (ms): an `olderThan` that is not yet old enough counts from then. */
  activeFrom?: number;
  /** It holds only until this time (ms): a `not` around an `olderThan` that is not yet old enough. */
  until?: number;
  /** When the state began, as an entry of `.status.conditions` says (its `lastTransitionTime`). */
  since?: string;
  /** `expiring` (#404): the time it is about, so the store moves the warning when the setting changes. */
  expiresAt?: number;
}

const NO: Verdict = { holds: false };

/** Whether `condition` holds for `obj`. Values compare by type: `"3"` is not `3` (but `above`/`below` read both). */
/** What the problems store knows of an object beyond the object (#393). */
export interface RuleContext {
  /** When the object entered its label-selected source, as the store saw it (not for objects already there). */
  enteredAt?: number;
  /**
   * What the extension's own rules say of the object (a computed column's `problem` case, ADR-0169): a problem
   * stands, they cannot tell, they are still reading; `undefined` when none of these.
   */
  problemState?: (obj: KubeObject) => "found" | "unknown" | "checking" | undefined;
}

export function evaluate(condition: ProblemCondition, obj: KubeObject, ctx: RuleContext = {}): Verdict {
  switch (condition.type) {
    case "equals":
      return { holds: sameScalar(folded(valueAt(obj, condition.path), condition.ignoreCase), folded(condition.value, condition.ignoreCase)) };
    case "in": {
      const value = folded(valueAt(obj, condition.path), condition.ignoreCase);
      return { holds: condition.values.some((v) => sameScalar(value, folded(v, condition.ignoreCase))) };
    }
    // Text conditions (#405): a string value only; no pattern language, so no backtracking.
    case "contains":
    case "startsWith":
    case "endsWith": {
      const value = valueAt(obj, condition.path);
      if (typeof value !== "string") return NO;
      const fold = (text: string) => (condition.ignoreCase ? text.toLowerCase() : text);
      const text = fold(value);
      // A value may hold the object's own texts (#404); one whose placeholder has no value is left out.
      const wanted = condition.values.flatMap((v) => {
        const filled = v.includes("{{") ? fillTemplate(v, obj) : v;
        return filled === null || filled === "" ? [] : [filled];
      });
      const test =
        condition.type === "contains"
          ? (v: string) => text.includes(fold(v))
          : condition.type === "startsWith"
            ? (v: string) => text.startsWith(fold(v))
            : (v: string) => text.endsWith(fold(v));
      return { holds: wanted.some(test) };
    }
    case "exists": {
      const value = valueAt(obj, condition.path);
      // `nonEmpty` (#405): an empty or blank text is nothing too.
      return { holds: value !== undefined && value !== null && !(condition.nonEmpty && typeof value === "string" && value.trim() === "") };
    }
    case "absent": {
      const value = valueAt(obj, condition.path);
      return { holds: value === undefined || value === null };
    }
    case "condition": {
      const entries = valueAt(obj, ".status.conditions");
      const entry = Array.isArray(entries)
        ? (entries.find((c) => c && typeof c === "object" && (c as Record<string, unknown>).type === condition.conditionType) as
            | Record<string, unknown>
            | undefined)
        : undefined;
      if (!entry || entry.status !== condition.status) return NO;
      if (condition.reason !== undefined && entry.reason !== condition.reason) return NO;
      return { holds: true, since: typeof entry.lastTransitionTime === "string" ? entry.lastTransitionTime : undefined };
    }
    case "above": {
      const n = numberOf(valueAt(obj, condition.path));
      return { holds: n !== undefined && n > condition.value };
    }
    case "below": {
      const n = numberOf(valueAt(obj, condition.path));
      return { holds: n !== undefined && n < condition.value };
    }
    case "same": {
      const a = valueAt(obj, condition.path);
      const b = valueAt(obj, condition.otherPath);
      return { holds: sameValue(a, b) };
    }
    case "enteredWithin": {
      // From when the store saw the object enter its narrowed list, for `minutes` (#393).
      if (ctx.enteredAt === undefined) return NO;
      return { holds: true, since: new Date(ctx.enteredAt).toISOString(), until: ctx.enteredAt + condition.minutes * MINUTE_MS };
    }
    case "atLeast": {
      // `eachKey` (ADR-0169): two maps compared key by key, a path's filter (`|quantity`) reading each value; any key
      // whose values are both numbers and at least holds — a NodePool's usage of any resource it limits at its limit.
      if (condition.eachKey) {
        const ours = mapValues(obj, condition.path);
        const theirs = mapValues(obj, condition.otherPath);
        if (!ours || !theirs) return NO;
        for (const [key, read] of Object.entries(ours)) {
          if (!Object.prototype.hasOwnProperty.call(theirs, key)) continue;
          const a = read();
          const b = theirs[key]!();
          if (a !== undefined && b !== undefined && a >= b + (condition.offset ?? 0)) return { holds: true };
        }
        return NO;
      }
      // Both as numbers (a list as its length); not a number on either side never holds (#386).
      // `addPaths` (#407): their numbers added to `path`'s first.
      const parts = [condition.path, ...(condition.addPaths ?? [])].map((p) => numberOf(valueAt(obj, p)));
      const a = parts.some((n) => n === undefined) ? undefined : (parts as number[]).reduce((x, y) => x + y, 0);
      const b = numberOf(valueAt(obj, condition.otherPath));
      // `offset` (#407): added to the other value first.
      return { holds: a !== undefined && b !== undefined && a >= b + (condition.offset ?? 0) };
    }
    case "expiring": {
      // The user's certificate warning before the time, until it (#404); the store moves it when the setting changes.
      const t = timeOf(valueAt(obj, condition.path));
      if (t === undefined) return NO;
      return { holds: true, activeFrom: t - currentCertExpiryWarningMs(), until: t, expiresAt: t };
    }
    case "olderThan": {
      const value = valueAt(obj, condition.path);
      const t = timeOf(value);
      // `orUnreadable` (#405): a value that is there but no time holds at once.
      if (t === undefined) return condition.orUnreadable && value !== undefined && value !== null && value !== "" ? { holds: true } : NO;
      return { holds: true, activeFrom: t + condition.minutes * MINUTE_MS };
    }
    case "missing": {
      const at = (holder: unknown, path: string | undefined): string | undefined => {
        if (path === undefined) return undefined;
        const v = valueAt(holder, path);
        return typeof v === "string" && v.trim() !== "" ? v : undefined;
      };
      // `alsoKinds` (ADR-0169): the kinds looked up after `kind`.
      const also = condition.alsoKinds?.length ? { also: condition.alsoKinds.map(({ group, kind }) => ({ group, kind })) } : {};
      const holdsOn = (when: ProblemCondition | undefined, item: unknown) =>
        when === undefined || (item !== null && typeof item === "object" && evaluate(when, item as KubeObject).holds);
      if (condition.path.includes("*")) {
        // A list of references (#404): any item naming an object that is not there; nothing named, nothing missing.
        // With `enclosingNamespacePath` (ADR-0169) each item with the object holding its list.
        const items = condition.enclosingNamespacePath === undefined ? itemsOf(valueAt(obj, condition.path)) : heldItems(obj, condition.path);
        const key = `${condition.kind.group}/${condition.kind.kind}|${condition.path}`;
        const lookups: Lookup[] = [];
        for (const { item, holder } of items) {
          if (condition.itemWhen && !holdsOn(condition.itemWhen, item)) continue;
          const name = condition.namePath === undefined ? (typeof item === "string" && item.trim() !== "" ? item : undefined) : at(item, condition.namePath);
          if (name === undefined) continue;
          // The item's own namespace where `namespaceWhen` lets it count, else its holder's where `enclosingNamespaceWhen`
          // does, else the object's own (ADR-0169).
          const namespace =
            (holdsOn(condition.namespaceWhen, item) ? at(item, condition.namespacePath) : undefined) ??
            (holder !== undefined && holdsOn(condition.enclosingNamespaceWhen, holder) ? at(holder, condition.enclosingNamespacePath) : undefined);
          lookups.push({ group: condition.kind.group, kind: condition.kind.kind, name, anyOf: key, ...(namespace !== undefined ? { namespace } : {}), ...also });
        }
        return lookups.length === 0 ? NO : { holds: true, lookups };
      }
      // Nothing named, nothing missing.
      const name = valueAt(obj, condition.path);
      if (typeof name !== "string" || name.trim() === "") return NO;
      const namespace = at(obj, condition.namespacePath);
      return { holds: true, lookups: [{ group: condition.kind.group, kind: condition.kind.kind, name, ...(namespace !== undefined ? { namespace } : {}), ...also }] };
    }
    case "problem":
      // What the extension's rules say of the row (a computed column's case, ADR-0169); nothing outside a table.
      return { holds: ctx.problemState !== undefined && ctx.problemState(obj) === (condition.state ?? "found") };
    case "relatedBy": {
      // The judged object's texts the other object must hold; one missing, nothing related (#404).
      const by: [string, string][] = [];
      for (const { theirs, ours } of condition.pairs) {
        const value = valueAt(obj, ours);
        if (!isScalar(value) || String(value) === "") return NO;
        by.push([theirs, String(value)]);
      }
      return { holds: true, lookups: [{ group: condition.kind.group, kind: condition.kind.kind, name: "", by, fact: factKey(condition.when) }] };
    }
    case "selectsNone": {
      // Nothing to select with, nothing judged; the rows of the kind tell whether it selects any (#404).
      // No selector at all selects everything, as Prometheus Operator reads a monitor's; any other non-object nothing.
      const raw = valueAt(obj, condition.selector);
      const selector = raw === undefined || raw === null ? { matchLabels: {}, matchExpressions: [] } : labelSelectorOf(raw);
      if (!selector) return NO;
      const names = condition.namespacesPath === undefined ? undefined : valueAt(obj, condition.namespacesPath);
      const listed = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && n !== "") : [];
      const every = condition.anyNamespacesPath !== undefined && valueAt(obj, condition.anyNamespacesPath) === true;
      const own = obj.metadata?.namespace ?? "";
      const namespaces = every ? null : listed.length > 0 ? listed : [own];
      const by = condition.selectedBy;
      // A selector of every namespace that nothing can narrow is not judged (`namedOnly`, ADR-0169).
      if (condition.namedOnly === true && namespaces === null && by === undefined) return NO;
      const selects: NonNullable<Lookup["selects"]> = { selector, namespaces };
      if (condition.namedOnly === true) selects.namedOnly = true;
      if (by !== undefined) {
        selects.own = own;
        selects.by = {
          kinds: [by.kind, ...(by.alsoKinds ?? [])].map(({ group, kind }) => ({ group, kind })),
          selector: by.selector,
          namespaceSelector: by.namespaceSelector,
          fact: factKey(by.ownNamespaceWhen),
          labels: labelsOf(obj),
          namespace: own,
        };
      }
      return { holds: true, lookups: [{ group: condition.kind.group, kind: condition.kind.kind, name: "", selects }] };
    }
    case "selectedByNone": {
      // The rows of the selecting kinds tell whether any picks the object up (ADR-0169).
      const selectedBy: SelectingLookup = {
        kinds: [condition.kind, ...(condition.alsoKinds ?? [])].map(({ group, kind }) => ({ group, kind })),
        selector: condition.selector,
        namespaceSelector: condition.namespaceSelector,
        labels: labelsOf(obj),
        namespace: obj.metadata?.namespace ?? "",
      };
      return { holds: true, lookups: [{ group: condition.kind.group, kind: condition.kind.kind, name: "", selectedBy }] };
    }
    case "judged":
      // The judge's latest answer tells (ADR-0168): `judgeAcross` keeps the problem only where it gives the fact.
      return { holds: true, lookups: [{ group: "", kind: "", name: "", judged: { judge: condition.judge, fact: condition.fact } }] };
    case "related": {
      const fact = factKey(condition.when);
      if (condition.path.includes("*")) {
        // A list of names (ADR-0167 amendment): any one of them there with the fact holding; nothing named, nothing.
        const items = valueAt(obj, condition.path);
        const key = `${condition.kind.group}/${condition.kind.kind}|${condition.path}|${fact}`;
        const lookups: Lookup[] = (Array.isArray(items) ? items : [])
          .filter((item): item is string => typeof item === "string" && item.trim() !== "")
          .map((name) => ({ group: condition.kind.group, kind: condition.kind.kind, name, fact, anyOf: key }));
        return lookups.length === 0 ? NO : { holds: true, lookups };
      }
      // Nothing named, nothing related; the named object's own condition is judged on its row (#409).
      const name = valueAt(obj, condition.path);
      if (typeof name !== "string" || name.trim() === "") return NO;
      return { holds: true, lookups: [{ group: condition.kind.group, kind: condition.kind.kind, name, fact }] };
    }
    case "all": {
      let activeFrom: number | undefined;
      let until: number | undefined;
      let since: string | undefined;
      let lookups: Lookup[] | undefined;
      let expiresAt: number | undefined;
      for (const inner of condition.of) {
        const v = evaluate(inner, obj, ctx);
        if (!v.holds) return NO;
        if (v.activeFrom !== undefined) activeFrom = Math.max(activeFrom ?? v.activeFrom, v.activeFrom);
        if (v.until !== undefined) until = Math.min(until ?? v.until, v.until);
        since ??= v.since;
        expiresAt ??= v.expiresAt;
        if (v.lookups) lookups = [...(lookups ?? []), ...v.lookups];
      }
      // A window that closes before it opens never holds.
      if (activeFrom !== undefined && until !== undefined && until <= activeFrom) return NO;
      const verdict: Verdict = { holds: true, activeFrom, since };
      if (until !== undefined) verdict.until = until;
      if (expiresAt !== undefined) verdict.expiresAt = expiresAt;
      if (lookups) verdict.lookups = lookups;
      return verdict;
    }
    case "any": {
      // An `any` of `missing` and `related` only (ADR-0167 amendment): one group of lookups, any of whose objects is
      // missing or related is enough; a list not read makes it unknown, never wrong.
      if (condition.of.length > 0 && condition.of.every((c) => c.type === "missing" || c.type === "related")) {
        const key = `any|${JSON.stringify(condition.of)}`;
        // Branch by branch, item by item (the first item of each branch, then the second…): `{{missing}}` names them in
        // the object's own order.
        const branches = condition.of.map((inner) => evaluate(inner, obj, ctx).lookups ?? []);
        const lookups: Lookup[] = [];
        for (let i = 0; i < Math.max(0, ...branches.map((b) => b.length)); i++) {
          for (const branch of branches) if (branch[i]) lookups.push({ ...branch[i]!, anyOf: key });
        }
        return lookups.length === 0 ? NO : { holds: true, lookups };
      }
      // The branch that counts longest: one that holds now and for good, else now until the latest end, else the one
      // that holds earliest.
      let best: Verdict | undefined;
      for (const inner of condition.of) {
        const v = evaluate(inner, obj, ctx);
        if (!v.holds) continue;
        if (v.activeFrom === undefined && v.until === undefined) return v;
        if (!best || rank(v) < rank(best)) best = v;
      }
      return best ?? NO;
    }
    case "not": {
      const v = evaluate(condition.of, obj, ctx);
      if (!v.holds) return { holds: true };
      // It holds from some time on: until then, `not` holds; past an end, it holds again (not modelled: never).
      if (v.activeFrom !== undefined && v.until === undefined) return { holds: true, until: v.activeFrom };
      return NO;
    }
  }
}

/** The items of a list read by a path (none for anything else), without a holder. */
function itemsOf(value: unknown): { item: unknown; holder?: unknown }[] {
  return Array.isArray(value) ? value.map((item) => ({ item })) : [];
}

/**
 * The items a path whose last step lists a field's items (`….middlewares[*]`) reads, each with the object holding that
 * field (ADR-0169): a route service's middlewares with the service. The holders are what the path before that field
 * reads (a list where it lists).
 */
export function heldItems(obj: unknown, path: string): { item: unknown; holder: unknown }[] {
  const steps = parseFieldPath(path.trim());
  const last = steps?.[steps.length - 1];
  const field = steps?.[steps.length - 2];
  if (!steps || !last || !field || !("match" in last) || !last.all || !("key" in field)) return [];
  const before = steps.slice(0, -2);
  const read = before.length === 0 ? obj : walk(obj, before);
  const holders = before.some((s) => "match" in s && s.all) ? (Array.isArray(read) ? read : []) : read === undefined ? [] : [read];
  return holders.flatMap((holder) => {
    if (holder === null || typeof holder !== "object" || Array.isArray(holder) || !Object.prototype.hasOwnProperty.call(holder, field.key)) return [];
    const list = pickStep((holder as Record<string, unknown>)[field.key], last);
    return Array.isArray(list) ? list.map((item) => ({ item, holder })) : [];
  });
}

/**
 * The 1-based places of the matches of a path's last step (`[…,*]`) in its list (ADR-0169), in order; `undefined`
 * when the path does not end in such a step or reads no list.
 */
export function positionsOf(obj: unknown, path: string, root?: unknown): number[] | undefined {
  const trimmed = path.trim();
  if (trimmed.startsWith("$")) return positionsOf(root ?? obj, trimmed.slice(1));
  const steps = parseFieldPath(trimmed);
  const last = steps?.[steps.length - 1];
  if (!steps || !last || !("match" in last) || !last.all) return undefined;
  const list = steps.length === 1 ? obj : walk(obj, steps.slice(0, -1));
  if (!Array.isArray(list)) return undefined;
  const out: number[] = [];
  list.forEach((item, i) => {
    const one = pickStep([item], last);
    if (Array.isArray(one) && one.length === 1) out.push(i + 1);
  });
  return out;
}

/** Orders the branches of `any`: holding now with a later end first, then holding earlier. */
function rank(v: Verdict): number {
  if (v.activeFrom === undefined) return -(v.until ?? Infinity);
  return v.activeFrom;
}

/**
 * `same`: the same scalar, or the same number where one side is a number and the other a number written as text
 * (Argo Rollouts' `status.observedGeneration` is `"3"`, `metadata.generation` is `3`; #369). Two strings compare as
 * text only: `"07"` is not `"7"`.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (!isScalar(a) || !isScalar(b)) return false;
  if (a === b) return true;
  if (typeof a === typeof b || (typeof a !== "number" && typeof b !== "number")) return false;
  const x = numberOf(a);
  return x !== undefined && x === numberOf(b);
}

function sameScalar(value: unknown, expected: ProblemScalar): boolean {
  return isScalar(value) && typeof value === typeof expected && value === expected;
}

/**
 * `template` with each `{{path}}` replaced by the scalar value there (clipped); `null` when a placeholder has none
 * (an object, a list, nothing).
 */
export function fillTemplate(
  template: string,
  obj: unknown,
  options: { emptyIsMissing?: boolean; root?: unknown; siblings?: readonly unknown[] } = {},
): string | null {
  let missing = false;
  const text = template.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner: string) => {
    const shown = placeholderText(obj, inner, options.root, options.siblings);
    if (shown === undefined || (options.emptyIsMissing && shown === "")) {
      missing = true;
      return "";
    }
    return Array.from(shown).length > MAX_VALUE_CHARS ? `${Array.from(shown).slice(0, MAX_VALUE_CHARS).join("")}…` : shown;
  });
  return missing ? null : text;
}

/**
 * What a placeholder shows (#404): the scalar at its path, or with `|firstLine` its first line, `|lastSegment` the part
 * after its last `.` or `/`, `|list` a list's scalars joined in the UI language, `|count` a list's items or a map's
 * entries; `undefined` when there is nothing to show.
 */
export function placeholderText(obj: unknown, inner: string, root?: unknown, siblings?: readonly unknown[]): string | undefined {
  // Up to two filters in a row (`|firstLine|clip:300`, #404): the first reads the value, `clip:<n>` cuts the text.
  const [path = "", ...rest] = inner.split("|").map((part, i) => (i === 0 ? part : part.trim()));
  // `|share` (ADR-0167 amendment): a list item's number as a percent of the same number over the list's items, each
  // read the same way (`{{.weight ?? 100|share}}`); 0 when they add up to 0, as a router weighs backends.
  if (rest[0] === "share") {
    if (!siblings) return undefined;
    const numberOfItem = (item: unknown): number | undefined => {
      for (const [i, one] of splitOutsideQuotes(path, "??").entries()) {
        const literal = i > 0 ? placeholderLiteral(one.trim()) : undefined;
        const n = literal !== undefined ? numberOf(literal) : numberOf(valueAtIn(item, one.trim(), root));
        if (n !== undefined) return n;
      }
      return undefined;
    };
    const own = numberOfItem(obj);
    if (own === undefined) return undefined;
    const total = siblings.reduce<number>((sum, item) => sum + (numberOfItem(item) ?? 0), 0);
    const percent = total > 0 ? (own / total) * 100 : 0;
    return formatNumber(percent, percent > 0 && percent < 1 ? 1 : 0);
  }
  // `fqdn:<path>` (ADR-0167 amendment): a short name completed with the namespace at the path, after the other filter.
  const fqdn = rest.find((f) => f.startsWith("fqdn:"))?.slice(5);
  const filters = rest.filter((f) => !f.startsWith("fqdn:"));
  const filter = filters.find((f) => !f.startsWith("clip:") && !f.startsWith("after:"));
  const valueAt = (from: unknown, p: string) => valueAtIn(from, p, root);
  const clipped = (whole: string, list: readonly string[]) =>
    clippedText(fqdn === undefined ? whole : fqdnOf(whole, valueAtIn(obj, fqdn, root)), list);
  // Paths tried in turn with `??` (#404): the first whose value is there and not an empty text.
  const tried = splitOutsideQuotes(path, "??");
  if (tried.length > 1) {
    for (const [i, one] of tried.entries()) {
      // The last may be a literal (#404): `{{.status.updated ?? 0}}`, `{{.value ?? "*"}}`.
      const literal = i === tried.length - 1 ? placeholderLiteral(one.trim()) : undefined;
      if (literal !== undefined) return literal;
      const text = filteredText(valueAt(obj, one.trim()), filter);
      const shown = text === undefined || text === "" ? undefined : clipped(text, filters);
      if (shown !== undefined) return shown;
    }
    return undefined;
  }
  // Paths multiplied with ` * ` before `|product` (#404): a missing one counts as 1, nothing when none is there.
  if (filter === "product") {
    const numbers = splitOutsideQuotes(path, " * ").map((p) => numberOf(valueAt(obj, p.trim())));
    if (numbers.every((n) => n === undefined)) return undefined;
    return clipped(String(numbers.reduce<number>((a, n) => a * (n ?? 1), 1)), filters);
  }
  // `|positions` (ADR-0169): the places of every `+` path's matches, each once, in order, in the UI language's list;
  // nothing when no path reads a list, an empty text when none matches.
  if (filter === "positions") {
    const read = addedPaths(path).map((p) => positionsOf(obj, p, root));
    if (read.every((p) => p === undefined)) return undefined;
    const places = [...new Set(read.flatMap((p) => p ?? []))].sort((a, b) => a - b);
    return clipped(formatList(places.map(String)), filters);
  }
  // Paths added with `+` before `|sum` (#404): the numbers of every path there, nothing when none is.
  const added = filter === "sum" || filter === "count" ? addedPaths(path) : [path];
  // `+` before `|count` (#404): each path's count added, a scalar there counting 1, nothing when no path has a value.
  const countOf = (v: unknown): number | undefined =>
    Array.isArray(v) ? v.length : v !== null && typeof v === "object" ? Object.keys(v).length : v === undefined || v === null ? undefined : 1;
  const text =
    added.length > 1
      ? (() => {
          const parts = added.map((p) => (filter === "count" ? countOf(valueAt(obj, p.trim())) : sumOf([valueAt(obj, p.trim())])));
          const known = parts.filter((n): n is number => n !== undefined);
          return known.length === 0 ? undefined : String(known.reduce((a, b) => a + b, 0));
        })()
      : filteredText(valueAt(obj, path), filter);
  return text === undefined ? undefined : clipped(text, filters);
}

/**
 * A Service's short name completed as Kubernetes' DNS names it in `namespace` (`web` → `web.shop.svc.cluster.local`):
 * a text without a dot that is not empty or `*`, trimmed; anything else, or without a namespace, as it is.
 */
export function fqdnOf(text: string, namespace: unknown): string {
  const name = text.trim();
  if (name === "" || name === "*" || name.includes(".") || typeof namespace !== "string" || namespace === "") return name;
  return `${name}.${namespace}.svc.cluster.local`;
}

const valueAtIn = (obj: unknown, path: string, root: unknown) => valueAt(obj, path, root);

/** `text` after an `after:<marker>`'s last place (#404) and cut by the shortest `clip:<n>`, with "…". */
function clippedText(whole: string, filters: readonly string[]): string | undefined {
  const marker = filters.find((f) => f.startsWith("after:"))?.slice(6);
  const at = marker === undefined ? -1 : whole.lastIndexOf(marker);
  if (marker !== undefined && at < 0) return undefined;
  const text = marker === undefined ? whole : whole.slice(at + marker.length);
  // Only what follows a marker can come out empty and then be nothing: an empty value stays an empty text.
  if (marker !== undefined && text === "") return undefined;
  const clips = filters.filter((f) => f.startsWith("clip:"));
  if (clips.length === 0) return text;
  const keep = Math.min(...clips.map((c) => Number(c.slice(5))));
  const chars = [...text];
  return chars.length <= keep ? text : `${chars.slice(0, keep).join("")}…`;
}

/** A placeholder's literal fallback (`placeholder_literal`, #404): a number, or a short text in double quotes. */
export function placeholderLiteral(text: string): string | undefined {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    const inner = text.slice(1, -1);
    return Array.from(inner).length <= 40 && !/["{}]/.test(inner) && !/\p{Cc}/u.test(inner) ? inner : undefined;
  }
  return text.length > 0 && text.length <= 20 && /^[0-9.-]+$/.test(text) && Number.isFinite(Number(text)) ? text : undefined;
}

/** A placeholder's path split at each `+` outside a quoted match value (`added_paths`, #404). */
export function addedPaths(field: string): string[] {
  return splitOutsideQuotes(field, "+");
}

/** `field` split at each `sep` outside a quoted match value (`split_outside_quotes`). */
export function splitOutsideQuotes(field: string, sep: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < field.length; ) {
    if (field[i] === '"') quoted = !quoted;
    else if (!quoted && field.startsWith(sep, i)) {
      out.push(field.slice(start, i));
      i += sep.length;
      start = i;
      continue;
    }
    i += 1;
  }
  out.push(field.slice(start));
  return out;
}

/** The whole days until a time (RFC 3339), 0 once it has passed (#404): a certificate's days left, as the built-in view. */
export function daysLeftOf(value: unknown, now = Date.now()): number | undefined {
  const t = timeOf(value);
  return t === undefined ? undefined : Math.max(0, Math.floor((t - now) / (24 * 3600_000)));
}

function filteredText(value: unknown, filter: string | undefined): string | undefined {
  if (filter === "daysLeft") {
    const days = daysLeftOf(value);
    return days === undefined ? undefined : String(days);
  }
  if (filter === "sum") {
    const n = sumOf(value);
    return n === undefined ? undefined : String(n);
  }
  if (filter === "count") {
    if (Array.isArray(value)) return String(value.length);
    return value !== null && typeof value === "object" ? String(Object.keys(value).length) : undefined;
  }
  if (filter === "keys") {
    // A map's keys in its order (#404): the provider named by `spec.provider`'s one key.
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const keys = Object.keys(value);
    return keys.length === 0 ? undefined : formatList(keys);
  }
  if (filter === "quantity") {
    // A quantity's amount as a number in the UI language (ADR-0169): a whole one without fraction digits, any other
    // with two, as the built-in Karpenter view wrote a limit ("20", "1,50" in German).
    const amount = parseQuantity(value);
    return amount === undefined ? undefined : formatNumber(amount, Number.isInteger(amount) ? 0 : 2);
  }
  if (filter === "cpu" || filter === "bytes") {
    // A quantity written as Sextant writes its own (#404): "250m", "4"; "45.9GiB".
    const amount = parseQuantity(value);
    if (amount === undefined) return undefined;
    if (filter === "bytes") return formatBytes(amount);
    const milli = Math.round(amount * 1000);
    return milli % 1000 === 0 && milli > 0 ? String(milli / 1000) : formatCpu(milli);
  }
  if (filter === "countAll") {
    // The items of the lists in a list (#404): a PrometheusRule's rules over all its groups.
    if (!Array.isArray(value)) return undefined;
    return String(value.reduce<number>((n, item) => n + (Array.isArray(item) ? item.length : 0), 0));
  }
  if (filter === "selector") {
    // A label selector written as the built-in views wrote one (#404): `app=web,tier in (a,b)`, labels first, each part
    // in the object's own order.
    const selector = labelSelectorOf(value);
    if (!selector) return undefined;
    const parts = Object.entries(selector.matchLabels).map(([k, v]) => `${k}=${v}`);
    for (const { key, operator, values } of selector.matchExpressions) {
      const list = values.join(",");
      const text =
        operator === "In" ? `${key} in (${list})` : operator === "NotIn" ? `${key} notin (${list})` : operator === "Exists" ? key : operator === "DoesNotExist" ? `!${key}` : undefined;
      if (text === undefined) return undefined;
      parts.push(text);
    }
    return parts.join(",");
  }
  if (filter === "ruleHosts") {
    // The exact hosts of match rules (`Host(…)`, `HostSNI(…)`), each once, joined as the built-in Traefik column did.
    const rules = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];
    const hosts = [...new Set(rules.flatMap(hostsOf))];
    return hosts.length === 0 ? undefined : hosts.join(", ");
  }
  if (filter === "unique") {
    // Each text once, sorted by code point (#404): the policies a report names, as the built-in Kyverno message did.
    const items = Array.isArray(value) ? value.filter(isScalar).map(String) : isScalar(value) ? [String(value)] : [];
    const unique = [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return unique.length === 0 ? undefined : formatList(unique);
  }
  if (filter === "uniqueKey") {
    // A sort key of a list's texts (ADR-0169): each once, empty ones left out, by code point, joined with `,` — as the
    // built-in Prometheus Operator table keyed a monitor's namespaces.
    const items = (Array.isArray(value) ? value.filter(isScalar).map(String) : isScalar(value) ? [String(value)] : []).filter((v) => v !== "");
    const unique = [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return unique.length === 0 ? undefined : unique.join(",");
  }
  if (filter === "list" || filter === "join") {
    const items = Array.isArray(value) ? value.filter(isScalar).map(String) : isScalar(value) ? [String(value)] : [];
    if (items.length === 0) return undefined;
    // `|join` (#404): with ", " in every language, as a built-in view joined names; `|list` in the UI language's way.
    return filter === "join" ? items.join(", ") : formatList(items);
  }
  if (!isScalar(value)) return undefined;
  const text = String(value);
  // In lower case (ADR-0167 amendment): an Istio host as Istio compares it.
  if (filter === "lower") return text.toLowerCase();
  // The first line that is not blank, trimmed (#404), as the built-in views read a trace.
  if (filter === "firstLine") return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  if (filter === "lastSegment") return text.slice(Math.max(text.lastIndexOf("."), text.lastIndexOf("/")) + 1);
  return text;
}

/** The rule's message for the object: by the CLDR plural form of `pluralBy` in the UI language (#404), else `message`. */
function messageOf(rule: ProblemContribution, obj: KubeObject): string {
  if (rule.pluralBy === undefined || rule.messageForms === undefined) return rule.message;
  const n = numberOf(valueAt(obj, rule.pluralBy));
  if (n === undefined) return rule.message;
  let form = "other";
  try {
    form = new Intl.PluralRules(currentLanguage()).select(n);
  } catch {
    // An odd language tag: `other`.
  }
  return rule.messageForms[form] ?? rule.message;
}

/** `template` with each `{{path}}` replaced by the scalar value there (clipped; anything else shows nothing). */
/** Where a message names the objects a `missing` of a list did not find (#404); `judgeAcross` fills it. */
export const MISSING_MARK = "{{missing}}";

/** Where a message names the objects a `related` or `relatedBy` found (ADR-0167 amendment); `judgeAcross` fills it. */
export const FOUND_MARK = "{{found}}";

/** Where a message names the namespaces a `selectsNone` looked in (ADR-0169); `judgeAcross` fills it. */
export const SELECTS_IN_MARK = "{{selectsNone:namespaces}}";

/** Where a message shows a text of a judge's fact (`{{fact:<name>}}`, ADR-0168); `judgeAcross` fills it. */
export const FACT_MARK = /\{\{\s*fact:\s*([A-Za-z][A-Za-z0-9-]*)\s*\}\}/g;

export function renderMessage(template: string, obj: KubeObject): string {
  const text = template.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner: string) => {
    // `{{missing}}` (#404) is filled once the rows say which named objects are not there (`judgeAcross`).
    if (inner.trim() === "missing") return MISSING_MARK;
    if (inner.trim() === "found") return FOUND_MARK;
    if (inner.trim() === "selectsNone:namespaces") return SELECTS_IN_MARK;
    // `{{fact:<name>}}` (ADR-0168) once the judge's answer gives it.
    const fact = /^\s*fact:\s*([A-Za-z][A-Za-z0-9-]*)\s*$/.exec(inner);
    if (fact) return `{{fact:${fact[1]}}}`;
    const shown = placeholderText(obj, inner);
    if (shown === undefined) return "";
    return Array.from(shown).length > MAX_VALUE_CHARS ? `${Array.from(shown).slice(0, MAX_VALUE_CHARS).join("")}…` : shown;
  });
  // Text from the cluster: a URI loses its credentials, query and fragment, as everywhere else.
  const cleaned = cleanText(text) ?? "";
  const chars = Array.from(cleaned);
  return chars.length > MAX_MESSAGE_CHARS ? `${chars.slice(0, MAX_MESSAGE_CHARS).join("")}…` : cleaned;
}

/** The problems one rule finds in `obj`: none, or one. */
export function detectRule(rule: ProblemContribution, obj: KubeObject, ctx: RuleContext = {}): Detected[] {
  const verdict = evaluate(rule.when, obj, ctx);
  if (!verdict.holds) return [];
  // `since`, else the first of `sinceOr` that holds a time (#407), else the condition's own.
  // With `sinceUnit: "seconds"` (#404) the values are seconds since 1970.
  const asTime = (v: unknown): string | undefined => {
    if (rule.sinceUnit === "seconds") {
      const n = numberOf(v);
      return n === undefined || n <= 0 ? undefined : new Date(n * 1000).toISOString();
    }
    return typeof v === "string" && timeOf(v) !== undefined ? v : undefined;
  };
  const since =
    rule.since !== undefined ? [rule.since, ...(rule.sinceOr ?? [])].map((path) => asTime(valueAt(obj, path))).find((v) => v !== undefined) : verdict.since;
  // The reason from the object (#370), cleaned like the message; `reasonOr` (#404), else the title, when it comes out
  // empty.
  const reason = rule.reason === undefined ? "" : renderMessage(rule.reason, obj).trim();
  return [
    {
      reason: reason === "" ? (rule.reasonOr ?? rule.title) : Array.from(reason).slice(0, MAX_REASON_CHARS).join(""),
      // Rules of one group notify once per object (ADR-0161).
      group: rule.group ?? rule.id,
      rule: rule.id,
      message: renderMessage(messageOf(rule, obj), obj),
      since: typeof since === "string" && timeOf(since) !== undefined ? since : undefined,
      graceMs: rule.graceMinutes > 0 ? rule.graceMinutes * MINUTE_MS : undefined,
      activeFrom: verdict.activeFrom,
      // `expiring` (#404): the store moves the warning when the setting changes (`applyCertExpiryDays`).
      ...(verdict.expiresAt !== undefined ? { expiresAt: verdict.expiresAt } : {}),
      ...(verdict.until !== undefined ? { until: verdict.until } : {}),
      notify: rule.notify,
      ...(verdict.lookups ? { lookups: verdict.lookups } : {}),
      ...(rule.toldThroughOwner ? controllerOf(obj) : {}),
      ...aboutOf(rule, obj),
      ...stampOf(rule, obj),
      ...(rule.notifyAgainOn ? { notifyTag: JSON.stringify(rule.notifyAgainOn.map((path) => valueAt(obj, path) ?? null)) } : {}),
    },
  ];
}

/**
 * The object a rule's `about` names (#405), and — unless the rule has its own `notifyAs` — notifications about it, once
 * per object; nothing when its name (or a read kind) is missing: the problem stays about the judged object.
 */
function aboutOf(rule: ProblemContribution, obj: KubeObject): { object?: ObjectRef; notifyAs?: string } {
  const own = notifyAsOf(rule, obj);
  const about = rule.about;
  if (!about) return own;
  const text = (path: string | undefined) => {
    const value = path === undefined ? undefined : valueAt(obj, path);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const name = text(about.namePath);
  let kind: KindRef | undefined = about.kind;
  if (!kind) {
    const apiVersion = text(about.apiVersionPath);
    const k = text(about.kindPath);
    if (apiVersion && k) {
      const slash = apiVersion.lastIndexOf("/");
      kind = { group: slash < 0 ? "" : apiVersion.slice(0, slash), version: slash < 0 ? apiVersion : apiVersion.slice(slash + 1), kind: k };
    }
  }
  if (!name || !kind) return own;
  const namespace = about.clusterScoped ? null : about.namespacePath !== undefined ? (text(about.namespacePath) ?? null) : (obj.metadata?.namespace ?? null);
  const object: ObjectRef = { kind, namespace, name };
  return { object, notifyAs: own.notifyAs ?? `${kind.group}/${kind.kind}/${namespace ?? ""}/${name}` };
}

/** The progress `stamp` names (#405): when it changes, the problem counts as first seen again. */
function stampOf(rule: ProblemContribution, obj: KubeObject): { stamp?: string } {
  if (!rule.stamp) return {};
  return { stamp: JSON.stringify(rule.stamp.map((path) => valueAt(obj, path) ?? null)) };
}

/**
 * The notification identity a rule's `notifyAs` gives (#394): `<kind>/<namespace>/<value>` when the path has a value
 * (the runs of one CronWorkflow notify as one); else none, and the object's own counts.
 */
function notifyAsOf(rule: ProblemContribution, obj: KubeObject): { notifyAs?: string } {
  if (rule.notifyAs === undefined) return {};
  const value = valueAt(obj, rule.notifyAs);
  if (!isScalar(value) || String(value) === "") return {};
  return { notifyAs: `${rule.kind.group}/${rule.kind.kind}/${obj.metadata?.namespace ?? ""}/${String(value)}` };
}

/** The uid of the object's controller (`ownerUid`), when it has one. */
function controllerOf(obj: KubeObject): { ownerUid?: string } {
  const owners = (obj.metadata as { ownerReferences?: unknown }).ownerReferences;
  if (!Array.isArray(owners)) return {};
  const controller = owners.find((o): o is { uid: string } => {
    const owner = o as { controller?: unknown; uid?: unknown } | null;
    return owner?.controller === true && typeof owner.uid === "string";
  });
  return controller ? { ownerUid: controller.uid } : {};
}

/** `group/kind` in lower case: how rules and watched kinds are matched (kinds compare ignoring case). */
export const kindKeyOf = (kind: { group: string; kind: string }): string => `${kind.group.toLowerCase()}/${kind.kind.toLowerCase()}`;

/** The rules grouped by kind, each kind's as one detector. */
export function compileRules(
  rules: readonly ProblemContribution[],
): Map<string, (obj: KubeObject, ctx?: RuleContext) => Detected[]> {
  const byKind = new Map<string, ProblemContribution[]>();
  for (const rule of rules) {
    const key = kindKeyOf(rule.kind);
    byKind.set(key, [...(byKind.get(key) ?? []), rule]);
  }
  return new Map(
    [...byKind].map(([key, list]) => [key, (obj: KubeObject, ctx: RuleContext = {}) => list.flatMap((rule) => detectRule(rule, obj, ctx))] as const),
  );
}
