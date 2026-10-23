// Live problems of watched kinds, shared by the problems screen, the sidebar badge and the notifications: one watch per
// (cluster, kind) however many of them ask, opened by the first `acquireSource` and closed a few seconds after the last
// release (a remount reuses it). Only problems are kept, never the objects: each update is reduced to the problems of
// the objects it carries at once, and a source keeps at most `MAX_PROBLEM_OBJECTS` objects with problems.
//
//   const release = acquireSource(clusterId, def);  // starts (or shares) the watch
//   getSource(sourceKey(clusterId, def))            // its problems and status
//   subscribeSources(listener)                      // any source changed; `sourcesVersion()` for useSyncExternalStore
//
// A cluster that disconnects or connects again loses its sources at once (the backend closes a cluster's watches on
// disconnect without a word, so one kept would never update again) and its `epochOf` moves on: users acquire anew.
//
// A watch that ends with an error (other than forbidden / not found) is opened again after a growing delay
// (`RETRY_BASE_MS` doubling up to `RETRY_MAX_MS`) while someone holds it.
//
// Rows: another view that needs a few fields of every object of a watched kind (the overview of several clusters)
// taps the same watch instead of opening a second one (`acquireRows`): each update is also reduced to the tap's rows,
// at most `RowTap.max`. A tap added to a watch that has already listed its kind re-lists it once.
import {
  api,
  openStream,
  toApiError,
  type ApiError,
  type ClusterId,
  type KubeObject,
  type WatchSpec,
  type WatchStatus,
  type WatchUpdate,
} from "../../api";
import { reportWatchUpdate } from "../../api/watchObservers";
import { useClustersStore } from "../clusters/clustersStore";
import {
  currentCertExpiryWarningMs,
  DEFAULT_CERT_EXPIRY_DAYS,
  resolve,
  setCertExpiryDays,
  uidOfObject,
  type Problem,
  type ProblemCategory,
} from "./model";
import { sourceKey, type SourceDef } from "./sources";

/** At most this many objects with problems are kept per source; beyond it the oldest go (`truncated`). */
export const MAX_PROBLEM_OBJECTS = 2000;
/** A released source keeps watching this long, so a remount (a layout switch, a page change) reuses it. */
export const LINGER_MS = 5000;
/** The first retry of a watch that failed, then doubled each time up to `RETRY_MAX_MS`. */
export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 60_000;

/** A reduced copy of every object of a source, kept for another view. */
export interface RowTap<R = unknown> {
  /** Unique among the taps of a source. */
  id: string;
  toRow(obj: KubeObject): R;
  /** Rows kept at most; beyond it new objects are left out (`truncated`). */
  max: number;
}

export interface RowsState<R = unknown> {
  status: WatchStatus;
  error?: ApiError;
  /** Rows by object uid; a new map after each change. */
  rows: ReadonlyMap<string, R>;
  truncated: boolean;
}

interface Tap {
  tap: RowTap;
  refs: number;
  state: RowsState;
}

export interface SourceState {
  key: string;
  clusterId: ClusterId;
  category: ProblemCategory;
  def: SourceDef;
  status: WatchStatus;
  error?: ApiError;
  /** All problems of the source (active or not yet); a new array after each change. */
  problems: readonly Problem[];
  /** Objects with problems were dropped to stay under `MAX_PROBLEM_OBJECTS`. */
  truncated: boolean;
}

