// Reflector's namespace matching (`MirroringPropertiesExtensions.cs`): a comma-separated list of regular expressions
// (`PatternListMatch`) OR a label selector on the namespace (`LabelSelectorMatch`); both empty: every namespace.
// Pure. See the header of model.ts for where JavaScript cannot follow .NET exactly.
import { MAX_PATTERN_LENGTH, MAX_PATTERNS, type Tri } from "./model";

/** A pattern list split as Reflector splits it: on every comma, blank entries dropped, each trimmed. */
export function patternsOf(list: string): string[] {
  return list
    .split(",")
    .filter((s) => s.trim() !== "")
    .map((s) => s.trim());
}

/** A repeated group that itself contains a repetition (`(a+)+`, `(\w*)*`): it can backtrack for ever. */
const NESTED_REPEAT = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,?\d*\})/;

export type PatternIssue = "invalid" | "notEvaluated";

/** The compiled pattern, or why it is not run (cached by text). */
const compiled = new Map<string, RegExp | PatternIssue>();

export function compilePattern(pattern: string): RegExp | PatternIssue {
  const hit = compiled.get(pattern);
  if (hit !== undefined) return hit;
  let out: RegExp | PatternIssue;
  if (pattern.length > MAX_PATTERN_LENGTH || NESTED_REPEAT.test(pattern)) out = "notEvaluated";
  else {
    try {
      out = new RegExp(pattern);
    } catch {
      out = "invalid";
    }
  }
  if (compiled.size > 2000) compiled.clear();
  compiled.set(pattern, out);
  return out;
}

/** `Regex.Match(value, pattern)` whose match is the whole value: the first match found must cover it. */
export function patternMatches(pattern: string, value: string): Tri {
  const re = compilePattern(pattern);
  if (typeof re === "string") return undefined;
  const m = re.exec(value);
  return m !== null && m.index === 0 && m[0].length === value.length;
}

/** `PatternListMatch`: an empty list matches; else any pattern; a pattern not run leaves "no" open. */
export function patternListMatches(list: string, value: string): Tri {
  const patterns = patternsOf(list);
  if (patterns.length === 0) return true;
  let unknown = patterns.length > MAX_PATTERNS;
  for (const p of patterns.slice(0, MAX_PATTERNS)) {
    const m = patternMatches(p, value);
    if (m === true) return true;
    if (m === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

/** The patterns of a list that are not run, with why. */
export function patternIssues(list: string): { pattern: string; issue: PatternIssue }[] {
  return patternsOf(list).flatMap((pattern) => {
    const re = compilePattern(pattern);
    return typeof re === "string" ? [{ pattern, issue: re }] : [];
  });
}

// ---- label selectors, parsed as `TryParseLabelSelector` parses them ----

type Requirement =
  | { op: "in" | "notin"; key: string; values: string[] }
  | { op: "exists" | "doesNotExist"; key: string };

const LABEL_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const LABEL_PREFIX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LABEL_VALUE = /^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/;
const SET_BASED = /^(\S+)\s+(in|notin)\s*\(([^)]*)\)$/;

function validKey(key: string): boolean {
  if (key === "") return false;
  const slash = key.indexOf("/");
  let name = key;
  if (slash >= 0) {
    const prefix = key.slice(0, slash);
    if (prefix.length === 0 || prefix.length > 253 || !LABEL_PREFIX.test(prefix)) return false;
    name = key.slice(slash + 1);
  }
  return name.length > 0 && name.length <= 63 && LABEL_NAME.test(name);
}

const validValue = (value: string) => value.length <= 63 && LABEL_VALUE.test(value);

function splitRequirements(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      const part = selector.slice(start, i).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }
  const last = selector.slice(start).trim();
  if (last) out.push(last);
  return out;
}

function parseRequirement(r: string): Requirement | undefined {
  const set = SET_BASED.exec(r);
  if (set) {
    const values = set[3]!
      .split(",")
      .filter((v) => v !== "")
      .map((v) => v.trim());
    if (!validKey(set[1]!) || values.length === 0 || !values.every(validValue)) return undefined;
    return { op: set[2] === "in" ? "in" : "notin", key: set[1]!, values };
  }
  if (r.includes("!=")) {
    const at = r.indexOf("!=");
    const key = r.slice(0, at).trim();
    const value = r.slice(at + 2).trim();
    return validKey(key) && validValue(value) ? { op: "notin", key, values: [value] } : undefined;
  }
  const double = r.indexOf("==");
  const single = r.indexOf("=");
  if (double >= 0 || single >= 0) {
    const at = double >= 0 ? double : single;
    const key = r.slice(0, at).trim();
    const value = r.slice(at + (double >= 0 ? 2 : 1)).trim();
    return validKey(key) && validValue(value) ? { op: "in", key, values: [value] } : undefined;
  }
  const negated = r.startsWith("!");
  const key = negated ? r.slice(1).trim() : r;
  return validKey(key) ? { op: negated ? "doesNotExist" : "exists", key } : undefined;
}

/** The requirements of a selector; `undefined` when Reflector cannot parse it (then it matches no namespace). */
export function parseSelector(selector: string): Requirement[] | undefined {
  if (selector.trim() === "") return [];
  const parts = splitRequirements(selector);
  if (parts.length === 0) return undefined;
  const out: Requirement[] = [];
  for (const p of parts) {
    const r = parseRequirement(p);
    if (!r) return undefined;
    out.push(r);
  }
  return out;
}

/** `LabelSelectorMatch`: an unparsable selector matches nothing (fail closed). */
export function selectorMatches(selector: string, labels: Readonly<Record<string, string>>): boolean {
  const reqs = parseSelector(selector);
  if (!reqs) return false;
  return reqs.every((r) => {
    const has = Object.prototype.hasOwnProperty.call(labels, r.key);
    switch (r.op) {
      case "in":
        return has && r.values.includes(labels[r.key]!);
      case "notin":
        return !(has && r.values.includes(labels[r.key]!));
      case "exists":
        return has;
      case "doesNotExist":
        return !has;
    }
  });
}

/**
 * `MatchNamespace`: the pattern list OR the selector; both empty: every namespace. `labels` `null`: the namespace
 * does not exist (Reflector's cache has no such namespace: a selector fails closed); `undefined`: not known yet.
 */
export function namespaceMatches(patterns: string, selector: string, namespace: string, labels: Readonly<Record<string, string>> | null | undefined): Tri {
  const hasPatterns = patterns !== "";
  const hasSelector = selector !== "";
  if (!hasPatterns && !hasSelector) return true;
  let byName: Tri = false;
  if (hasPatterns) {
    byName = patternListMatches(patterns, namespace);
    if (byName === true) return true;
  }
  if (!hasSelector) return byName;
  if (labels === undefined) return undefined;
  if (labels !== null && selectorMatches(selector, labels)) return true;
  return byName === undefined ? undefined : false;
}
