// The Secrets and ConfigMaps Reflector's annotations name, shared by the column, the details and the problems (#241):
// metadata-only lists (names, annotations, resourceVersions — never a value) of the namespaces in view, and the
// cluster's Namespaces (the namespace filter's own list, for names and labels). A holder asks for a kind in some
// namespaces (a mirror's details: its source's namespace; a source's details: its own and the namespaces it may be
// mirrored to; a table cell: its source's namespace); the store lists the union, at most `MAX_NAMESPACES` per kind
// (first asked, first kept; beyond it those namespaces are "not checked"). Only the problems provider of the opt-in
// category asks for every namespace: then one cluster-wide metadata list per kind, capped at `MAX_OBJECTS`. The
// watches are the shared ones of the resource map (`acquireWatch`), released as soon as nobody asks (their own linger
// keeps a stream for a moment), taken anew after a reconnect. Requests are gathered for `SYNC_DELAY_MS` so a table's
// rows do not open one list each; the state is rebuilt at most every `REBUILD_DELAY_MS`, and only when a list of its
// own changed. Indexes are built once per list state, so lookups are linear in the objects.
import { useEffect, useSyncExternalStore } from "react";
import type { ClusterId, KubeObject, WatchSpec, WatchState } from "../../api";
import { isCapped } from "../../api/watchState";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import type { NamespaceLabels } from "./judge";
import { labelsOf } from "../../resources/status";
import { hasReflectorAnnotations, kindRefOf, NAMESPACE, reflectionOf, type ReflectedKind } from "./model";

export const MAX_NAMESPACES = 40;
/** Objects a cluster-wide list keeps at most (the opt-in problems only). */
export const MAX_OBJECTS = 10_000;
export const SYNC_DELAY_MS = 50;
export const REBUILD_DELAY_MS = 300;

const KINDS: readonly ReflectedKind[] = ["Secret", "ConfigMap"];

/** The namespace filter's list of Namespaces (src/features/namespaces/NamespaceFilter.tsx): one stream for both. */
export const NAMESPACES_SPEC: WatchSpec = { kind: NAMESPACE, namespaces: null, labelSelector: null, fieldSelector: null };

export type ReflectorRequest = { kind: ReflectedKind; namespaces: readonly string[] } | { all: true };

export interface Lookup {
  /** The object: `null` where its namespace is read in full and it is not there, `undefined` where not known. */
  get(kind: ReflectedKind, namespace: string, name: string): KubeObject | null | undefined;
  /** The mirrors whose `reflects` names this object, in the namespaces read. */
  mirrorsOf(kind: ReflectedKind, namespace: string, name: string): KubeObject[];
  /** Whether the namespace of a kind is read in full. */
  readIn(kind: ReflectedKind, namespace: string): boolean;
  /** The listed objects that carry a Reflector annotation. */
  annotated(kind: ReflectedKind): KubeObject[];
  /** Names of the cluster's Namespaces; `undefined` while not known. */
  namespaceNames(): string[] | undefined;
  labels: NamespaceLabels;
}

export interface ReflectorState {
  loading: boolean;
  /** A cluster-wide list kept only part of its objects. */
  truncated: boolean;
  /** Namespaces asked for beyond `MAX_NAMESPACES`, per kind: not read. */
  skipped: Readonly<Record<ReflectedKind, readonly string[]>>;
  lookup: Lookup;
}

interface Held {
  spec: WatchSpec;
  release: () => void;
}

interface Entry {
  clusterId: ClusterId;
  requests: Map<number, ReflectorRequest>;
  held: Map<string, Held>;
  /** The list of each kind (and the Namespaces), after the last sync. */
  specs: { Secret?: WatchSpec; ConfigMap?: WatchSpec; namespaces?: WatchSpec };
  skipped: Record<ReflectedKind, string[]>;
  epoch: number;
  state?: ReflectorState;
  inputs?: unknown[];
}

const entries = new Map<ClusterId, Entry>();
const listeners = new Set<() => void>();
let unsubscribeShared: (() => void) | undefined;
let rebuild: ReturnType<typeof setTimeout> | undefined;
let pendingSync: ReturnType<typeof setTimeout> | undefined;
let nextToken = 0;

function notify(): void {
  for (const fn of [...listeners]) fn();
}

const metadataSpec = (kind: ReflectedKind, namespaces: string[] | null): WatchSpec => ({
  kind: kindRefOf(kind),
  namespaces,
  labelSelector: null,
  fieldSelector: null,
  metadataOnly: true,
});

