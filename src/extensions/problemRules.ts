// Problem rules of extensions (`contributes.problems`, ADR-0137), evaluated by the window on the problems store's own
// watches: no extension code runs for them. Pure functions; the manifest was checked in Rust when it was read
// (`crates/sextant-core/src/extensions/problems.rs`: the paths are field paths of the custom columns' grammar that
// read no secret, conditions nest at most 3 deep), so a path that does not parse here only matches nothing.
//
//   compileRules(rules)          // per kind: (obj) => Detected[]
//   renderMessage(template, obj) // `{{path}}` placeholders filled with scalar values, cleaned and capped
import type { KindRef, KubeObject, ObjectRef, ProblemCondition, ProblemContribution, ProblemScalar } from "../api";
import { parseFieldPath, pickStep, type PathStep } from "../features/custom-columns/path";
import type { Detected } from "../features/problems/model";
import { currentLanguage, formatList } from "../i18n/format";
import { cleanText } from "../resources/uri";

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

/** The value at a field path; `undefined` when the path does not parse or leads nowhere. */
export function valueAt(obj: unknown, path: string): unknown {
  // A compared path may end in `|sum` (a list's numbers added) or `|count` (a list's items, a map's entries; #407).
  const bar = path.lastIndexOf("|");
  if (bar >= 0) {
    const filter = path.slice(bar + 1).trim();
    const value = valueAt(obj, path.slice(0, bar));
    if (filter === "count") return Array.isArray(value) ? value.length : value !== null && typeof value === "object" ? Object.keys(value).length : undefined;
    if (filter === "sum") return sumOf(value);
    return undefined;
  }
  const steps = parseFieldPath(path.trim());
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
        return (at as unknown[]).map((item) => walk(item, rest)).filter((v) => v !== undefined);
      }
    } else {
      if (Array.isArray(at) || !Object.prototype.hasOwnProperty.call(at, step.key)) return undefined;
      at = (at as Record<string, unknown>)[step.key];
    }
  }
  return at;
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

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
}

const NO: Verdict = { holds: false };

