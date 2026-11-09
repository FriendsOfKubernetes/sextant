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
import { formatList } from "../i18n/format";
import { cleanText } from "../resources/uri";

/** A placeholder shows at most this many characters of its value: a controller's whole condition message (#373). */
export const MAX_VALUE_CHARS = 1000;
/** A message shows at most this many characters (notifications and agents clip it further). */
export const MAX_MESSAGE_CHARS = 1200;
/** A reason from the object shows at most this many characters. */
export const MAX_REASON_CHARS = 100;

const MINUTE_MS = 60_000;

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
    if (filter === "sum") {
      if (!Array.isArray(value)) return undefined;
      const numbers = value.map(numberOf).filter((n): n is number => n !== undefined);
      return numbers.length === 0 ? undefined : numbers.reduce((a, b) => a + b, 0);
    }
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
      return { holds: sameScalar(valueAt(obj, condition.path), condition.value) };
    case "in": {
      const value = valueAt(obj, condition.path);
      return { holds: condition.values.some((v) => sameScalar(value, v)) };
    }
    // Text conditions (#405): a string value only; no pattern language, so no backtracking.
    case "contains":
    case "startsWith": {
      const value = valueAt(obj, condition.path);
      if (typeof value !== "string") return NO;
      const fold = (text: string) => (condition.ignoreCase ? text.toLowerCase() : text);
      const text = fold(value);
      const test = condition.type === "contains" ? (v: string) => text.includes(fold(v)) : (v: string) => text.startsWith(fold(v));
      return { holds: condition.values.some(test) };
    }
    case "exists": {
      const value = valueAt(obj, condition.path);
      return { holds: value !== undefined && value !== null };
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
      const a = numberOf(valueAt(obj, condition.path));
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
  const bar = inner.indexOf("|");
  const path = bar < 0 ? inner : inner.slice(0, bar);
  const filter = bar < 0 ? undefined : inner.slice(bar + 1).trim();
  const value = valueAt(obj, path);
  if (filter === "count") {
    if (Array.isArray(value)) return String(value.length);
    return value !== null && typeof value === "object" ? String(Object.keys(value).length) : undefined;
  }
  if (filter === "list") {
    const items = Array.isArray(value) ? value.filter(isScalar).map(String) : isScalar(value) ? [String(value)] : [];
    return items.length === 0 ? undefined : formatList(items);
  }
  if (!isScalar(value)) return undefined;
  const text = String(value);
  if (filter === "firstLine") return text.split(/\r?\n/)[0];
  if (filter === "lastSegment") return text.slice(Math.max(text.lastIndexOf("."), text.lastIndexOf("/")) + 1);
  return text;
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
      message: renderMessage(rule.message, obj),
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
