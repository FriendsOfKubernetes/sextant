// The objects the palette searches: the names of the objects of some kinds of the active cluster, from metadata-only
// watches (names, namespaces, labels — no specs, statuses or Secret data). Bounded, because every kind is a
// cluster-wide list and watch on the API server:
//
// - nothing starts when the palette opens, only with the first typed character (the palette decides);
// - by default only `COMMON_KINDS` the cluster serves, plus the open table's kind (`defaultSearchKinds`); other kinds
//   only when the query names one (`cm foo`, `crd:`, see `parseKindQuery`) or the user asks to search all kinds
//   (`searchKinds`, at most `MAX_SEARCH_KINDS`);
// - at most `MAX_CONCURRENT_LISTS` kinds being listed at once; the next kind starts when one has its first list (or
//   failed, or took longer than `LIST_SLOT_TIMEOUT_MS`);
// - a watch nobody uses any more (the palette closed, the query no longer names its kind) is kept `KEEP_ALIVE_MS`,
//   so reopening the palette finds the names at once, then stopped;
// - React hears of changes at most every `FLUSH_INTERVAL_MS`.
//
// Kinds that cannot be watched (no permission) are left out silently: the palette searches what the user may see.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  api,
  applyWatchUpdate,
  openStream,
  toApiError,
  type ClusterId,
  type KindRef,
  type ResourceKind,
  type WatchState,
  type WatchUpdate,
} from "../../api";
import { findKind, getResourceDefs, kindKey, SIDEBAR_SECTIONS } from "../../resources";
import { queryWords } from "./fuzzy";

export const MAX_SEARCH_KINDS = 80;
export const MAX_CONCURRENT_LISTS = 6;
export const LIST_SLOT_TIMEOUT_MS = 10_000;
export const FLUSH_INTERVAL_MS = 100;
export const KEEP_ALIVE_MS = 30_000;

/** Kinds searched by default (`group/Kind`), when the cluster serves them. */
export const COMMON_KINDS: readonly string[] = [
  "/Pod",
  "apps/Deployment",
  "apps/StatefulSet",
  "apps/DaemonSet",
  "batch/Job",
  "batch/CronJob",
  "/Service",
  "networking.k8s.io/Ingress",
  "/ConfigMap",
  "/Secret",
  "/Node",
  "/Namespace",
  "/PersistentVolumeClaim",
  "gateway.networking.k8s.io/Gateway",
  "gateway.networking.k8s.io/HTTPRoute",
  "helm.toolkit.fluxcd.io/HelmRelease",
  "kustomize.toolkit.fluxcd.io/Kustomization",
  "argoproj.io/Application",
];

/** Short names a query may start with to name a kind (as kubectl knows them), besides the kind and its plural. */
const SHORT_NAMES: Record<string, string[]> = {
  "/Pod": ["po"],
  "apps/Deployment": ["deploy"],
  "apps/StatefulSet": ["sts"],
  "apps/DaemonSet": ["ds"],
  "apps/ReplicaSet": ["rs"],
  "batch/CronJob": ["cj"],
  "/Service": ["svc"],
  "networking.k8s.io/Ingress": ["ing"],
  "networking.k8s.io/NetworkPolicy": ["netpol"],
  "/ConfigMap": ["cm"],
  "/Namespace": ["ns"],
  "/Node": ["no"],
  "/PersistentVolumeClaim": ["pvc"],
  "/PersistentVolume": ["pv"],
  "/ServiceAccount": ["sa"],
  "/Endpoints": ["ep"],
  "storage.k8s.io/StorageClass": ["sc"],
  "autoscaling/HorizontalPodAutoscaler": ["hpa"],
  "policy/PodDisruptionBudget": ["pdb"],
  "apiextensions.k8s.io/CustomResourceDefinition": ["crd", "crds"],
  "helm.toolkit.fluxcd.io/HelmRelease": ["hr"],
  "kustomize.toolkit.fluxcd.io/Kustomization": ["ks"],
  "argoproj.io/Application": ["app", "apps"],
};

/** Kinds never searched: events are many, short-lived and named after other objects. */
const SKIPPED = new Set(["/Event", "events.k8s.io/Event"]);

export interface SearchKind {
  /** The version Sextant's tables use for the kind (its own description's, else the one discovery prefers). */
  kind: KindRef;
  resourceKind: ResourceKind;
}

export interface IndexedKind extends SearchKind {
  state: WatchState;
}