/** Whether `condition` holds for `obj`. Values compare by type: `"3"` is not `3` (but `above`/`below` read both). */
/** What the problems store knows of an object beyond the object (#393). */
export interface RuleContext {
  /** When the object entered its label-selected source, as the store saw it (not for objects already there). */
  enteredAt?: number;
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
      const test =
        condition.type === "contains"
          ? (v: string) => text.includes(fold(v))
          : condition.type === "startsWith"
            ? (v: string) => text.startsWith(fold(v))
            : (v: string) => text.endsWith(fold(v));
      return { holds: condition.values.some(test) };
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
      // Both as numbers (a list as its length); not a number on either side never holds (#386).
      // `addPaths` (#407): their numbers added to `path`'s first.
      const parts = [condition.path, ...(condition.addPaths ?? [])].map((p) => numberOf(valueAt(obj, p)));
      const a = parts.some((n) => n === undefined) ? undefined : (parts as number[]).reduce((x, y) => x + y, 0);
      const b = numberOf(valueAt(obj, condition.otherPath));
      // `offset` (#407): added to the other value first.
      return { holds: a !== undefined && b !== undefined && a >= b + (condition.offset ?? 0) };
    }
    case "olderThan": {
      const value = valueAt(obj, condition.path);
      const t = timeOf(value);
      // `orUnreadable` (#405): a value that is there but no time holds at once.
      if (t === undefined) return condition.orUnreadable && value !== undefined && value !== null && value !== "" ? { holds: true } : NO;
      return { holds: true, activeFrom: t + condition.minutes * MINUTE_MS };
    }
    case "missing": {
      // Nothing named, nothing missing.
      const name = valueAt(obj, condition.path);
      if (typeof name !== "string" || name.trim() === "") return NO;
      return { holds: true, lookups: [{ group: condition.kind.group, kind: condition.kind.kind, name }] };
    }
    case "related": {
      // Nothing named, nothing related; the named object's own condition is judged on its row (#409).
      const name = valueAt(obj, condition.path);
      if (typeof name !== "string" || name.trim() === "") return NO;
      return { holds: true, lookups: [{ group: condition.kind.group, kind: condition.kind.kind, name, fact: factKey(condition.when) }] };
    }
    case "all": {
      let activeFrom: number | undefined;
      let until: number | undefined;
      let since: string | undefined;
      let lookups: Lookup[] | undefined;
      for (const inner of condition.of) {
        const v = evaluate(inner, obj, ctx);
        if (!v.holds) return NO;
        if (v.activeFrom !== undefined) activeFrom = Math.max(activeFrom ?? v.activeFrom, v.activeFrom);
        if (v.until !== undefined) until = Math.min(until ?? v.until, v.until);
        since ??= v.since;
        if (v.lookups) lookups = [...(lookups ?? []), ...v.lookups];
      }
      // A window that closes before it opens never holds.
      if (activeFrom !== undefined && until !== undefined && until <= activeFrom) return NO;
      const verdict: Verdict = { holds: true, activeFrom, since };
      if (until !== undefined) verdict.until = until;
      if (lookups) verdict.lookups = lookups;
      return verdict;
    }
    case "any": {
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
export function fillTemplate(template: string, obj: KubeObject, options: { emptyIsMissing?: boolean } = {}): string | null {
  let missing = false;
  const text = template.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner: string) => {
    const shown = placeholderText(obj, inner);
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
export function placeholderText(obj: KubeObject, inner: string): string | undefined {
  // Up to two filters in a row (`|firstLine|clip:300`, #404): the first reads the value, `clip:<n>` cuts the text.
  const [path = "", ...filters] = inner.split("|").map((part, i) => (i === 0 ? part : part.trim()));
  const filter = filters.find((f) => !f.startsWith("clip:"));
  // Paths tried in turn with `??` (#404): the first whose value is there and not an empty text.
  const tried = splitOutsideQuotes(path, "??");
  if (tried.length > 1) {
    for (const [i, one] of tried.entries()) {
      // The last may be a literal (#404): `{{.status.updated ?? 0}}`, `{{.value ?? "*"}}`.
      const literal = i === tried.length - 1 ? placeholderLiteral(one.trim()) : undefined;
      if (literal !== undefined) return literal;
      const text = filteredText(valueAt(obj, one.trim()), filter);
      if (text !== undefined && text !== "") return clipped(text, filters);
    }
    return undefined;
  }
  // Paths added with `+` before `|sum` (#404): the numbers of every path there, nothing when none is.
  const added = filter === "sum" ? addedPaths(path) : [path];
  const text =
    added.length > 1
      ? (() => {
          const sums = added.map((p) => sumOf([valueAt(obj, p.trim())])).filter((n): n is number => n !== undefined);
          return sums.length === 0 ? undefined : String(sums.reduce((a, b) => a + b, 0));
        })()
      : filteredText(valueAt(obj, path), filter);
  return text === undefined ? undefined : clipped(text, filters);
}

/** `text` cut by the shortest `clip:<n>` among `filters`, with "…"; as it is without one. */
function clipped(text: string, filters: readonly string[]): string {
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

function filteredText(value: unknown, filter: string | undefined): string | undefined {
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
  if (filter === "unique") {
    // Each text once, sorted by code point (#404): the policies a report names, as the built-in Kyverno message did.
    const items = Array.isArray(value) ? value.filter(isScalar).map(String) : isScalar(value) ? [String(value)] : [];
    const unique = [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return unique.length === 0 ? undefined : formatList(unique);
  }
  if (filter === "list" || filter === "join") {
    const items = Array.isArray(value) ? value.filter(isScalar).map(String) : isScalar(value) ? [String(value)] : [];
    if (items.length === 0) return undefined;
    // `|join` (#404): with ", " in every language, as a built-in view joined names; `|list` in the UI language's way.
    return filter === "join" ? items.join(", ") : formatList(items);
  }
  if (!isScalar(value)) return undefined;
  const text = String(value);
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
export function renderMessage(template: string, obj: KubeObject): string {
  const text = template.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner: string) => {
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
      message: renderMessage(messageOf(rule, obj), obj),
      since: typeof since === "string" && timeOf(since) !== undefined ? since : undefined,
      graceMs: rule.graceMinutes > 0 ? rule.graceMinutes * MINUTE_MS : undefined,
      activeFrom: verdict.activeFrom,
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