interface Entry {
  state: SourceState;
  byUid: Map<string, Problem[]>;
  refs: number;
  linger?: ReturnType<typeof setTimeout>;
  stop: () => void;
  /** (Re)opens the watch. */
  open: () => void;
  /** The kind was listed at least once (a new tap then needs a fresh list). */
  listed: boolean;
  taps: Map<string, Tap>;
  retry?: ReturnType<typeof setTimeout>;
  attempts: number;
  /** A capped source (`SourceDef.maxObjects`) holds fewer objects than match: the last `capped` total said so. */
  capped?: boolean;
  /** `SourceDef.across.from`: the key of the other source whose rows judge this one's problems, and its release. */
  acrossFrom?: { key: string; release: () => void };
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
let clock: () => number = () => Date.now();
/** Per cluster: bumped whenever its connection comes or goes (its sources are dropped then). */
const epochs = new Map<ClusterId, number>();
/** Per cluster: connected when last looked at. */
const connected = new Map<ClusterId, boolean>();
let unfollow: (() => void) | undefined;

/** Drops every source of the cluster: its watches belong to a connection that is gone (or new). */
function dropCluster(clusterId: ClusterId): void {
  for (const [key, entry] of [...entries]) {
    if (entry.state.clusterId !== clusterId) continue;
    if (entry.linger) clearTimeout(entry.linger);
    if (entry.retry) clearTimeout(entry.retry);
    entries.delete(key);
    entry.stop();
    entry.acrossFrom?.release();
  }
  epochs.set(clusterId, epochOf(clusterId) + 1);
  changed();
}

function followConnections(): void {
  if (unfollow) return;
  const look = (states: ReturnType<typeof useClustersStore.getState>["states"]) => {
    const ids = new Set([...Object.keys(states), ...connected.keys()]);
    for (const id of ids) {
      const now = states[id]?.state === "connected";
      const was = connected.get(id);
      connected.set(id, now);
      if (was !== undefined && was !== now) dropCluster(id);
    }
  };
  look(useClustersStore.getState().states);
  unfollow = useClustersStore.subscribe((s, prev) => {
    if (s.states !== prev.states) look(s.states);
  });
}

/** Moves on whenever the cluster's connection comes or goes; acquire again when it does. */
export function epochOf(clusterId: ClusterId): number {
  return epochs.get(clusterId) ?? 0;
}

function changed(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

/** Recomputes the state's problem list after `byUid` (or, for a source judged across its objects, its rows) changed. */
function publish(entry: Entry, patch: Partial<SourceState> = {}): void {
  let problems: Problem[] = [];
  for (const list of entry.byUid.values()) problems.push(...list);
  const across = entry.state.def.across;
  const tapsOf = entry.acrossFrom ? entries.get(entry.acrossFrom.key)?.taps : entry.taps;
  const rows = across ? tapsOf?.get(across.tap.id)?.state : undefined;
  // Only rows read in full may hide a problem: while they load (or after an error) every problem stays.
  if (across && rows?.status === "ready") problems = across.keep(problems, rows.rows);
  entry.state = { ...entry.state, ...patch, problems };
  changed();
}

/** Publishes again the sources judged across the rows of the source `key` (`AcrossDef.from`) after they changed. */
function publishDependents(key: string): void {
  for (const entry of entries.values()) if (entry.acrossFrom?.key === key) publish(entry);
}

/**
 * Applies the expiry warning setting (`notifications.certExpiryDays`): new detections use it, and every held
 * "Expiring" problem moves to count from the new time at once — no new watch update, no reconnect.
 */
export function applyCertExpiryDays(days: unknown): void {
  if (!setCertExpiryDays(days)) return;
  const warnMs = currentCertExpiryWarningMs();
  for (const entry of entries.values()) {
    let moved = false;
    for (const [uid, list] of entry.byUid) {
      if (!list.some((p) => p.expiresAt !== undefined)) continue;
      entry.byUid.set(
        uid,
        list.map((p) => {
          if (p.expiresAt === undefined) return p;
          const activeFrom = p.expiresAt - warnMs;
          return { ...p, activeFrom, activeAt: activeFrom };
        }),
      );
      moved = true;
    }
    if (moved) publish(entry);
  }
}

/** Puts the problems of one object; whether anything changed, and whether an object was dropped for the cap. */
function put(entry: Entry, obj: KubeObject, now: number): { changed: boolean; dropped: boolean } {
  const uid = uidOfObject(obj);
  const before = entry.byUid.get(uid);
  const found = resolve(entry.state.def.kind, obj, now, before, entry.state.def.category);
  if (found.length === 0) return { changed: entry.byUid.delete(uid), dropped: false };
  entry.byUid.set(uid, found);
  if (!before && entry.byUid.size > MAX_PROBLEM_OBJECTS) {
    // The oldest object with problems goes (a Map iterates in insertion order).
    const oldest = entry.byUid.keys().next().value;
    if (oldest !== undefined) entry.byUid.delete(oldest);
    return { changed: true, dropped: true };
  }
  return { changed: true, dropped: false };
}

/** Applies one watch update to a source; what changed in its state, or `null` for nothing to tell. */
function applyUpdate(entry: Entry, update: WatchUpdate, now: number): Partial<SourceState> | null {
  switch (update.type) {
    case "snapshot": {
      const previous = entry.byUid;
      entry.byUid = new Map();
      let truncated = false;
      // Oldest first, so the cap drops the oldest (events: the newest warnings stay).
      for (const obj of [...(update.items as KubeObject[])].sort(byCreation)) {
        const uid = uidOfObject(obj);
        // The problems before keep their first-seen times across a reconnect.
        const found = resolve(entry.state.def.kind, obj, now, previous.get(uid), entry.state.def.category);
        if (found.length === 0) continue;
        entry.byUid.set(uid, found);
        if (entry.byUid.size > MAX_PROBLEM_OBJECTS) {
          const oldest = entry.byUid.keys().next().value;
          if (oldest !== undefined) entry.byUid.delete(oldest);
          truncated = true;
        }
      }
      return { status: "ready", error: undefined, truncated: truncated || entry.capped === true };
    }
    case "delta": {
      // Most updates are of objects without problems: those change nothing, and nobody is told.
      let changed = false;
      let truncated = entry.state.truncated;
      for (const obj of update.upserted as KubeObject[]) {
        const result = put(entry, obj, now);
        changed ||= result.changed;
        truncated ||= result.dropped;
      }
      for (const uid of update.deleted) changed = entry.byUid.delete(uid) || changed;
      return changed ? { truncated } : null;
    }
    case "reconnecting":
      return { status: entry.state.status === "loading" ? "loading" : "reconnecting" };
    case "error":
      return { status: "error", error: toApiError(update) };
    case "forbidden":
      // Some namespaces cannot be listed; the others are watched.
      return null;
    case "capped":
      // A capped source (`SourceDef.maxObjects`): objects past the cap are not judged. Sent when the total changes.
      entry.capped = update.total > (entry.state.def.maxObjects ?? Number.POSITIVE_INFINITY);
      return { truncated: entry.capped || entry.byUid.size >= MAX_PROBLEM_OBJECTS };
    case "snapshotPart":
    case "snapshotEnd":
      // Only watches started with `progressive` (the tables) send these; the problem sources never ask for parts.
      return null;
  }
}

function byCreation(a: KubeObject, b: KubeObject): number {
  const created = (o: KubeObject) => {
    const t = Date.parse(String(o.metadata?.creationTimestamp ?? ""));
    return Number.isNaN(t) ? 0 : t;
  };
  return created(a) - created(b);
}

/** One watch update applied to a tap's rows; `null` when nothing changed. */
function applyToTap(tap: Tap, update: WatchUpdate): RowsState | null {
  const state = tap.state;
  switch (update.type) {
    case "snapshot": {
      const rows = new Map<string, unknown>();
      let truncated = false;
      for (const obj of update.items as KubeObject[]) {
        if (rows.size >= tap.tap.max) {
          truncated = true;
          break;
        }
        rows.set(uidOfObject(obj), tap.tap.toRow(obj));
      }
      return { status: "ready", rows, truncated };
    }
    case "delta": {
      if (update.upserted.length === 0 && !update.deleted.some((uid) => state.rows.has(uid))) return null;
      const rows = new Map(state.rows);
      let truncated = state.truncated;
      for (const obj of update.upserted as KubeObject[]) {
        const uid = uidOfObject(obj);
        if (!rows.has(uid) && rows.size >= tap.tap.max) {
          truncated = true;
          continue;
        }
        rows.set(uid, tap.tap.toRow(obj));
      }
      for (const uid of update.deleted) rows.delete(uid);
      return { ...state, rows, truncated };
    }
    case "reconnecting":
      return { ...state, status: state.status === "loading" ? "loading" : "reconnecting" };
    case "error":
      return { ...state, status: "error", error: toApiError(update) };
    case "capped":
      // A capped source's taps see only the objects it keeps.
      return { ...state, truncated: state.truncated || update.total > state.rows.size };
    case "forbidden":
    case "snapshotPart":
    case "snapshotEnd":
      // The parts come only from watches started with `progressive` (the tables), which the sources are not.
      return null;
  }
}

/** Errors a new attempt will not cure. */
const FINAL_ERRORS = new Set(["forbidden", "notFound"]);

/** Opens the watch again after a growing delay, while someone holds it. */
function scheduleRetry(key: string, entry: Entry, error: ApiError): void {
  if (FINAL_ERRORS.has(error.code) || entry.retry) return;
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** entry.attempts);
  entry.attempts++;
  entry.retry = setTimeout(() => {
    entry.retry = undefined;
    if (entries.get(key) !== entry || entry.refs === 0) return;
    entry.stop();
    entry.open();
  }, delay);
}

function failed(key: string, entry: Entry, error: ApiError): void {
  for (const tap of entry.taps.values()) tap.state = { ...tap.state, status: "error", error };
  publish(entry, { status: "error", error });
  publishDependents(key);
  scheduleRetry(key, entry, error);
}

/** Starts (or shares) the watch of `def` in the cluster; the returned function releases it. */
export function acquireSource(clusterId: ClusterId, def: SourceDef): () => void {
  followConnections();
  const key = sourceKey(clusterId, def);
  let entry = entries.get(key);
  if (!entry) {
    const created: Entry = {
      state: { key, clusterId, category: def.category, def, status: "loading", problems: [], truncated: false },
      byUid: new Map(),
      refs: 0,
      stop: () => undefined,
      open: () => undefined,
      listed: false,
      taps: new Map(),
      attempts: 0,
    };
    entries.set(key, created);
    const spec: WatchSpec = { kind: def.kind, namespaces: null, labelSelector: null, fieldSelector: def.fieldSelector };
    created.open = () => {
      created.stop = openStream<WatchUpdate>({
        start: (id, channel) =>
          def.maxObjects === undefined
            ? api.resources.watchStart(clusterId, spec, id, channel)
            : api.resources.watchStart(clusterId, spec, id, channel, { progressive: false, maxObjects: def.maxObjects }),
        stop: api.resources.watchStop,
        onEvent: (update) => {
          if (entries.get(key) !== created) return;
          reportWatchUpdate(clusterId, spec, update);
          if (update.type === "error") {
            for (const tap of created.taps.values()) tap.state = applyToTap(tap, update) ?? tap.state;
            failed(key, created, toApiError(update));
            return;
          }
          if (update.type === "snapshot") {
            created.listed = true;
            created.attempts = 0;
          }
          let tapped = false;
          for (const tap of created.taps.values()) {
            const next = applyToTap(tap, update);
            if (next) {
              tap.state = next;
              tapped = true;
            }
          }
          const patch = applyUpdate(created, update, clock());
          if (patch) publish(created, patch);
          // The rows decide which problems a source judged across its objects shows.
          else if (tapped && def.across && !def.across.from) publish(created);
          else if (tapped) changed();
          if (tapped) publishDependents(key);
        },
        onStartError: (err) => {
          if (entries.get(key) !== created) return;
          failed(key, created, toApiError(err));
        },
      });
    };
    // A provider's source (`registerProblemProvider`): its problems come from outside, nothing is watched.
    if (def.external) created.open = () => (created.stop = openProvided(key, clusterId, created));
    // A source judged across its objects keeps its own tap for as long as it lives (a view's tap of the same id
    // shares it).
    if (def.across && !def.across.from) {
      created.taps.set(def.across.tap.id, { tap: def.across.tap, refs: 1, state: { status: "loading", rows: new Map(), truncated: false } });
    }
    created.open();
    // A source judged across another source's rows holds that source with a tap for as long as it lives.
    if (def.across?.from) {
      created.acrossFrom = { key: sourceKey(clusterId, def.across.from), release: acquireRows(clusterId, def.across.from, def.across.tap) };
    }
    entry = created;
    changed();
  }
  const held = entry;
  if (held.linger) {
    clearTimeout(held.linger);
    held.linger = undefined;
  }
  held.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs--;
    if (held.refs > 0) return;
    held.linger = setTimeout(() => close(key, held), LINGER_MS);
  };
}

