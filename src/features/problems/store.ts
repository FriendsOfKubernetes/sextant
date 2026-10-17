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
import {
  api,
  events,
  openStream,
  toApiError,
  type ApiError,
  type ClusterId,
  type KubeObject,
  type WatchSpec,
  type WatchStatus,
  type WatchUpdate,
} from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import { resolve, uidOfObject, type Problem, type ProblemCategory } from "./model";
import { sourceKey, type SourceDef } from "./sources";

/** At most this many objects with problems are kept per source; beyond it the oldest go (`truncated`). */
export const MAX_PROBLEM_OBJECTS = 2000;
/** A released source keeps watching this long, so a remount (a layout switch, a page change) reuses it. */
export const LINGER_MS = 5000;

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
    entries.delete(key);
    entry.stop();
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

/** Recomputes the state's problem list after `byUid` changed. */
function publish(entry: Entry, patch: Partial<SourceState> = {}): void {
  const problems: Problem[] = [];
  for (const list of entry.byUid.values()) problems.push(...list);
  entry.state = { ...entry.state, ...patch, problems };
  changed();
}

/** Puts the problems of one object; whether anything changed, and whether an object was dropped for the cap. */
function put(entry: Entry, obj: KubeObject, now: number): { changed: boolean; dropped: boolean } {
  const uid = uidOfObject(obj);
  const before = entry.byUid.get(uid);
  const found = resolve(entry.state.def.kind, obj, now, before);
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
        const found = resolve(entry.state.def.kind, obj, now, previous.get(uid));
        if (found.length === 0) continue;
        entry.byUid.set(uid, found);
        if (entry.byUid.size > MAX_PROBLEM_OBJECTS) {
          const oldest = entry.byUid.keys().next().value;
          if (oldest !== undefined) entry.byUid.delete(oldest);
          truncated = true;
        }
      }
      return { status: "ready", error: undefined, truncated };
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
  }
}

function byCreation(a: KubeObject, b: KubeObject): number {
  const created = (o: KubeObject) => {
    const t = Date.parse(String(o.metadata?.creationTimestamp ?? ""));
    return Number.isNaN(t) ? 0 : t;
  };
  return created(a) - created(b);
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
    };
    entries.set(key, created);
    const spec: WatchSpec = { kind: def.kind, namespaces: null, labelSelector: null, fieldSelector: def.fieldSelector };
    created.stop = openStream<WatchUpdate>({
      start: (id) => api.resources.watchStart(clusterId, spec, id),
      listen: events.onWatch,
      stop: api.resources.watchStop,
      onEvent: (update) => {
        if (entries.get(key) !== created) return;
        const patch = applyUpdate(created, update, clock());
        if (patch) publish(created, patch);
      },
      onStartError: (err) => {
        if (entries.get(key) !== created) return;
        publish(created, { status: "error", error: toApiError(err) });
      },
    });
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

function close(key: string, entry: Entry): void {
  if (entries.get(key) !== entry || entry.refs > 0) return;
  entries.delete(key);
  entry.stop();
  changed();
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
    entry.stop();
  }
  entries.clear();
  unfollow?.();
  unfollow = undefined;
  epochs.clear();
  connected.clear();
  clock = () => Date.now();
  changed();
}

/** The clock first-seen times are taken from (tests). */
export function setProblemsClock(now: (() => number) | null): void {
  clock = now ?? (() => Date.now());
}
