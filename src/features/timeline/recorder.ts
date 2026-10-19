// Change timeline (#145): the recorder. It opens no watch of its own: it observes every update of the watches the
// window already has open (`observeWatchUpdates`: tables, the problem sources behind the sidebar counter and the
// notifications, the map's and the timeline page's shared watches), keeps a short text of each object it saw
// (`canonical(projection(…))`), and records a change whenever a newer version of an object differs from it.
//
//   startRecorder()                    // once (index.ts)
//   getTimeline(clusterId)             // the recorded changes, oldest first
//   subscribeTimeline / timelineVersion  for useSyncExternalStore
//
// Who: watches carry no `managedFields`, so after a change the recorder asks for the object's field managers
// (`api.timeline.managers`, batched, at most `MAX_LOOKUPS` objects per call and one call per cluster at a time) and
// names the managers whose time moved (`changedManagers`).
//
// Bounded: per cluster a ring of `MAX_ENTRIES` changes and about `MAX_ENTRY_BYTES` of them; the objects' texts share
// `BASELINE_BUDGET` characters over all clusters (beyond it an object is kept as a hash: a change is still noticed,
// without its fields) and at most `MAX_BASELINES` objects per cluster. Nothing about a Secret's values is ever kept:
// they do not reach the window, and the projection keeps key names only.
//
// Persistence (off by default, `settings.timeline.persist`): a cluster's changes are loaded when the recorder first
// sees it and saved a few seconds after they change (`api.timeline.save`).
import {
  api,
  loadSettings,
  observeWatchUpdates,
  toApiError,
  updateSettings,
  type ApiError,
  type ClusterId,
  type FieldManager,
  type KindRef,
  type KubeObject,
  type WatchOptions,
  type WatchSpec,
  type WatchUpdate,
} from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import {
  canonical,
  changedManagers,
  controllerKind,
  diffObjects,
  isOwnedRun,
  isRecordedKind,
  projection,
  type FieldChange,
  type Who,
} from "./model";

/** Recorded changes kept per cluster (the oldest go first). */
export const MAX_ENTRIES = 5000;
/** About this many characters of recorded changes are kept per cluster. */
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
/** Characters of object texts kept over all clusters; beyond it objects are kept as a hash. */
export const BASELINE_BUDGET = 24 * 1024 * 1024;
/** An object whose text is longer is kept as a hash. */
export const MAX_BASELINE_CHARS = 64 * 1024;
/** Objects remembered per cluster; past it the least recently seen are forgotten. */
export const MAX_BASELINES = 20_000;
/** A saved timeline is at most this many bytes (`timeline::MAX_SAVED_BYTES`): the oldest changes are left out. */
export const MAX_SAVED_BYTES = 8 * 1024 * 1024;
/** Objects whose field managers are asked for in one call. */
export const MAX_LOOKUPS = 50;
/** Objects waiting for their managers per cluster; beyond it a change stays without "who". */
export const MAX_PENDING_LOOKUPS = 200;
/** How long changes gather before their managers are asked for. */
export const LOOKUP_DELAY_MS = 1500;
/** Field managers remembered per cluster (to tell whose time moved). */
export const MAX_KNOWN_MANAGERS = 5000;
/** A new object counts as created (not just newly seen) when it is at most this old. */
export const CREATED_WITHIN_MS = 10 * 60_000;
/** A save waits this long after the last change. */
export const SAVE_DELAY_MS = 5000;

export type ChangeAction = "created" | "updated" | "deleted";

/** One recorded change of one object. */
export interface ChangeEntry {
  id: number;
  /** When Sextant saw it (ms, this machine's clock). */
  at: number;
  /**
   * Seen in a fresh list after nothing watched the object for a while (a reconnect, a page opened again): it was made
   * at some time before `at`.
   */
  late: boolean;
  action: ChangeAction;
  kind: KindRef;
  namespace: string | null;
  name: string;
  uid: string;
  changes: FieldChange[];
  /** Changes left out beyond `MAX_CHANGES`. */
  more: number;
  /** The object's earlier text was kept only as a hash: what changed is not known. */
  summaryOnly?: boolean;
  /** `undefined`: still being looked up; `null`: cannot be told. */
  who?: Who | null;
}