/** What a provider hands in: the state of its source and all its problems (replacing the ones before). */
export interface ProvidedProblems {
  status: WatchStatus;
  error?: ApiError;
  problems: readonly Problem[];
  truncated?: boolean;
}

/**
 * Starts providing the problems of a category in a cluster (while its source is held) through `set`; returns the
 * function that stops it.
 */
export type ProblemProvider = (clusterId: ClusterId, set: (update: ProvidedProblems) => void) => () => void;

const providers = new Map<ProblemCategory, ProblemProvider>();

/**
 * Registers where the problems of a category whose source is `external` (`SourceDef.external`) come from: a feature
 * that measures something no watch carries (the fill level of volume claims, features/storage). Returns a function
 * that removes it.
 */
export function registerProblemProvider(category: ProblemCategory, provider: ProblemProvider): () => void {
  providers.set(category, provider);
  return () => {
    if (providers.get(category) === provider) providers.delete(category);
  };
}

function openProvided(key: string, clusterId: ClusterId, entry: Entry): () => void {
  const provider = providers.get(entry.state.def.category);
  if (!provider) {
    publish(entry, { status: "ready" });
    return () => undefined;
  }
  let live = true;
  const stop = provider(clusterId, ({ problems, status, error, truncated }) => {
    if (!live || entries.get(key) !== entry) return;
    entry.byUid = new Map();
    for (const problem of problems) entry.byUid.set(problem.uid, [...(entry.byUid.get(problem.uid) ?? []), problem]);
    publish(entry, { status, error, truncated: truncated ?? false });
  });
  return () => {
    live = false;
    stop();
  };
}

