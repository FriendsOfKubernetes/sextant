// Problem judges of extensions (ADR-0168): the extension's backend decides which objects have which facts, and the
// rules' `judged` conditions turn those facts into problems with Sextant's texts. The window collects the objects of
// the kinds a judge reads from the problems store's own sources (the rows of `judgeAcross`, which keep only the
// judge's declared paths), and asks Rust (`api.extensions.problemJudge`), which checks and projects them again and
// runs the backend with no way out to the cluster or the network.
//
// One runner per cluster × extension × judge:
// - it calls the judge when the objects it would send changed, at most once per `JUDGE_INTERVAL_MS` and never twice at
//   once (a change during a call is sent when the interval allows; a failed call is tried again after
//   `JUDGE_RETRY_MS`);
// - it cannot tell — so its rules give no problem — while any read list is not read in full (loading, failed, capped,
//   not served or not readable there), holds more than `MAX_JUDGED_OBJECTS_PER_KIND` objects or more than
//   `MAX_JUDGE_PAYLOAD_CHARS`, and after a failed or timed-out call: an earlier answer is never kept past a failure;
// - an answer replaces the one before; while a newer call waits, the last answer stands.
//
// - a kind a read marks `optional` that the cluster does not serve is sent as no objects (the input's `notServed`);
//   one that is served but not read in full still cannot tell;
// - a namespaced kind read only in some namespaces (the extension's scope or the user's accessible ones narrowed its
//   source, or the API server refused some, `JudgedRows.forbidden`) cannot tell either, unless its read is `partial`:
//   then its objects go with `partial: [{kind, readNamespaces?, unreadNamespaces}]` for it (ADR-0168 amendment);
// - an entry keeps what its fact says it rests on (`needs`), which an agent must be able to read to be told it;
// - an answer may give a fact of an object several times, each with its own texts (a rule judged `each` tells one
//   problem per entry, ADR-0168 amendment); each entry is remembered with the time it first came, kept across a
//   failed call, so a problem it tells keeps its age.
//
//   observeJudge(clusterId, extensionId, judge, reads)    // from the judged sources' `judge`, on every look
//   judgedFact(clusterId, extensionId, judgeId, fact, uid)  // the fact's first texts, or null
//   judgedFacts(clusterId, extensionId, judgeId, fact, uid) // every entry of the fact with its key and first time
//   onJudgeAnswer(listener)                                 // the store looks again at the extension's sources
import { api, type JudgedFact, type JudgedNeed, type JudgedObject, type JudgedPartial, type ProblemJudgeContribution } from "../api";
import type { JudgedRows } from "../features/problems/sources";

/** At most one call per runner in this time. */
export const JUDGE_INTERVAL_MS = 5000;
/** A failed call is tried again with the same objects after this long. */
export const JUDGE_RETRY_MS = 60_000;
/** A judge gets at most this many objects of a kind (Rust's `MAX_JUDGED_OBJECTS_PER_KIND`). */
export const MAX_JUDGED_OBJECTS_PER_KIND = 5000;
/** The objects of one call as JSON, in characters, at most (Rust refuses more than 8 MiB). */
export const MAX_JUDGE_PAYLOAD_CHARS = 8 * 1024 * 1024;

/** What a row of a read kind keeps for the judges (`rowOf`): only what they may be sent. */
export interface JudgedRowPart {
  apiVersion: string;
  creationTimestamp?: string;
  /** Declared path → the value there (the paths of every judge that reads the kind). */
  values: Record<string, unknown>;
}

/** A kind a judge reads, with the rows of its source in the cluster. */
export interface JudgeInput {
  read: ProblemJudgeContribution["reads"][number];
  /** `kind` as served (the source's). */
  kind: string;
  rows: JudgedRows | undefined;
  /** An `optional` read the cluster does not serve: no objects, nothing read (so nothing an agent must be able to read). */
  notServed?: boolean;
  /** The kind has namespaces (the served kind's): only then can it be read in some namespaces only. Default `true`. */
  namespaced?: boolean;
}

