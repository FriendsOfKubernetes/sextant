// The references of a cluster's Traefik objects and whether they lead anywhere (#232), shared by the status column, the
// details, the section counter and the problems provider: one watch per Traefik kind the cluster serves (both groups),
// in all namespaces, each keeping at most `MAX_OBJECTS`; a metadata-only list of the Services in the namespaces the
// references name (at most `MAX_TARGET_NAMESPACES` — beyond it those references stay unknown). Secrets are never
// listed here: this store runs in the background for the problems, so a Secret reference is judged only by the
// details of one object while they are open (details.tsx, one metadata-only list of the namespaces it names). The
// watches are the shared ones of the resource map (`acquireWatch`), released `LINGER_MS` after the last user and
// taken anew when the cluster reconnects; kinds the cluster does not serve are never watched. Changes are looked at
// once per `REBUILD_DELAY_MS`, and a cluster's findings are rebuilt only when one of its own watches, the connection
// or discovery changed. Each list is indexed once per state (a set of `namespace/name`), so a rebuild is linear in
// the objects and their references.
import { useEffect, useSyncExternalStore } from "react";
import type { ClusterId, KindRef, KubeObject, ObjectRef, WatchSpec, WatchState } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind, useClusterKinds } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import { LEGACY_GROUP, referencesOf, SERVICE, TRAEFIK_GROUP, TRAEFIK_KINDS, type RefKind } from "./model";
import { judge, type Judgement, type Lookup } from "./resolve";

export const LINGER_MS = 5000;
export const MAX_TARGET_NAMESPACES = 40;
/** Objects a watch of one Traefik kind keeps at most (all namespaces). */
export const MAX_OBJECTS = 5000;
export const REBUILD_DELAY_MS = 500;

export interface TraefikFinding {
  uid: string;
  ref: ObjectRef;
  judgement: Judgement;
}

export interface TraefikState {
  loading: boolean;
  findings: TraefikFinding[];
  /** A list kept only part of its objects. */
  truncated: boolean;
  /** The findings by uid (a table row looks its object up here). */
  byUid: ReadonlyMap<string, TraefikFinding>;
  /** The lookup the findings were judged with (the details add their Secrets to it). */
  lookup?: Lookup;
  /**
   * Whether the other group holds an object of the same kind, namespace and name (a `traefik.io` object's twin in
   * `traefik.containo.us`, or the reverse); `undefined` when that list is not known or the group is not served.
   */
  twin?: (kind: Pick<KindRef, "group" | "kind">, namespace: string, name: string) => boolean | undefined;
}

interface Entry {
  clusterId: ClusterId;
  refs: number;
  linger?: ReturnType<typeof setTimeout>;
  held: Map<string, { spec: WatchSpec; release: () => void }>;
  epoch: number;
  /** The served version of each of `TRAEFIK_KINDS` (`null`: not served); `undefined` before discovery. */
  served?: (KindRef | null)[];
  services?: WatchSpec;
  state?: TraefikState;
  inputs?: unknown[];
  /** The discovery result the entry was last refreshed for (every table row asks; one refresh is enough). */
  refreshedFor?: unknown;
}

const entries = new Map<ClusterId, Entry>();
const listeners = new Set<() => void>();
let unsubscribeShared: (() => void) | undefined;
let rebuild: ReturnType<typeof setTimeout> | undefined;

const everywhere = (kind: KindRef): WatchSpec => ({ kind, namespaces: null, labelSelector: null, fieldSelector: null });

function notify(): void {
  for (const fn of [...listeners]) fn();
}

function inputsOf(entry: Entry): unknown[] {
  return [epochOf(entry.clusterId), knownClusterKinds(entry.clusterId), ...[...entry.held.values()].map((h) => watchState(entry.clusterId, h.spec))];
}

const sameInputs = (a: unknown[] | undefined, b: unknown[]) => a !== undefined && a.length === b.length && b.every((v, i) => v === a[i]);

function onShared(): void {
  rebuild ??= setTimeout(() => {
    rebuild = undefined;
    let changed = false;
    for (const entry of entries.values()) {
      const inputs = inputsOf(entry);
      if (sameInputs(entry.inputs, inputs)) continue;
      entry.inputs = inputs;
      entry.state = undefined;
      sync(entry);
      changed = true;
    }
    if (changed) notify();
  }, REBUILD_DELAY_MS);
}

/** The served Traefik kinds with their objects (a list not read yet has none). */
function traefikLists(entry: Entry): { kind: KindRef; state: WatchState }[] {
  return (entry.served ?? []).flatMap((kind) => (kind ? [{ kind, state: watchState(entry.clusterId, everywhere(kind)) }] : []));
}

