// One watch per (cluster, spec) for every view that asks for it at the same time (#157): the table, the
// resource map, the "Related" tab and the RBAC views share a stream instead of listing the same objects twice.
// Reference-counted: the first holder opens the stream, the last one lets go of it; a holder may ask that the watch
// linger (`linger` ms) after it lets go, so a view that comes back soon finds the list instead of listing it again.
//
//   const release = acquireWatch(clusterId, spec, { linger: 5000 });
//   watchStateOf(clusterId, spec)            // the current WatchState (applyWatchUpdate of every update)
//   subscribeWatch(clusterId, spec, fn)      // fn() after every change of that watch
//   release();
//
// `useWatch` (useWatch.ts) is the React side. A cluster whose connection came or went loses its watches at once
// (`dropClusterWatches`: the backend closes them without a word) and its epoch moves on, so holders acquire anew.
// The problem sources (features/problems) and the palette index keep their own streams: they keep no objects or
// only metadata, so sharing would make them hold more.
import { resources } from "./commands";
import { toApiError } from "./errors";
import { openStream } from "./stream";
import type { ClusterId, WatchOptions, WatchSpec, WatchUpdate } from "./types";
import { applyWatchUpdate, type WatchState } from "./watchState";
import { reportWatchUpdate } from "./watchObservers";

const LOADING: WatchState = Object.freeze({ items: new Map(), status: "loading" }) as WatchState;

interface Entry {
  clusterId: ClusterId;
  state: WatchState;
  refs: number;
  /** The longest linger a holder asked for; `null` while none asked (closed at once). */
  linger: number | null;
  lingerTimer?: ReturnType<typeof setTimeout>;
  /** The options the stream was opened with. */
  options?: WatchOptions;
  stop: () => void;
}

const entries = new Map<string, Entry>();
/** Listeners by watch key; they outlive the watch (subscribing before acquiring is fine). */
const keyListeners = new Map<string, Set<() => void>>();
const anyListeners = new Set<() => void>();
const epochs = new Map<ClusterId, number>();

/**
 * The key of a watch: the cluster and the spec by value (undefined fields as their defaults). `WatchOptions` are not
 * part of it: a list in parts and a capped list carry the same objects, so views asking with and without them share
 * one stream (see `acquireWatch`).
 */
export function watchKey(clusterId: ClusterId, spec: WatchSpec): string {
  return JSON.stringify([
    clusterId,
    spec.kind,
    spec.namespaces ?? null,
    spec.labelSelector ?? null,
    spec.fieldSelector ?? null,
    spec.metadataOnly ?? false,
  ]);
}

function changed(key: string): void {
  for (const fn of [...(keyListeners.get(key) ?? [])]) fn();
  for (const fn of [...anyListeners]) fn();
}

export interface AcquireOptions {
  /**
   * How the backend should deliver it (the tables: parts and a cap). A watch already open is shared: one without a cap
   * serves a holder that asked for one (it gets every object), and a capped one is reopened without its cap when a
   * holder asks for every object (its rows stay until the new list is in).
   */
  watch?: WatchOptions | null;
  /**
   * Milliseconds the watch stays open after the last holder lets go; 0 keeps it until the current task ends, so a
   * holder that lets go and takes it again in one render (a changed list of specs) keeps the stream. Left out, the
   * watch closes at once. A watch that failed closes at once whatever was asked, so a retry starts it anew.
   */
  linger?: number;
}

/** Opens the entry's stream with `options` (a reopened entry keeps its objects until the new list replaces them). */
function openEntry(key: string, entry: Entry, spec: WatchSpec, options: WatchOptions | undefined): void {
  entry.options = options;
  entry.stop = openStream<WatchUpdate>({
    start: (id, channel) => resources.watchStart(entry.clusterId, spec, id, channel, options),
    stop: resources.watchStop,
    onEvent: (update) => {
      if (entries.get(key) !== entry || entry.options !== options) return;
      reportWatchUpdate(entry.clusterId, spec, update, options);
      const next = applyWatchUpdate(entry.state, update);
      if (next === entry.state) return;
      entry.state = next;
      changed(key);
    },
    onStartError: (err) => {
      if (entries.get(key) !== entry || entry.options !== options) return;
      entry.state = { items: new Map(), status: "error", error: toApiError(err) };
      changed(key);
    },
  });
}