/** The rows of an `optional` read the cluster does not serve: read in full, and empty. */
export const NOT_SERVED_ROWS: JudgedRows = Object.freeze({ status: "ready", rows: new Map(), truncated: false, namespaces: null }) as JudgedRows;

/** One entry of a fact the judge gave an object: its texts, the key they make, and when it first came (ms). */
export interface JudgedEntry {
  values: Record<string, string>;
  /** What the fact says it rests on (`needs`); `undefined`: not said, so every kind the judge read where it read them. */
  needs?: readonly JudgedNeed[];
  /** Stable while the texts are the same: what tells the problems of an `each` rule apart. */
  key: string;
  since: number;
}

interface Runner {
  clusterId: string;
  extensionId: string;
  judgeId: string;
  /** The rows maps last looked at: unchanged maps need no new look. */
  seen: readonly (ReadonlyMap<string, unknown> | undefined)[];
  seenStatus: string;
  /** The objects last sent or waiting, as JSON. */
  key?: string;
  waiting?: { objects: JudgedObject[]; partial: JudgedPartial[]; key: string };
  inFlight: boolean;
  lastCallAt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** uid → fact → its entries in the answer's order; `null`: cannot tell. */
  answer: Map<string, Map<string, JudgedEntry[]>> | null;
  /** `uid|fact|key` → when that entry first came; kept across a failure, pruned by the next answer. */
  firstSeen: Map<string, number>;
  /** What the judge read: each kind and the namespaces its source watched. */
  reads: { group: string; kind: string; namespaces: readonly string[] | null }[];
}

const runners = new Map<string, Runner>();
const listeners = new Set<(clusterId: string, extensionId: string) => void>();
let clock: () => number = () => Date.now();

const runnerKey = (clusterId: string, extensionId: string, judgeId: string) => `${clusterId}|${extensionId}|${judgeId}`;