interface Baseline {
  /** `canonical(projection)`, or `#<hash>` when kept as a hash. */
  text: string;
  rv: string;
  /** The version it was read in: another version of the same object is another text, not a change. */
  apiVersion: string;
  /** It has a controller: its coming and going is its owner's story. */
  owned: boolean;
  kind: KindRef;
  namespace: string | null;
  name: string;
}

interface ClusterLog {
  entries: ChangeEntry[];
  bytes: number;
  baselines: Map<string, Baseline>;
  /** Field managers as last read, by uid. */
  managers: Map<string, FieldManager[]>;
  /** Waiting for their managers: uid → the object and the entries to fill. */
  pending: Map<string, { kind: KindRef; namespace: string | null; name: string; ids: number[] }>;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: boolean;
  loaded: boolean;
  saveTimer?: ReturnType<typeof setTimeout>;
}

const logs = new Map<ClusterId, ClusterLog>();
const listeners = new Set<() => void>();
let version = 0;
let nextId = 1;
let baselineChars = 0;
let clock: () => number = () => Date.now();
let stopObserving: (() => void) | undefined;
let persist = false;
let persistKnown = false;
let maxBaselines = MAX_BASELINES;

function changed(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

function logOf(clusterId: ClusterId): ClusterLog {
  let log = logs.get(clusterId);
  if (!log) {
    log = { entries: [], bytes: 0, baselines: new Map(), managers: new Map(), pending: new Map(), inFlight: false, loaded: false };
    logs.set(clusterId, log);
    void loadSaved(clusterId, log);
  }
  return log;
}

const uidOf = (obj: KubeObject) => obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;

/** Whether resource version `a` is older than or the same as `b` (numeric when both are, as etcd's are). */
function notNewer(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return a.length < b.length || (a.length === b.length && a <= b);
  return a === b;
}

/** What an entry takes as saved JSON (the `who` filled in later counts as up to a few managers). */
function entrySize(entry: ChangeEntry): number {
  return JSON.stringify(entry).length + (entry.who === undefined ? 300 : 0);
}

/** Keeps `baseline` as the most recently seen; past `MAX_BASELINES` the least recently seen object is forgotten. */
function setBaseline(log: ClusterLog, uid: string, baseline: Baseline): void {
  const old = log.baselines.get(uid);
  if (old) {
    baselineChars -= old.text.length;
    log.baselines.delete(uid);
  } else if (log.baselines.size >= maxBaselines) {
    const oldest = log.baselines.keys().next().value;
    if (oldest !== undefined) dropBaseline(log, oldest);
  }
  log.baselines.set(uid, baseline);
  baselineChars += baseline.text.length;
}

function dropBaseline(log: ClusterLog, uid: string): void {
  const old = log.baselines.get(uid);
  if (!old) return;
  baselineChars -= old.text.length;
  log.baselines.delete(uid);
  log.managers.delete(uid);
}

/** The text an object is kept as: its canonical projection, or a hash past the budget. */
function textOf(full: string, previous: Baseline | undefined): string {
  const room = BASELINE_BUDGET - baselineChars + (previous?.text.length ?? 0);
  if (full.length > MAX_BASELINE_CHARS || full.length > room) return `#${full.length}:${hashOf(full)}`;
  return full;
}

function hashOf(text: string): string {
  // Two different seeds of FNV-1a: collisions are not a concern at this scale.
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

/** Two kept texts are of the same object state (a hash compares with the hash of the full text). */
function sameText(kept: string, full: string): boolean {
  if (kept.startsWith("#")) return kept === `#${full.length}:${hashOf(full)}`;
  return kept === full;
}

function record(clusterId: ClusterId, log: ClusterLog, entry: Omit<ChangeEntry, "id">): void {
  const full: ChangeEntry = { ...entry, id: nextId++ };
  log.entries.push(full);
  log.bytes += entrySize(full);
  while (log.entries.length > MAX_ENTRIES || (log.bytes > MAX_ENTRY_BYTES && log.entries.length > 1)) {
    const gone = log.entries.shift()!;
    log.bytes -= entrySize(gone);
  }
  if (full.who === undefined) lookUp(clusterId, log, full);
  scheduleSave(clusterId, log);
}

/** One version of one object, from any watch. */
function see(clusterId: ClusterId, log: ClusterLog, kind: KindRef, obj: KubeObject, fresh: boolean): boolean {
  if (isOwnedRun(kind, obj)) return false;
  const uid = uidOf(obj);
  const rv = String(obj.metadata?.resourceVersion ?? "");
  const previous = log.baselines.get(uid);
  if (previous && rv && previous.rv && notNewer(rv, previous.rv)) return false;
  const full = canonical(projection(kind, obj));
  const apiVersion = String(obj.apiVersion ?? "");
  const base = {
    kind,
    namespace: obj.metadata?.namespace ?? null,
    name: obj.metadata?.name ?? "",
    owned: controllerKind(obj) !== undefined,
  };
  if (!previous || previous.apiVersion !== apiVersion) {
    setBaseline(log, uid, { ...base, text: textOf(full, previous), rv, apiVersion });
    if (previous) return false;
    if (fresh || base.owned) return false;
    const created = Date.parse(String(obj.metadata?.creationTimestamp ?? ""));
    if (Number.isNaN(created) || clock() - created > CREATED_WITHIN_MS) return false;
    record(clusterId, log, { ...entryBase(base, uid), at: clock(), late: false, action: "created", changes: [], more: 0 });
    return true;
  }
  if (sameText(previous.text, full)) {
    // Seen again: the most recently seen go last.
    setBaseline(log, uid, { ...previous, rv });
    return false;
  }
  let changes: FieldChange[] = [];
  let more = 0;
  let summaryOnly: true | undefined;
  if (previous.text.startsWith("#")) {
    summaryOnly = true;
  } else {
    const diff = diffObjects(kind, JSON.parse(previous.text), JSON.parse(full));
    changes = diff.changes;
    more = diff.more;
  }
  setBaseline(log, uid, { ...base, text: textOf(full, previous), rv, apiVersion });
  record(clusterId, log, {
    ...entryBase(base, uid),
    at: clock(),
    late: fresh,
    action: "updated",
    changes,
    more,
    ...(summaryOnly ? { summaryOnly } : {}),
  });
  return true;
}

function entryBase(base: { kind: KindRef; namespace: string | null; name: string }, uid: string) {
  return { kind: base.kind, namespace: base.namespace, name: base.name, uid };
}

/** A field selector by name only: what leaves such a list was deleted (or renamed, which Kubernetes cannot do). */
const BY_NAME = /^metadata\.name=([^,=]+)$/;

/**
 * Whether a watch of `spec` tells deletions: an object leaves a list narrowed by labels or fields (other than its
 * name) when it stops matching, which is a change of it, not a deletion — such lists are not recorded from.
 */
export function followsDeletions(spec: WatchSpec): boolean {
  return !spec.labelSelector && (!spec.fieldSelector || BY_NAME.test(spec.fieldSelector));
}

/**
 * A fresh, complete list of `spec`: the remembered objects it would hold but does not were deleted while nothing
 * watched them (or are out of reach now): they are forgotten, without a record — when is not known.
 */
function prune(log: ClusterLog, spec: WatchSpec, listed: ReadonlySet<string>): void {
  const namespaces = spec.namespaces ? new Set(spec.namespaces) : null;
  const name = spec.fieldSelector ? BY_NAME.exec(spec.fieldSelector)?.[1] : undefined;
  for (const [uid, b] of [...log.baselines]) {
    if (listed.has(uid) || b.kind.group !== spec.kind.group || b.kind.kind !== spec.kind.kind) continue;
    if (namespaces && (b.namespace === null || !namespaces.has(b.namespace))) continue;
    if (name !== undefined && b.name !== name) continue;
    dropBaseline(log, uid);
  }
}

/** Uids of the lists that arrive in parts (`WatchOptions.progressive`), by cluster and spec, until their end. */
const listing = new Map<string, Set<string>>();

/** Whether a list of `count` objects is the whole list: a capped watch that kept its cap may have left some out. */
function isWhole(count: number, options: WatchOptions | undefined): boolean {
  return options?.maxObjects === undefined || count < options.maxObjects;
}

/** Every update of every watch the window has open. */
export function observe(clusterId: ClusterId, spec: WatchSpec, update: WatchUpdate, options?: WatchOptions): void {
  if (spec.metadataOnly || !isRecordedKind(spec.kind) || !followsDeletions(spec)) return;
  if (update.type === "reconnecting" || update.type === "error" || update.type === "forbidden" || update.type === "capped") {
    return;
  }
  const log = logOf(clusterId);
  let any = false;
  // A list's objects keep the kind's served version; an object's own apiVersion may be the same kind in another one.
  const kind = spec.kind;
  const listKey = JSON.stringify([clusterId, spec]);
  if (update.type === "snapshot") {
    listing.delete(listKey);
    const items = update.items as KubeObject[];
    if (isWhole(items.length, options)) prune(log, spec, new Set(items.map(uidOf)));
    for (const obj of items) any = see(clusterId, log, kind, obj, true) || any;
  } else if (update.type === "snapshotPart" || update.type === "snapshotEnd") {
    // A list in parts: every part is a baseline (no "created"); its end prunes like a whole snapshot.
    const listed = listing.get(listKey) ?? new Set<string>();
    listing.set(listKey, listed);
    const items = update.items as KubeObject[];
    for (const obj of items) {
      listed.add(uidOf(obj));
      any = see(clusterId, log, kind, obj, true) || any;
    }
    if (update.type === "snapshotEnd") {
      listing.delete(listKey);
      for (const uid of update.deleted) {
        listed.delete(uid);
        dropBaseline(log, uid);
      }
      if (isWhole(listed.size, options)) prune(log, spec, listed);
    }
  } else {
    for (const obj of update.upserted as KubeObject[]) any = see(clusterId, log, kind, obj, false) || any;
    for (const uid of update.deleted) {
      const gone = log.baselines.get(uid);
      if (!gone) continue;
      dropBaseline(log, uid);
      if (gone.owned) continue;
      record(clusterId, log, {
        ...entryBase(gone, uid),
        at: clock(),
        late: false,
        action: "deleted",
        changes: [],
        more: 0,
        who: null,
      });
      any = true;
    }
  }
  if (any) {
    // Recorded in place above: one new array for the readers.
    log.entries = [...log.entries];
    changed();
  }
}

// ---------- Who ----------

function lookUp(clusterId: ClusterId, log: ClusterLog, entry: ChangeEntry): void {
  const waiting = log.pending.get(entry.uid);
  if (waiting) waiting.ids.push(entry.id);
  else if (log.pending.size >= MAX_PENDING_LOOKUPS) {
    entry.who = null;
    return;
  } else {
    log.pending.set(entry.uid, { kind: entry.kind, namespace: entry.namespace, name: entry.name, ids: [entry.id] });
  }
  log.timer ??= setTimeout(() => {
    log.timer = undefined;
    void flushLookups(clusterId, log);
  }, LOOKUP_DELAY_MS);
}

function setWho(log: ClusterLog, ids: readonly number[], who: Who | null): void {
  const wanted = new Set(ids);
  log.entries = log.entries.map((e) => (wanted.has(e.id) ? { ...e, who } : e));
}

async function flushLookups(clusterId: ClusterId, log: ClusterLog): Promise<void> {
  if (log.inFlight || log.pending.size === 0 || logs.get(clusterId) !== log) return;
  const batch = [...log.pending.entries()].slice(0, MAX_LOOKUPS);
  for (const [uid] of batch) log.pending.delete(uid);
  log.inFlight = true;
  try {
    const found = await api.timeline.managers(
      clusterId,
      batch.map(([, p]) => ({ kind: p.kind, namespace: p.namespace, name: p.name })),
    );
    batch.forEach(([uid, p], i) => {
      const read = found[i];
      if (!read || read.error || (read.uid && read.uid !== uid && !uid.includes("/"))) {
        setWho(log, p.ids, null);
        return;
      }
      setWho(log, p.ids, changedManagers(log.managers.get(uid), read.managers));
      log.managers.delete(uid);
      log.managers.set(uid, read.managers);
      if (log.managers.size > MAX_KNOWN_MANAGERS) {
        const oldest = log.managers.keys().next().value;
        if (oldest !== undefined) log.managers.delete(oldest);
      }
    });
  } catch {
    for (const [, p] of batch) setWho(log, p.ids, null);
  } finally {
    log.inFlight = false;
  }
  changed();
  scheduleSave(clusterId, log);
  if (log.pending.size > 0) {
    log.timer ??= setTimeout(() => {
      log.timer = undefined;
      void flushLookups(clusterId, log);
    }, LOOKUP_DELAY_MS);
  }
}

// ---------- Persistence ----------

interface SavedTimeline {
  version: 1;
  cluster: ClusterId;
  entries: readonly ChangeEntry[];
}

async function persistOn(): Promise<boolean> {
  if (persistKnown) return persist;
  try {
    persist = (await loadSettings()).timeline?.persist === true;
  } catch {
    persist = false;
  }
  persistKnown = true;
  return persist;
}

async function loadSaved(clusterId: ClusterId, log: ClusterLog): Promise<void> {
  if (!(await persistOn())) return;
  let text: string | null;
  try {
    text = await api.timeline.load(clusterId);
  } catch {
    return;
  }
  if (logs.get(clusterId) !== log || log.loaded) return;
  log.loaded = true;
  if (!text) return;
  let saved: SavedTimeline;
  try {
    saved = JSON.parse(text) as SavedTimeline;
  } catch {
    return;
  }
  const restored = (Array.isArray(saved.entries) ? saved.entries : [])
    .filter((e) => e && typeof e.at === "number" && e.kind && typeof e.name === "string")
    .map((e) => ({ ...e, id: nextId++, who: e.who === undefined ? null : e.who }));
  const firstNow = log.entries[0]?.at ?? Infinity;
  log.entries = [...restored.filter((e) => e.at < firstNow), ...log.entries].slice(-MAX_ENTRIES);
  log.bytes = log.entries.reduce((sum, e) => sum + entrySize(e), 0);
  changed();
}

function scheduleSave(clusterId: ClusterId, log: ClusterLog): void {
  if (!persist) return;
  if (log.saveTimer) clearTimeout(log.saveTimer);
  log.saveTimer = setTimeout(() => {
    log.saveTimer = undefined;
    void save(clusterId, log);
  }, SAVE_DELAY_MS);
}

/** Per cluster, the last write or removal of its file: the next one waits for it, so writes never overlap. */
const writes = new Map<ClusterId, Promise<void>>();
/** The last save that failed (shown once on the page until a save succeeds). */
let saveError: ApiError | null = null;

const encoder = new TextEncoder();

/**
 * The saved form of `entries`: the oldest are left out until it fits `MAX_SAVED_BYTES` (UTF-8, as the backend
 * counts), so a full ring of long texts still saves.
 */
export function savedText(clusterId: ClusterId, entries: readonly ChangeEntry[]): string {
  let kept = entries;
  for (;;) {
    const text = JSON.stringify({ version: 1, cluster: clusterId, entries: kept } satisfies SavedTimeline);
    // Most texts are ASCII: the length is the size; only a text that may be too big is encoded.
    if (text.length * 3 <= MAX_SAVED_BYTES || encoder.encode(text).length <= MAX_SAVED_BYTES || kept.length === 0) return text;
    kept = kept.slice(Math.max(1, Math.ceil(kept.length / 10)));
  }
}

/** Writes (`text`) or removes (`null`) the cluster's file after any write of it still running. */
function write(clusterId: ClusterId, text: string | null): Promise<void> {
  const run = (writes.get(clusterId) ?? Promise.resolve()).then(async () => {
    try {
      await api.timeline.save(clusterId, text);
      if (saveError) {
        saveError = null;
        changed();
      }
    } catch (err) {
      // Not writable: the timeline stays in memory, the page says so, and the next change tries again.
      saveError = toApiError(err);
      changed();
    }
  });
  writes.set(clusterId, run);
  return run;
}

async function save(clusterId: ClusterId, log: ClusterLog): Promise<void> {
  if (!persist || logs.get(clusterId) !== log) return;
  await write(clusterId, savedText(clusterId, log.entries));
}

/** Why the last save failed, `null` when the last one worked. */
export function timelineSaveError(): ApiError | null {
  return saveError;
}

/** Whether recorded changes are kept between runs. */
export function persistEnabled(): boolean {
  return persist;
}

/**
 * Turns keeping the timeline between runs on or off (`settings.timeline.persist`). Turning it on saves what is
 * recorded now; turning it off removes every saved timeline of the known clusters.
 */
export async function setPersist(on: boolean): Promise<void> {
  await updateSettings((s) => ({ ...s, timeline: { ...s.timeline, persist: on } }));
  persist = on;
  persistKnown = true;
  changed();
  if (on) {
    for (const [id, log] of logs) {
      log.loaded = true;
      await save(id, log);
    }
    return;
  }
  // Every cluster's file, also of clusters no longer in any kubeconfig, after the writes still running.
  for (const log of logs.values()) {
    if (log.saveTimer) clearTimeout(log.saveTimer);
    log.saveTimer = undefined;
  }
  await Promise.all([...writes.values()]);
  try {
    await api.timeline.removeAll();
    saveError = null;
  } catch (err) {
    saveError = toApiError(err);
  }
  changed();
}

/** Forgets the cluster's recorded changes (and its saved file, while persistence is on); objects stay followed. */
export function clearTimeline(clusterId: ClusterId): void {
  const log = logs.get(clusterId);
  if (!log) return;
  log.entries = [];
  log.bytes = 0;
  changed();
  if (persist) void write(clusterId, null);
}

// ---------- Reading ----------

const EMPTY: readonly ChangeEntry[] = [];

/** The recorded changes of the cluster, oldest first; a new array after each change. */
export function getTimeline(clusterId: ClusterId): readonly ChangeEntry[] {
  return logs.get(clusterId)?.entries ?? EMPTY;
}

export function subscribeTimeline(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function timelineVersion(): number {
  return version;
}

/**
 * Forgets what is kept for a cluster whose connection went away (its objects are listed afresh when it connects
 * again) — after saving its changes, while persistence is on, so they come back from the file.
 */
function evict(clusterId: ClusterId): void {
  const log = logs.get(clusterId);
  if (!log) return;
  if (log.timer) clearTimeout(log.timer);
  if (log.saveTimer) clearTimeout(log.saveTimer);
  for (const uid of [...log.baselines.keys()]) dropBaseline(log, uid);
  if (persist && log.loaded) void write(clusterId, savedText(clusterId, log.entries));
  logs.delete(clusterId);
  changed();
}

let unfollow: (() => void) | undefined;
const connected = new Map<ClusterId, boolean>();

/** Evicts a cluster when it disconnects or leaves the kubeconfigs. */
function followClusters(): void {
  const look = (states: ReturnType<typeof useClustersStore.getState>["states"]) => {
    for (const id of new Set([...Object.keys(states), ...connected.keys()])) {
      const now = states[id]?.state === "connected";
      const was = connected.get(id);
      if (states[id] === undefined) connected.delete(id);
      else connected.set(id, now);
      if (was === true && !now) evict(id);
    }
  };
  look(useClustersStore.getState().states);
  unfollow = useClustersStore.subscribe((s, prev) => {
    if (s.states !== prev.states) look(s.states);
  });
}

/** Starts observing the window's watches (once). */
export function startRecorder(): void {
  stopObserving ??= observeWatchUpdates(observe);
  if (!unfollow) followClusters();
}

/** Stops and forgets everything (tests); `now` replaces the clock. */
export function resetRecorder(now: (() => number) | null = null): void {
  listing.clear();
  stopObserving?.();
  stopObserving = undefined;
  unfollow?.();
  unfollow = undefined;
  connected.clear();
  writes.clear();
  saveError = null;
  maxBaselines = MAX_BASELINES;
  for (const log of logs.values()) {
    if (log.timer) clearTimeout(log.timer);
    if (log.saveTimer) clearTimeout(log.saveTimer);
  }
  logs.clear();
  baselineChars = 0;
  nextId = 1;
  persist = false;
  persistKnown = false;
  clock = now ?? (() => Date.now());
  changed();
}

/** Replaces `MAX_BASELINES` (tests); `null` restores it. */
export function setMaxBaselines(n: number | null): void {
  maxBaselines = n ?? MAX_BASELINES;
}

/** Objects remembered for the cluster now (tests). */
export function baselineCount(clusterId: ClusterId): number {
  return logs.get(clusterId)?.baselines.size ?? 0;
}

/** Characters of object texts kept now (tests). */
export function baselineSize(): number {
  return baselineChars;
}