function sync(entry: Entry): void {
  if (entry.epoch !== epochOf(entry.clusterId)) {
    for (const h of entry.held.values()) h.release();
    entry.held.clear();
    entry.epoch = epochOf(entry.clusterId);
  }
  const wanted = new Map<string, { spec: WatchSpec; cap?: number }>();
  const want = (spec: WatchSpec, cap?: number) => wanted.set(specKey(entry.clusterId, spec), { spec, cap });
  const all = [...entry.requests.values()].some((r) => "all" in r);
  entry.specs = {};
  entry.skipped = { Secret: [], ConfigMap: [] };
  if (entry.requests.size > 0) {
    entry.specs.namespaces = NAMESPACES_SPEC;
    want(NAMESPACES_SPEC);
  }
  for (const kind of KINDS) {
    if (all) {
      const spec = metadataSpec(kind, null);
      entry.specs[kind] = spec;
      want(spec, MAX_OBJECTS);
      continue;
    }
    const asked: string[] = [];
    for (const r of entry.requests.values()) {
      if ("all" in r || r.kind !== kind) continue;
      for (const ns of r.namespaces) if (ns && !asked.includes(ns)) asked.push(ns);
    }
    if (asked.length === 0) continue;
    entry.skipped[kind] = asked.slice(MAX_NAMESPACES);
    const spec = metadataSpec(kind, asked.slice(0, MAX_NAMESPACES).sort());
    entry.specs[kind] = spec;
    want(spec);
  }
  for (const [key, h] of [...entry.held]) {
    if (wanted.has(key)) continue;
    h.release();
    entry.held.delete(key);
  }
  for (const [key, { spec, cap }] of wanted) {
    if (!entry.held.has(key)) entry.held.set(key, { spec, release: acquireWatch(entry.clusterId, spec, cap) });
  }
  entry.inputs = undefined;
  entry.state = undefined;
}

function syncAll(): void {
  pendingSync = undefined;
  for (const [id, entry] of [...entries]) {
    sync(entry);
    if (entry.requests.size === 0) entries.delete(id);
  }
  notify();
}

function scheduleSync(): void {
  pendingSync ??= setTimeout(syncAll, SYNC_DELAY_MS);
}

function inputsOf(entry: Entry): unknown[] {
  return [epochOf(entry.clusterId), ...[...entry.held.values()].map((h) => watchState(entry.clusterId, h.spec))];
}

function onShared(): void {
  rebuild ??= setTimeout(() => {
    rebuild = undefined;
    let changed = false;
    for (const entry of entries.values()) {
      if (entry.epoch !== epochOf(entry.clusterId)) sync(entry);
      const inputs = inputsOf(entry);
      if (entry.inputs && entry.inputs.length === inputs.length && inputs.every((v, i) => v === entry.inputs![i])) continue;
      entry.inputs = inputs;
      entry.state = undefined;
      changed = true;
    }
    if (changed) notify();
  }, REBUILD_DELAY_MS);
}

/** Asks for the lists of `request`; the returned function lets go of them. */
export function acquireReflector(clusterId: ClusterId, request: ReflectorRequest): () => void {
  unsubscribeShared ??= subscribeSharedWatches(onShared);
  let entry = entries.get(clusterId);
  if (!entry) {
    entry = { clusterId, requests: new Map(), held: new Map(), specs: {}, skipped: { Secret: [], ConfigMap: [] }, epoch: epochOf(clusterId) };
    entries.set(clusterId, entry);
  }
  const token = ++nextToken;
  entry.requests.set(token, request);
  scheduleSync();
  let released = false;
  const held = entry;
  return () => {
    if (released) return;
    released = true;
    held.requests.delete(token);
    scheduleSync();
  };
}

const readable = (state: WatchState, namespace: string) => state.status === "ready" && !(state.forbidden ?? []).includes(namespace) && !isCapped(state);

interface Index {
  byName: Map<string, KubeObject>;
  byReflects: Map<string, KubeObject[]>;
  annotated: KubeObject[];
}

/** Built once per list state (a state is a new object after each change). */
const indexes = new WeakMap<WatchState, Index>();