/** The metadata-only list of `kind` in the namespaces the references of `refKind` name, if they are few enough. */
function targetsSpec(entry: Entry, kind: KindRef, refKind: RefKind): WatchSpec | undefined {
  const namespaces = new Set<string>();
  for (const { kind: k, state } of traefikLists(entry)) {
    for (const obj of state.items.values()) for (const r of referencesOf(k, obj)) if (r.kind === refKind && !r.provider) namespaces.add(r.namespace);
    if (namespaces.size > MAX_TARGET_NAMESPACES) return undefined;
  }
  if (namespaces.size === 0) return undefined;
  return { kind, namespaces: [...namespaces].sort(), labelSelector: null, fieldSelector: null, metadataOnly: true };
}

function sync(entry: Entry): void {
  if (entry.refs === 0 && !entry.linger) return;
  if (entry.epoch !== epochOf(entry.clusterId)) {
    for (const h of entry.held.values()) h.release();
    entry.held.clear();
    entry.epoch = epochOf(entry.clusterId);
  }
  const kinds = knownClusterKinds(entry.clusterId);
  entry.served = kinds ? TRAEFIK_KINDS.map((d) => findKind(kinds, d.kind)?.kindRef ?? null) : undefined;
  const wanted = new Map<string, { spec: WatchSpec; cap?: number }>();
  const want = (spec: WatchSpec | undefined, cap?: number) => spec && wanted.set(specKey(entry.clusterId, spec), { spec, cap });
  for (const kind of entry.served ?? []) if (kind) want(everywhere(kind), MAX_OBJECTS);
  const service = kinds ? findKind(kinds, SERVICE)?.kindRef : undefined;
  entry.services = service ? targetsSpec(entry, service, "Service") : undefined;
  want(entry.services);
  for (const [key, h] of [...entry.held]) {
    if (wanted.has(key)) continue;
    h.release();
    entry.held.delete(key);
  }
  for (const [key, { spec, cap }] of wanted) {
    if (!entry.held.has(key)) entry.held.set(key, { spec, release: acquireWatch(entry.clusterId, spec, cap) });
  }
}

const readableIn = (state: WatchState, namespace: string) => state.status === "ready" && !(state.forbidden ?? []).includes(namespace) && !isCapped(state);

/** `namespace/name` of every object of a list, built once per state (a state is a new object after each change). */
const names = new WeakMap<WatchState, ReadonlySet<string>>();
const nameKey = (namespace: string, name: string) => `${namespace}/${name}`;

export function namesOf(state: WatchState): ReadonlySet<string> {
  let set = names.get(state);
  if (!set) {
    set = new Set([...state.items.values()].map((o) => nameKey(o.metadata?.namespace ?? "", o.metadata?.name ?? "")));
    names.set(state, set);
  }
  return set;
}

/** Whether a list has the name: `true`, `false` where it is read in full there, else `undefined`. */
export function listHas(state: WatchState, namespace: string, name: string): boolean | undefined {
  if (namesOf(state).has(nameKey(namespace, name))) return true;
  return readableIn(state, namespace) ? false : undefined;
}

export interface TraefikList {
  /** The served kind, with its group. */
  kind: Pick<KindRef, "group" | "kind">;
  state: WatchState;
}

/**
 * The lookup over the entry's lists: a list not read (or not complete) answers `undefined` unless it has the name. A
 * Traefik kind is looked up in `traefik.io` where that group serves it (Traefik v3 reads nothing else), else in
 * `traefik.containo.us`; `legacy` tells whether the old group has the name too.
 */
export function lookupOf(lists: readonly TraefikList[], targets: { kind: RefKind; spec?: WatchSpec; state?: WatchState }[]): Lookup {
  const byKind = new Map<string, { own?: WatchState; legacy?: WatchState }>();
  for (const l of lists) {
    const slot = byKind.get(l.kind.kind) ?? {};
    if (l.kind.group === TRAEFIK_GROUP) slot.own = l.state;
    else if (l.kind.group === LEGACY_GROUP) slot.legacy = l.state;
    byKind.set(l.kind.kind, slot);
  }
  const targetOf = new Map(targets.map((t) => [t.kind, t]));
  return {
    exists(kind, namespace, name) {
      const target = targetOf.get(kind);
      if (target) {
        if (!target.spec || !target.state || !(target.spec.namespaces ?? []).includes(namespace)) return undefined;
        return listHas(target.state, namespace, name);
      }
      const slot = byKind.get(kind);
      const list = slot?.own ?? slot?.legacy;
      // A kind neither group serves has no objects at all; Secrets and other kinds not listed here are not known.
      if (!list) return kind === "Service" || kind === "Secret" ? undefined : false;
      return listHas(list, namespace, name);
    },
    legacy(kind, namespace, name) {
      const slot = byKind.get(kind);
      if (!slot?.own || !slot.legacy) return false;
      return listHas(slot.legacy, namespace, name);
    },
  };
}