function close(key: string, entry: Entry): void {
  if (entries.get(key) !== entry || entry.refs > 0) return;
  entries.delete(key);
  if (entry.retry) clearTimeout(entry.retry);
  entry.stop();
  entry.acrossFrom?.release();
  changed();
}

/**
 * Holds the source of `def` (as `acquireSource`) and keeps `tap`'s rows of its objects while held. A source that has
 * listed its kind already is listed again once, so the new tap gets every object.
 */
export function acquireRows(clusterId: ClusterId, def: SourceDef, tap: RowTap): () => void {
  const release = acquireSource(clusterId, def);
  const key = sourceKey(clusterId, def);
  const entry = entries.get(key)!;
  let held = entry.taps.get(tap.id);
  if (!held) {
    held = { tap, refs: 0, state: { status: "loading", rows: new Map(), truncated: false } };
    entry.taps.set(tap.id, held);
    if (entry.listed && !entry.retry) {
      entry.stop();
      entry.open();
    }
    changed();
  }
  held.refs++;
  const mine = held;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.refs--;
    if (mine.refs === 0 && entry.taps.get(tap.id) === mine) {
      entry.taps.delete(tap.id);
      changed();
    }
    release();
  };
}

/** The rows a tap keeps of a source, while it is held. */
export function getRows(key: string, tapId: string): RowsState | undefined {
  return entries.get(key)?.taps.get(tapId)?.state;
}

/** How many watches are open, and how many taps they carry (tests). */
export function problemSourceStats(): { watches: number; taps: number } {
  let taps = 0;
  for (const entry of entries.values()) taps += entry.taps.size;
  return { watches: entries.size, taps };
}

export function getSource(key: string): SourceState | undefined {
  return entries.get(key)?.state;
}

/** Every open source of the cluster. */
export function sourcesOf(clusterId: ClusterId): SourceState[] {
  return [...entries.values()].map((e) => e.state).filter((s) => s.clusterId === clusterId);
}

export function subscribeSources(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Bumped by every change of any source. */
export function sourcesVersion(): number {
  return version;
}

/** Closes every source at once and forgets them (tests). */
export function resetProblemSources(): void {
  for (const entry of entries.values()) {
    if (entry.linger) clearTimeout(entry.linger);
    if (entry.retry) clearTimeout(entry.retry);
    entry.stop();
  }
  entries.clear();
  unfollow?.();
  unfollow = undefined;
  epochs.clear();
  connected.clear();
  clock = () => Date.now();
  setCertExpiryDays(DEFAULT_CERT_EXPIRY_DAYS);
  changed();
}

/** The clock first-seen times are taken from (tests). */
export function setProblemsClock(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}