export interface ObjectIndex {
  kinds: IndexedKind[];
  /** Kinds whose first list has not come yet. */
  pending: number;
}

/**
 * Every kind that could be searched, in order: `first` (the open table's kind) if served, Sextant's described kinds
 * in sidebar order, then the other served kinds by group and kind. Only kinds that can be listed and watched; not
 * events.
 */
export function searchKinds(kinds: ResourceKind[], first?: Pick<KindRef, "group" | "kind"> | null): SearchKind[] {
  const searchable = kinds.filter(
    (k) => k.verbs.includes("list") && k.verbs.includes("watch") && !SKIPPED.has(kindKey(k.kindRef)),
  );
  const sectionIndex = (section: string) => (SIDEBAR_SECTIONS as readonly string[]).indexOf(section);
  const described = getResourceDefs()
    .filter((d) => d.sidebar)
    .sort(
      (a, b) =>
        sectionIndex(a.sidebar!.section) - sectionIndex(b.sidebar!.section) || a.sidebar!.order - b.sidebar!.order,
    );
  const result: SearchKind[] = [];
  const taken = new Set<string>();
  const take = (resourceKind: ResourceKind) => {
    const key = kindKey(resourceKind.kindRef);
    if (taken.has(key)) return;
    taken.add(key);
    const own = described.find((d) => kindKey(d.kind) === key);
    result.push({ kind: own ? { ...resourceKind.kindRef, version: own.kind.version } : resourceKind.kindRef, resourceKind });
  };
  if (first) {
    const rk = findKind(searchable, first);
    if (rk) take(rk);
  }
  for (const def of described) {
    const rk = findKind(searchable, def.kind);
    if (rk) take(rk);
  }
  const rest = [...searchable].sort(
    (a, b) => a.kindRef.group.localeCompare(b.kindRef.group) || a.kindRef.kind.localeCompare(b.kindRef.kind),
  );
  for (const rk of rest) take(rk);
  return result;
}

/** The kinds searched without asking: the open table's kind (`first`) and the served `COMMON_KINDS`. */
export function defaultSearchKinds(all: SearchKind[], first?: Pick<KindRef, "group" | "kind"> | null): SearchKind[] {
  const firstKey = first ? kindKey(first) : null;
  const byKey = new Map(all.map((k) => [kindKey(k.kind), k]));
  const keys = firstKey ? [firstKey, ...COMMON_KINDS.filter((k) => k !== firstKey)] : COMMON_KINDS;
  return keys.map((k) => byKey.get(k)).filter((k): k is SearchKind => k !== undefined);
}

/** The names a query can give a kind: its short names, the kind and its plural, ignoring case. */
function aliasesOf(k: SearchKind): string[] {
  return [...(SHORT_NAMES[kindKey(k.kind)] ?? []), k.kind.kind.toLowerCase(), k.resourceKind.plural.toLowerCase()];
}

export interface KindQuery {
  /** The kind the query names, if any. */
  kind: SearchKind | null;
  /** The words left to match names against. */
  words: string[];
}

/**
 * Splits a query into a kind and the words to match: `kind:name` (`cm:foo`, `crd:` — every object of the kind), or a
 * first word that names a kind followed by more words (`cm foo`, `deploy api`). The kind's name, plural or kubectl
 * short name, ignoring case; the first of `all` wins when two kinds share a name. Otherwise no kind, every word.
 */
export function parseKindQuery(query: string, all: SearchKind[]): KindQuery {
  const words = queryWords(query);
  const first = words[0];
  if (!first) return { kind: null, words: [] };
  const lookup = (alias: string) => {
    const wanted = alias.toLowerCase();
    return all.find((k) => aliasesOf(k).includes(wanted)) ?? null;
  };
  const colon = first.indexOf(":");
  if (colon > 0) {
    const kind = lookup(first.slice(0, colon));
    if (kind) return { kind, words: [first.slice(colon + 1), ...words.slice(1)].filter(Boolean) };
  } else if (words.length > 1) {
    const kind = lookup(first);
    if (kind) return { kind, words: words.slice(1) };
  }
  return { kind: null, words };
}

// ---------- Watches shared by every opening of the palette ----------

interface Entry {
  key: string;
  clusterId: ClusterId;
  search: SearchKind;
  state: WatchState;
  /** Palettes using it; at 0 the keep-alive timer runs. */
  users: number;
  keepAlive: ReturnType<typeof setTimeout> | null;
  /** Closes the watch; `null` while waiting for a free list slot. */
  stop: (() => void) | null;
  /** Releases its list slot (until the first list came). */
  releaseSlot: (() => void) | null;
}