/** Starts (or shares) the watch; the returned function lets go of it (idempotent). */
export function acquireWatch(clusterId: ClusterId, spec: WatchSpec, options: AcquireOptions = {}): () => void {
  const key = watchKey(clusterId, spec);
  let entry = entries.get(key);
  if (entry && entry.refs === 0 && entry.state.status === "error") {
    // A failed watch nobody holds is not handed out again: a retry starts it anew.
    close(key, entry);
    entry = undefined;
  }
  const wanted = options.watch ?? undefined;
  if (!entry) {
    const created: Entry = { clusterId, state: LOADING, refs: 0, linger: null, stop: () => undefined };
    entries.set(key, created);
    openEntry(key, created, spec, wanted);
    entry = created;
  } else if (entry.options?.maxObjects !== undefined && wanted?.maxObjects === undefined) {
    // A holder wants every object of a capped watch: reopened without the cap and without parts (parts would add to
    // the objects already shown); the rows stay until the full list replaces them.
    entry.stop();
    entry.state = { ...entry.state, total: undefined };
    openEntry(key, entry, spec, undefined);
    changed(key);
  }
  const held = entry;
  if (held.lingerTimer) {
    clearTimeout(held.lingerTimer);
    held.lingerTimer = undefined;
  }
  held.refs++;
  if (options.linger !== undefined) held.linger = Math.max(held.linger ?? 0, options.linger);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs--;
    if (held.refs > 0 || entries.get(key) !== held) return;
    const later = () => {
      if (entries.get(key) === held && held.refs === 0) close(key, held);
    };
    if (held.linger === null || held.state.status === "error") close(key, held);
    else held.lingerTimer = setTimeout(later, held.linger);
  };
}

function close(key: string, entry: Entry): void {
  if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
  entry.lingerTimer = undefined;
  if (entries.get(key) === entry) entries.delete(key);
  entry.stop();
}

/** The state of the watch (loading when it is not open). */
export function watchStateOf(clusterId: ClusterId, spec: WatchSpec): WatchState {
  return entries.get(watchKey(clusterId, spec))?.state ?? LOADING;
}

/** Calls `listener` after every change of the watch with this key (`watchKey`), also of one opened later. */
export function subscribeWatchKey(key: string, listener: () => void): () => void {
  let set = keyListeners.get(key);
  if (!set) {
    set = new Set();
    keyListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = keyListeners.get(key);
    current?.delete(listener);
    if (current?.size === 0) keyListeners.delete(key);
  };
}

/** The state of the watch with this key (`watchKey`); loading when it is not open. */
export function watchStateByKey(key: string): WatchState {
  return entries.get(key)?.state ?? LOADING;
}

/** Calls `listener` after a change of any watch, and when a cluster's watches are dropped. */
export function subscribeAllWatches(listener: () => void): () => void {
  anyListeners.add(listener);
  return () => anyListeners.delete(listener);
}

/** Bumped when a cluster's watches are dropped: holders acquire anew. */
export function watchEpochOf(clusterId: ClusterId): number {
  return epochs.get(clusterId) ?? 0;
}

/** Closes every watch of the cluster (its connection came or went) and moves its epoch on. */
export function dropClusterWatches(clusterId: ClusterId): void {
  for (const [key, entry] of [...entries]) {
    if (entry.clusterId !== clusterId) continue;
    if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
    entries.delete(key);
    entry.stop();
    for (const fn of [...(keyListeners.get(key) ?? [])]) fn();
  }
  epochs.set(clusterId, watchEpochOf(clusterId) + 1);
  for (const fn of [...anyListeners]) fn();
}

/** Whether the watch with this key (`watchKey`) is open. */
export function isWatchOpen(key: string): boolean {
  return entries.has(key);
}

/** How many hold the watch with this key: 0 while it lingers, `null` when it is closed. */
export function watchHolders(key: string): number | null {
  return entries.get(key)?.refs ?? null;
}

/** How many watches are open (tests). */
export function openWatchCount(): number {
  return entries.size;
}

/** Closes every watch and forgets them (tests). */
export function resetWatchRegistry(): void {
  for (const entry of entries.values()) {
    if (entry.lingerTimer) clearTimeout(entry.lingerTimer);
    entry.stop();
  }
  entries.clear();
  epochs.clear();
}
