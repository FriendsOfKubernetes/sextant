// Problem rules of extensions (`contributes.problems`, ADR-0137), evaluated by the window on the problems store's own
// watches: no extension code runs for them. Pure functions; the manifest was checked in Rust when it was read
// (`crates/sextant-core/src/extensions/problems.rs`: the paths are field paths of the custom columns' grammar that
// read no secret, conditions nest at most 3 deep), so a path that does not parse here only matches nothing.
//
//   compileRules(rules)          // per kind: (obj) => Detected[]
//   renderMessage(template, obj) // `{{path}}` placeholders filled with scalar values, cleaned and capped
import type { KubeObject, ProblemCondition, ProblemContribution, ProblemScalar } from "../api";
import { parseFieldPath, type PathStep } from "../features/custom-columns/path";
import type { Detected } from "../features/problems/model";
import { cleanText } from "../resources/uri";

/** A placeholder shows at most this many characters of its value. */
export const MAX_VALUE_CHARS = 100;
/** A message shows at most this many characters. */
export const MAX_MESSAGE_CHARS = 300;

const MINUTE_MS = 60_000;

/** The value at a field path; `undefined` when the path does not parse or leads nowhere. */
export function valueAt(obj: unknown, path: string): unknown {
  const steps = parseFieldPath(path.trim());
  return steps ? walk(obj, steps) : undefined;
}

function walk(obj: unknown, steps: readonly PathStep[]): unknown {
  let at: unknown = obj;
  for (const step of steps) {
    if (at === null || typeof at !== "object") return undefined;
    if ("index" in step) {
      if (!Array.isArray(at)) return undefined;
      at = at[step.index];
    } else {
      if (Array.isArray(at) || !Object.prototype.hasOwnProperty.call(at, step.key)) return undefined;
      at = (at as Record<string, unknown>)[step.key];
    }
  }
  return at;
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** A number, or a string that is nothing but one (`"85.5"`); `undefined` otherwise. */
function numberOf(value: unknown): number | undefined {
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

/** What a condition says of an object. */
export interface Verdict {
  /** It holds (now, or from `activeFrom` on). */
  holds: boolean;
  /** It holds only from this time (ms): an `olderThan` that is not yet old enough counts from then. */
  activeFrom?: number;
  /** When the state began, as an entry of `.status.conditions` says (its `lastTransitionTime`). */
  since?: string;
}

const NO: Verdict = { holds: false };

/** Whether `condition` holds for `obj`. Values compare by type: `"3"` is not `3` (but `above`/`below` read both). */
export function evaluate(condition: ProblemCondition, obj: KubeObject): Verdict {
  switch (condition.type) {
    case "equals":
      return { holds: sameScalar(valueAt(obj, condition.path), condition.value) };
    case "in": {
      const value = valueAt(obj, condition.path);
      return { holds: condition.values.some((v) => sameScalar(value, v)) };
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
    case "olderThan": {
      const t = timeOf(valueAt(obj, condition.path));
      return t === undefined ? NO : { holds: true, activeFrom: t + condition.minutes * MINUTE_MS };
    }
    case "all": {
      let activeFrom: number | undefined;
      let since: string | undefined;
      for (const inner of condition.of) {
        const v = evaluate(inner, obj);
        if (!v.holds) return NO;
        if (v.activeFrom !== undefined) activeFrom = Math.max(activeFrom ?? v.activeFrom, v.activeFrom);
        since ??= v.since;
      }
      return { holds: true, activeFrom, since };
    }
    case "any": {
      // The earliest branch counts: one that holds now (no `activeFrom`) before one that holds later.
      let best: Verdict | undefined;
      for (const inner of condition.of) {
        const v = evaluate(inner, obj);
        if (!v.holds) continue;
        if (v.activeFrom === undefined) return v;
        if (!best || (best.activeFrom ?? Infinity) > v.activeFrom) best = v;
      }
      return best ?? NO;
    }
  }
}

function sameScalar(value: unknown, expected: ProblemScalar): boolean {
  return isScalar(value) && typeof value === typeof expected && value === expected;
}

/** `template` with each `{{path}}` replaced by the scalar value there (clipped; anything else shows nothing). */
export function renderMessage(template: string, obj: KubeObject): string {
  const text = template.replace(/\{\{([\s\S]*?)\}\}/g, (_, path: string) => {
    const value = valueAt(obj, path);
    if (!isScalar(value)) return "";
    const shown = String(value);
    return Array.from(shown).length > MAX_VALUE_CHARS ? `${Array.from(shown).slice(0, MAX_VALUE_CHARS).join("")}…` : shown;
  });
  // Text from the cluster: a URI loses its credentials, query and fragment, as everywhere else.
  const cleaned = cleanText(text) ?? "";
  const chars = Array.from(cleaned);
  return chars.length > MAX_MESSAGE_CHARS ? `${chars.slice(0, MAX_MESSAGE_CHARS).join("")}…` : cleaned;
}

/** The problems one rule finds in `obj`: none, or one. */
export function detectRule(rule: ProblemContribution, obj: KubeObject): Detected[] {
  const verdict = evaluate(rule.when, obj);
  if (!verdict.holds) return [];
  const since = rule.since !== undefined ? valueAt(obj, rule.since) : verdict.since;
  return [
    {
      reason: rule.title,
      group: rule.id,
      message: renderMessage(rule.message, obj),
      since: typeof since === "string" && timeOf(since) !== undefined ? since : undefined,
      graceMs: rule.graceMinutes > 0 ? rule.graceMinutes * MINUTE_MS : undefined,
      activeFrom: verdict.activeFrom,
      notify: rule.notify,
    },
  ];
}

/** `group/kind` in lower case: how rules and watched kinds are matched (kinds compare ignoring case). */
export const kindKeyOf = (kind: { group: string; kind: string }): string => `${kind.group.toLowerCase()}/${kind.kind.toLowerCase()}`;

/** The rules grouped by kind, each kind's as one detector. */
export function compileRules(rules: readonly ProblemContribution[]): Map<string, (obj: KubeObject) => Detected[]> {
  const byKind = new Map<string, ProblemContribution[]>();
  for (const rule of rules) {
    const key = kindKeyOf(rule.kind);
    byKind.set(key, [...(byKind.get(key) ?? []), rule]);
  }
  return new Map(
    [...byKind].map(([key, list]) => [key, (obj: KubeObject) => list.flatMap((rule) => detectRule(rule, obj))] as const),
  );
}