function indexOf(state: WatchState): Index {
  let index = indexes.get(state);
  if (index) return index;
  index = { byName: new Map(), byReflects: new Map(), annotated: [] };
  for (const obj of state.items.values()) {
    const key = `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
    index.byName.set(key, obj);
    if (!hasReflectorAnnotations(obj)) continue;
    index.annotated.push(obj);
    const reflects = reflectionOf(obj).reflects;
    if (!reflects) continue;
    const r = `${reflects.namespace}/${reflects.name}`;
    const list = index.byReflects.get(r) ?? [];
    list.push(obj);
    index.byReflects.set(r, list);
  }
  indexes.set(state, index);
  return index;
}

function buildState(entry: Entry): ReflectorState {
  const lists: Partial<Record<ReflectedKind, { spec: WatchSpec; state: WatchState }>> = {};
  let loading = false;
  let truncated = false;
  for (const kind of KINDS) {
    const spec = entry.specs[kind];
    if (!spec) continue;
    const state = watchState(entry.clusterId, spec);
    lists[kind] = { spec, state };
    if (state.status === "loading") loading = true;
    if (spec.namespaces === null && isCapped(state)) truncated = true;
  }
  const nsState = entry.specs.namespaces ? watchState(entry.clusterId, entry.specs.namespaces) : undefined;
  const nsReady = nsState?.status === "ready" && !isCapped(nsState);
  const nsByName = new Map<string, KubeObject>();
  if (nsState) for (const obj of nsState.items.values()) nsByName.set(obj.metadata?.name ?? "", obj);
  const covers = (kind: ReflectedKind, namespace: string) => {
    const list = lists[kind];
    if (!list) return false;
    return list.spec.namespaces === null || list.spec.namespaces.includes(namespace);
  };
  const readIn = (kind: ReflectedKind, namespace: string) => covers(kind, namespace) && readable(lists[kind]!.state, namespace);
  const lookup: Lookup = {
    get(kind, namespace, name) {
      const list = lists[kind];
      if (!list || !covers(kind, namespace)) return undefined;
      const found = indexOf(list.state).byName.get(`${namespace}/${name}`);
      if (found) return found;
      return readable(list.state, namespace) ? null : undefined;
    },
    mirrorsOf(kind, namespace, name) {
      const list = lists[kind];
      return list ? (indexOf(list.state).byReflects.get(`${namespace}/${name}`) ?? []) : [];
    },
    readIn,
    annotated(kind) {
      const list = lists[kind];
      return list ? indexOf(list.state).annotated : [];
    },
    namespaceNames() {
      return nsReady ? [...nsByName.keys()].sort() : undefined;
    },
    labels(namespace) {
      const ns = nsByName.get(namespace);
      if (ns) return labelsOf(ns);
      return nsReady ? null : undefined;
    },
  };
  return { loading: loading || (nsState !== undefined && nsState.status === "loading"), truncated, skipped: entry.skipped, lookup };
}

const EMPTY: ReflectorState = {
  loading: true,
  truncated: false,
  skipped: { Secret: [], ConfigMap: [] },
  lookup: {
    get: () => undefined,
    mirrorsOf: () => [],
    readIn: () => false,
    annotated: () => [],
    namespaceNames: () => undefined,
    labels: () => undefined,
  },
};

/** The cluster's state now (the same object until one of its lists, its requests or the connection changes). */
export function getReflector(clusterId: ClusterId): ReflectorState {
  const entry = entries.get(clusterId);
  if (!entry || entry.held.size === 0) return EMPTY;
  entry.state ??= buildState(entry);
  return entry.state;
}

export function subscribeReflector(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Holds `request` while mounted (an equal request keeps the lists) and returns the cluster's state. */
export function useReflector(clusterId: ClusterId | null, request: ReflectorRequest | null): ReflectorState {
  const key = JSON.stringify([clusterId, request]);
  useEffect(() => {
    if (!clusterId || !request) return;
    return acquireReflector(clusterId, request);
    // `key` holds the cluster and the request by value.
  }, [key]);
  return useSyncExternalStore(subscribeReflector, () => (clusterId && request ? getReflector(clusterId) : EMPTY));
}

/** Forgets every entry (tests). */
export function resetReflectorStore(): void {
  for (const entry of entries.values()) for (const h of entry.held.values()) h.release();
  entries.clear();
  if (rebuild) clearTimeout(rebuild);
  if (pendingSync) clearTimeout(pendingSync);
  rebuild = undefined;
  pendingSync = undefined;
  unsubscribeShared?.();
  unsubscribeShared = undefined;
}