/** Tells the problems store to look again at the extension's sources in the cluster. */
export function onJudgeAnswer(listener: (clusterId: string, extensionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function told(runner: Runner): void {
  for (const listener of [...listeners]) listener(runner.clusterId, runner.extensionId);
}

const usable = (rows: JudgedRows | undefined): rows is JudgedRows =>
  rows !== undefined && (rows.status === "ready" || rows.status === "reconnecting") && !rows.truncated;

/**
 * Where a read input was not read: `null` when read everywhere it could be (a kind without namespaces, a source of
 * every namespace with none refused), else the namespaces read (`readNamespaces`, when its source watched only some)
 * and those refused (`unreadNamespaces`).
 */
function unreadOf({ read, rows, namespaced }: JudgeInput): JudgedPartial | null {
  if (!rows || namespaced === false) return null;
  const forbidden = rows.forbidden ?? [];
  const watched = rows.namespaces;
  if ((watched === null || watched === undefined) && forbidden.length === 0) return null;
  return {
    kind: { group: read.kind.group, kind: read.kind.kind },
    ...(watched ? { readNamespaces: [...new Set(watched)].filter((ns) => !forbidden.includes(ns)).sort() } : {}),
    unreadNamespaces: [...forbidden],
  };
}

/** The objects of the inputs as the judge gets them, and where `partial` reads were not read; `null` when it cannot tell. */
function objectsOf(inputs: readonly JudgeInput[]): { objects: JudgedObject[]; partial: JudgedPartial[] } | null {
  const out: JudgedObject[] = [];
  const partial: JudgedPartial[] = [];
  for (const input of inputs) {
    const { read, kind, rows } = input;
    if (!usable(rows) || rows.rows.size > MAX_JUDGED_OBJECTS_PER_KIND) return null;
    // Read in some namespaces only: unknown elsewhere — told to a `partial` read, else nothing can be told.
    const unread = input.notServed ? null : unreadOf(input);
    if (unread) {
      if (read.partial !== true) return null;
      partial.push(unread);
    }
    for (const [uid, value] of rows.rows) {
      const row = value as { name?: string; namespace?: string; judged?: JudgedRowPart };
      if (!row.judged || !row.name) return null;
      const values: Record<string, unknown> = {};
      for (const path of read.paths) if (row.judged.values[path] !== undefined) values[path] = row.judged.values[path];
      out.push({
        apiVersion: row.judged.apiVersion,
        kind,
        metadata: {
          name: row.name,
          ...(row.namespace ? { namespace: row.namespace } : {}),
          uid,
          ...(row.judged.creationTimestamp ? { creationTimestamp: row.judged.creationTimestamp } : {}),
        },
        values,
      });
    }
  }
  return { objects: out.sort((a, b) => (a.metadata.uid < b.metadata.uid ? -1 : a.metadata.uid > b.metadata.uid ? 1 : 0)), partial };
}

function cannotTell(runner: Runner): void {
  runner.answer = null;
  runner.waiting = undefined;
  runner.key = undefined;
  if (runner.timer !== undefined) clearTimeout(runner.timer);
  runner.timer = undefined;
}

function schedule(runner: Runner): void {
  if (runner.inFlight || runner.timer !== undefined || !runner.waiting) return;
  const wait = Math.max(0, runner.lastCallAt + JUDGE_INTERVAL_MS - clock());
  runner.timer = setTimeout(() => {
    runner.timer = undefined;
    send(runner);
  }, wait);
}

function send(runner: Runner): void {
  const sending = runner.waiting;
  if (!sending || runner.inFlight || runners.get(runnerKey(runner.clusterId, runner.extensionId, runner.judgeId)) !== runner) return;
  runner.waiting = undefined;
  runner.inFlight = true;
  runner.lastCallAt = clock();
  const current = () => runners.get(runnerKey(runner.clusterId, runner.extensionId, runner.judgeId)) === runner;
  api.extensions.problemJudge(runner.extensionId, runner.judgeId, runner.clusterId, sending.objects, sending.partial).then(
    (facts) => {
      runner.inFlight = false;
      if (!current()) return;
      // The lists changed so that it cannot tell meanwhile: this answer is of objects no longer in hand.
      if (runner.key === undefined) return;
      runner.answer = indexFacts(facts, runner.firstSeen, clock());
      told(runner);
      schedule(runner);
    },
    () => {
      runner.inFlight = false;
      if (!current()) return;
      // A failed or timed-out call: no earlier answer stands; the same objects are tried again after
      // `JUDGE_RETRY_MS`, or sooner when they change.
      const had = runner.answer !== null;
      runner.answer = null;
      if (runner.key !== undefined && !runner.waiting) {
        runner.waiting = sending;
        runner.lastCallAt = clock() + JUDGE_RETRY_MS - JUDGE_INTERVAL_MS;
      }
      if (had) told(runner);
      schedule(runner);
    },
  );
}

/** The key of a fact entry's texts: the same texts, the same key, whatever order they were given in. */
export function entryKey(values: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.keys(values).sort().map((name) => [name, values[name]]));
}

function indexFacts(facts: readonly JudgedFact[], firstSeen: Map<string, number>, now: number): Map<string, Map<string, JudgedEntry[]>> {
  const out = new Map<string, Map<string, JudgedEntry[]>>();
  const seen = new Map<string, number>();
  for (const { uid, fact, values, needs } of facts) {
    const of = out.get(uid) ?? new Map<string, JudgedEntry[]>();
    const entries = of.get(fact) ?? [];
    const texts = values ?? {};
    const key = entryKey(texts);
    // Rust keeps one of each; the same again changes nothing.
    if (!entries.some((e) => e.key === key)) {
      const slot = `${uid}|${fact}|${key}`;
      const since = firstSeen.get(slot) ?? now;
      seen.set(slot, since);
      entries.push({ values: texts, key, since, ...(needs !== undefined ? { needs } : {}) });
    }
    of.set(fact, entries);
    out.set(uid, of);
  }
  // What the answer no longer gives is forgotten: it comes back as new.
  firstSeen.clear();
  for (const [slot, since] of seen) firstSeen.set(slot, since);
  return out;
}

/**
 * Looks at the inputs of a judge in a cluster: what cannot tell makes its rules give nothing at once; objects that
 * changed are sent when the interval allows. Called on every look of the judged sources; cheap while their rows
 * maps are the same.
 */
export function observeJudge(clusterId: string, extensionId: string, judge: ProblemJudgeContribution, inputs: readonly JudgeInput[]): void {
  const key = runnerKey(clusterId, extensionId, judge.id);
  let runner = runners.get(key);
  if (!runner) {
    runner = { clusterId, extensionId, judgeId: judge.id, seen: [], seenStatus: "", inFlight: false, lastCallAt: -Infinity, answer: null, firstSeen: new Map(), reads: [] };
    runners.set(key, runner);
  }
  const seen = inputs.map((i) => i.rows?.rows);
  const status = inputs.map((i) => `${i.rows?.status ?? "-"}${i.rows?.truncated ? "!" : ""}`).join(",");
  if (status === runner.seenStatus && seen.length === runner.seen.length && seen.every((rows, i) => rows === runner.seen[i])) return;
  runner.seen = seen;
  runner.seenStatus = status;
  // A kind not served was not read: an agent need not be able to read it to be told what the judge decided. Of one
  // read in part, the namespaces it was read in (one refused everywhere else stays "every namespace").
  runner.reads = inputs
    .filter((i) => !i.notServed)
    .map(({ read, rows }) => {
      const watched = rows?.namespaces ?? null;
      const forbidden = rows?.forbidden ?? [];
      return { group: read.kind.group, kind: read.kind.kind, namespaces: watched && watched.filter((ns) => !forbidden.includes(ns)) };
    });
  const found = objectsOf(inputs);
  const text = found && JSON.stringify(found);
  if (!found || !text || text.length > MAX_JUDGE_PAYLOAD_CHARS) {
    cannotTell(runner);
    return;
  }
  if (text === runner.key) return;
  runner.key = text;
  // Nothing to judge: no fact, without asking.
  if (found.objects.length === 0) {
    runner.waiting = undefined;
    runner.answer = new Map();
    runner.firstSeen.clear();
    return;
  }
  runner.waiting = { objects: found.objects, partial: found.partial, key: text };
  schedule(runner);
}

/** The texts of `fact` the judge's latest answer gives for the object `uid` first; `null` when it gives none or cannot tell. */
export function judgedFact(clusterId: string, extensionId: string, judgeId: string, fact: string, uid: string): Record<string, string> | null {
  return judgedFacts(clusterId, extensionId, judgeId, fact, uid)?.[0]?.values ?? null;
}

/** Every entry of `fact` the judge's latest answer gives for the object `uid`, in its order; `null` when none or it cannot tell. */
export function judgedFacts(clusterId: string, extensionId: string, judgeId: string, fact: string, uid: string): readonly JudgedEntry[] | null {
  const runner = runners.get(runnerKey(clusterId, extensionId, judgeId));
  const entries = runner?.answer?.get(uid)?.get(fact);
  return entries && entries.length > 0 ? entries : null;
}

/** What the judge read in the cluster: each kind and the namespaces its source watched (`null`: every one). */
export function judgeReads(clusterId: string, extensionId: string, judgeId: string): Runner["reads"] {
  return runners.get(runnerKey(clusterId, extensionId, judgeId))?.reads ?? [];
}

/** Forgets the runners of a cluster (its connection came or went), or of every cluster. */
export function forgetJudges(clusterId?: string): void {
  for (const [key, runner] of [...runners]) {
    if (clusterId !== undefined && runner.clusterId !== clusterId) continue;
    cannotTell(runner);
    runners.delete(key);
  }
}

/** Tests: a clock of their own (`null`: the real one). */
export function setJudgesClock(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}