const LOADING: WatchState = Object.freeze({ items: new Map(), status: "loading" }) as WatchState;

const entries = new Map<string, Entry>();
const waiting: Entry[] = [];
let listing = 0;
let version = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function changed(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    version++;
    for (const fn of listeners) fn();
  }, FLUSH_INTERVAL_MS);
}

function pump(): void {
  while (listing < MAX_CONCURRENT_LISTS && waiting.length > 0) start(waiting.shift()!);
  changed();
}

function start(entry: Entry): void {
  listing++;
  let released = false;
  const slotTimer = setTimeout(() => entry.releaseSlot?.(), LIST_SLOT_TIMEOUT_MS);
  entry.releaseSlot = () => {
    if (released) return;
    released = true;
    entry.releaseSlot = null;
    clearTimeout(slotTimer);
    listing--;
    pump();
  };
  const update = (fn: (s: WatchState) => WatchState) => {
    if (entries.get(entry.key) !== entry) return;
    const state = fn(entry.state);
    if (state === entry.state) return;
    entry.state = state;
    changed();
  };
  entry.stop = openStream<WatchUpdate>({
    start: (id, channel) =>
      api.resources.watchStart(
        entry.clusterId,
        { kind: entry.search.kind, namespaces: null, labelSelector: null, fieldSelector: null, metadataOnly: true },
        id, channel,
      ),
    stop: api.resources.watchStop,
    onEvent: (u) => {
      update((s) => applyWatchUpdate(s, u));
      if (u.type === "snapshot" || u.type === "error") entry.releaseSlot?.();
    },
    onStartError: (err) => {
      update(() => ({ items: new Map(), status: "error", error: toApiError(err) }));
      entry.releaseSlot?.();
    },
  });
}

function dispose(entry: Entry): void {
  if (entries.get(entry.key) !== entry) return;
  entries.delete(entry.key);
  if (entry.keepAlive) clearTimeout(entry.keepAlive);
  const at = waiting.indexOf(entry);
  if (at >= 0) waiting.splice(at, 1);
  entry.stop?.();
  entry.releaseSlot?.();
  changed();
}

/** Starts (or keeps) watching `kinds` of the cluster; the returned function lets them go (stopped after keep-alive). */
function acquire(clusterId: ClusterId, kinds: SearchKind[]): () => void {
  const held: Entry[] = [];
  for (const search of kinds) {
    const key = `${clusterId}|${kindKey(search.kind)}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, clusterId, search, state: LOADING, users: 0, keepAlive: null, stop: null, releaseSlot: null };
      entries.set(key, entry);
      waiting.push(entry);
    }
    entry.users++;
    if (entry.keepAlive) {
      clearTimeout(entry.keepAlive);
      entry.keepAlive = null;
    }
    held.push(entry);
  }
  pump();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const entry of held) {
      entry.users--;
      if (entry.users > 0 || entries.get(entry.key) !== entry) continue;
      entry.keepAlive = setTimeout(() => dispose(entry), KEEP_ALIVE_MS);
    }
  };
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getVersion = () => version;

/**
 * Watches the metadata of the objects of `kinds` (see the file comment) while mounted with them; `kinds: null`
 * watches nothing. The watches outlive the caller by `KEEP_ALIVE_MS`.
 */
export function useObjectIndex(clusterId: ClusterId | null, kinds: SearchKind[] | null): ObjectIndex {
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);

  useEffect(() => {
    if (!clusterId || !kinds || kinds.length === 0) return;
    return acquire(clusterId, kinds);
  }, [clusterId, kinds]);

  return useMemo(() => {
    const result: ObjectIndex = { kinds: [], pending: 0 };
    if (!clusterId || !kinds) return result;
    for (const search of kinds) {
      const entry = entries.get(`${clusterId}|${kindKey(search.kind)}`);
      if (!entry) continue;
      result.kinds.push({ ...entry.search, state: entry.state });
      if (entry.state.status === "loading") result.pending++;
    }
    return result;
    // `current`: a new index after every change of the watches.
  }, [clusterId, kinds, current]);
}

/** Stops every watch at once (tests). */
export function resetObjectIndex(): void {
  waiting.length = 0;
  for (const entry of [...entries.values()]) dispose(entry);
  listing = 0;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}