/** Judges every object of the lists (Secrets left to the details). Linear in the objects and their references. */
export function buildFindings(lists: readonly TraefikList[], lookup: Lookup): TraefikFinding[] {
  const findings: TraefikFinding[] = [];
  const skip = (ref: { kind: RefKind }) => ref.kind === "Secret";
  for (const { kind, state } of lists) {
    for (const obj of state.items.values()) {
      findings.push({
        uid: obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`,
        ref: { kind: kind as KindRef, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" },
        judgement: judge(kind, obj, lookup, skip),
      });
    }
  }
  return findings;
}

/** The twin finder over the lists: the same kind of the other group. */
function twinsOf(lists: readonly TraefikList[]): TraefikState["twin"] {
  return (kind, namespace, name) => {
    const other = kind.group === TRAEFIK_GROUP ? LEGACY_GROUP : TRAEFIK_GROUP;
    const list = lists.find((l) => l.kind.group === other && l.kind.kind === kind.kind);
    return list ? listHas(list.state, namespace, name) : undefined;
  };
}

const loadingState = (): TraefikState => ({ loading: true, findings: [], truncated: false, byUid: new Map() });

function build(entry: Entry): TraefikState {
  entry.inputs = inputsOf(entry);
  if (!entry.served) return loadingState();
  const lists = traefikLists(entry);
  const services = entry.services ? watchState(entry.clusterId, entry.services) : undefined;
  if ([...lists.map((l) => l.state), services].some((s) => s?.status === "loading")) return loadingState();
  const lookup = lookupOf(lists, [{ kind: "Service", spec: entry.services, state: services }]);
  const findings = buildFindings(lists, lookup);
  return {
    loading: false,
    findings,
    truncated: lists.some((l) => isCapped(l.state)),
    byUid: new Map(findings.map((f) => [f.uid, f])),
    lookup,
    twin: twinsOf(lists),
  };
}

/** Holds the cluster's Traefik objects and what their references find; returns the function that lets go of them. */
export function acquireTraefik(clusterId: ClusterId): () => void {
  unsubscribeShared ??= subscribeSharedWatches(onShared);
  let entry = entries.get(clusterId);
  if (!entry) {
    entry = { clusterId, refs: 0, held: new Map(), epoch: epochOf(clusterId) };
    entries.set(clusterId, entry);
  }
  const held = entry;
  const wasHeld = held.refs > 0 || held.linger !== undefined;
  if (held.linger) {
    clearTimeout(held.linger);
    held.linger = undefined;
  }
  held.refs++;
  // Every table row holds the store: only the first holder (or one after a release) needs the watches looked at.
  if (!wasHeld) sync(held);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs--;
    if (held.refs > 0) return;
    held.linger = setTimeout(() => {
      held.linger = undefined;
      if (held.refs > 0 || entries.get(clusterId) !== held) return;
      for (const h of held.held.values()) h.release();
      entries.delete(clusterId);
      notify();
    }, LINGER_MS);
  };
}

/** Looks again at what the cluster serves (discovery came or changed). */
export function refreshTraefik(clusterId: ClusterId, kinds?: unknown): void {
  const entry = entries.get(clusterId);
  if (!entry) return;
  if (kinds !== undefined && entry.refreshedFor === kinds) return;
  entry.refreshedFor = kinds;
  entry.state = undefined;
  sync(entry);
  notify();
}

const EMPTY: TraefikState = loadingState();

export function getTraefik(clusterId: ClusterId): TraefikState {
  const entry = entries.get(clusterId);
  if (!entry) return EMPTY;
  entry.state ??= build(entry);
  return entry.state;
}

export function subscribeTraefik(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The judgement of one object in a cluster whose Traefik objects are held (the "Only problems" filter). */
export function judgementOf(obj: KubeObject): Judgement | undefined {
  const uid = obj.metadata?.uid;
  if (!uid) return undefined;
  for (const entry of entries.values()) {
    const found = entry.state?.byUid.get(uid);
    if (found) return found.judgement;
  }
  return undefined;
}

/** The cluster's Traefik findings, held while mounted. */
export function useTraefik(clusterId: ClusterId): TraefikState {
  const { kinds } = useClusterKinds(clusterId);
  useEffect(() => acquireTraefik(clusterId), [clusterId]);
  useEffect(() => refreshTraefik(clusterId, kinds), [clusterId, kinds]);
  return useSyncExternalStore(subscribeTraefik, () => getTraefik(clusterId));
}

/** Forgets everything (tests). */
export function resetTraefikStore(): void {
  for (const entry of entries.values()) {
    if (entry.linger) clearTimeout(entry.linger);
    for (const h of entry.held.values()) h.release();
  }
  entries.clear();
  unsubscribeShared?.();
  unsubscribeShared = undefined;
  if (rebuild) clearTimeout(rebuild);
  rebuild = undefined;
}
