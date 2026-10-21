// Reflector's namespace patterns are matched in the core, never in the window (ADR-0110): a pattern comes from a
// cluster object, and a backtracking engine (JavaScript's `RegExp`) can be frozen for seconds by `(a|a)*b` on a short
// name. The core's `reflector_match_patterns` runs the `regex` crate (linear time, size-capped) and answers yes / no /
// cannot tell per pattern and name, with the reason a pattern is not run.
//
// Lookups are synchronous over a cache: a pair not known yet is "pending" (callers show "cannot tell") and is queued;
// the queue is sent once per `FLUSH_DELAY_MS` as calls of at most `MAX_PATTERNS_PER_CALL` patterns × `MAX_NAMES_PER_CALL`
// names, and the listeners hear when answers arrive (the store then rebuilds its state). A failed call leaves its pairs
// "cannot tell" for `RETRY_AFTER_MS`, then they are asked again on the next lookup.
import { api, type PatternIssue, type PatternMatch } from "../../api";
import type { Tri } from "./model";

export const FLUSH_DELAY_MS = 0;
export const MAX_PATTERNS_PER_CALL = 64;
export const MAX_NAMES_PER_CALL = 2000;
export const RETRY_AFTER_MS = 30_000;
/** Patterns cached at most; past it the cache starts again. */
export const MAX_CACHED_PATTERNS = 2000;

interface Known {
  /** `null`: the pattern runs; `undefined`: not known yet. */
  issue: PatternIssue | null | undefined;
  names: Map<string, Tri>;
  /** When a call with this pattern last failed. */
  failedAt?: number;
}

const cache = new Map<string, Known>();
/** Pairs to ask for: pattern → names (an empty set asks for the pattern's issue only). */
const queued = new Map<string, Set<string>>();
/** Pairs asked for and not answered yet. */
const inflight = new Map<string, Set<string>>();
const running = new Set<Promise<void>>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

function known(pattern: string): Known {
  let k = cache.get(pattern);
  if (!k) {
    if (cache.size >= MAX_CACHED_PATTERNS) cache.clear();
    k = { issue: undefined, names: new Map() };
    cache.set(pattern, k);
  }
  return k;
}

const has = (m: Map<string, Set<string>>, pattern: string, name: string | undefined) => {
  const set = m.get(pattern);
  return set !== undefined && (name === undefined || set.has(name));
};

function ask(pattern: string, name: string | undefined): void {
  if (has(queued, pattern, name) || has(inflight, pattern, name)) return;
  const set = queued.get(pattern) ?? new Set<string>();
  if (name !== undefined) set.add(name);
  queued.set(pattern, set);
  timer ??= setTimeout(flush, FLUSH_DELAY_MS);
}

const failedRecently = (k: Known | undefined) => k?.failedAt !== undefined && Date.now() - k.failedAt < RETRY_AFTER_MS;

/** Pattern on name: yes, no, `undefined` (cannot tell), or "pending" (asked, no answer yet). */
export function matchResult(pattern: string, name: string): Tri | "pending" {
  const k = cache.get(pattern);
  if (k?.names.has(name)) return k.names.get(name);
  if (failedRecently(k)) return undefined;
  ask(pattern, name);
  return "pending";
}

/** Why the pattern is not run (`null`: it runs), or "pending". A failed call tells nothing: `null`. */
export function issueOf(pattern: string): PatternIssue | null | "pending" {
  const k = cache.get(pattern);
  if (k && k.issue !== undefined) return k.issue;
  if (failedRecently(k)) return null;
  ask(pattern, undefined);
  return "pending";
}

const toTri = (m: PatternMatch | undefined): Tri => (m === "yes" ? true : m === "no" ? false : undefined);

function chunks<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function call(patterns: string[], names: string[], gen: number): Promise<void> {
  try {
    const result = await api.reflector.matchPatterns(patterns, names);
    if (gen !== generation) return;
    if (result.length !== patterns.length) throw new Error("unexpected answer");
    patterns.forEach((pattern, i) => {
      const k = known(pattern);
      const r = result[i]!;
      k.issue = r.issue ?? null;
      delete k.failedAt;
      names.forEach((name, j) => k.names.set(name, toTri(r.matches[j])));
    });
  } catch {
    if (gen !== generation) return;
    for (const pattern of patterns) known(pattern).failedAt = Date.now();
  }
  for (const pattern of patterns) {
    const set = inflight.get(pattern);
    if (!set) continue;
    for (const name of names) set.delete(name);
    if (set.size === 0) inflight.delete(pattern);
  }
}

function flush(): void {
  timer = undefined;
  if (queued.size === 0) return;
  const batch = [...queued];
  queued.clear();
  for (const [pattern, names] of batch) {
    const set = inflight.get(pattern) ?? new Set<string>();
    for (const n of names) set.add(n);
    inflight.set(pattern, set);
  }
  const gen = generation;
  const calls: Promise<void>[] = [];
  for (const group of chunks(batch, MAX_PATTERNS_PER_CALL)) {
    const patterns = group.map(([p]) => p);
    const names = [...new Set(group.flatMap(([, n]) => [...n]))];
    for (const part of chunks(names, MAX_NAMES_PER_CALL)) calls.push(call(patterns, part, gen));
  }
  const done = Promise.all(calls).then(() => {
    running.delete(done);
    if (gen !== generation) return;
    // A pattern asked with no names: its entry is clear once answered.
    for (const [pattern] of batch) if (inflight.get(pattern)?.size === 0) inflight.delete(pattern);
    for (const fn of [...listeners]) fn();
  });
  running.add(done);
}

/** Called after each batch of answers. */
export function subscribePatternResults(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Sends what is queued now and waits for every call in flight (tests). */
export async function settlePatterns(): Promise<void> {
  for (let i = 0; i < 5 && (queued.size > 0 || running.size > 0); i++) {
    if (timer) {
      clearTimeout(timer);
      flush();
    }
    await Promise.all([...running]);
  }
}

/** Forgets every answer and drops what is queued or in flight (tests). */
export function resetPatternMatcher(): void {
  generation++;
  cache.clear();
  queued.clear();
  inflight.clear();
  running.clear();
  if (timer) clearTimeout(timer);
  timer = undefined;
}
