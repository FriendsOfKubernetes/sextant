// The references of a cluster's Traefik objects and whether they lead anywhere (#232), shared by the status column, the
// details, the section counter and the problems provider: one watch per Traefik kind the cluster serves (both groups),
// in all namespaces, each keeping at most `MAX_OBJECTS`; metadata-only lists of the Services and of the Secrets in the
// namespaces the references name (at most `MAX_TARGET_NAMESPACES` each — beyond it those references stay unknown). A
// metadata-only Secret list carries names only (and the core strips Secrets anyway): no value is ever read here. The
// watches are the shared ones of the resource map (`acquireWatch`), released `LINGER_MS` after the last user and taken
// anew when the cluster reconnects; kinds the cluster does not serve are never watched. Changes are looked at once per
// `REBUILD_DELAY_MS`.
import { useEffect, useSyncExternalStore } from "react";
import type { ClusterId, KindRef, KubeObject, ObjectRef, WatchSpec, WatchState } from "../../api";
import { isCapped } from "../../api/watchState";
import { findKind, useClusterKinds } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import { referencesOf, SECRET, SERVICE, TRAEFIK_KINDS, type RefKind } from "./model";
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
  secrets?: WatchSpec;
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
  }
  if (namespaces.size === 0 || namespaces.size > MAX_TARGET_NAMESPACES) return undefined;
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
  const secret = kinds ? findKind(kinds, SECRET)?.kindRef : undefined;
  entry.services = service ? targetsSpec(entry, service, "Service") : undefined;
  entry.secrets = secret ? targetsSpec(entry, secret, "Secret") : undefined;
  want(entry.services);
  want(entry.secrets);
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

function hasName(state: WatchState, namespace: string, name: string): boolean {
  for (const obj of state.items.values()) if (obj.metadata?.namespace === namespace && obj.metadata?.name === name) return true;
  return false;
}

/** The lookup over the entry's lists: a list not read (or not complete) answers `undefined` unless it has the name. */
export function lookupOf(lists: readonly { kind: Pick<KindRef, "kind">; state: WatchState }[], targets: { kind: RefKind; spec?: WatchSpec; state?: WatchState }[]): Lookup {
  return {
    exists(kind, namespace, name) {
      const target = targets.find((t) => t.kind === kind);
      if (target) {
        if (!target.spec || !target.state || !(target.spec.namespaces ?? []).includes(namespace)) return undefined;
        if (hasName(target.state, namespace, name)) return true;
        return readableIn(target.state, namespace) ? false : undefined;
      }
      const of = lists.filter((l) => l.kind.kind === kind);
      if (of.some((l) => hasName(l.state, namespace, name))) return true;
      // A kind neither group serves has no objects at all.
      return of.every((l) => readableIn(l.state, namespace)) ? false : undefined;
    },
  };
}

function build(entry: Entry): TraefikState {
  entry.inputs = inputsOf(entry);
  if (!entry.served) return { loading: true, findings: [], truncated: false, byUid: new Map() };
  const lists = traefikLists(entry);
  const services = entry.services ? watchState(entry.clusterId, entry.services) : undefined;
  const secrets = entry.secrets ? watchState(entry.clusterId, entry.secrets) : undefined;
  if ([...lists.map((l) => l.state), services, secrets].some((s) => s?.status === "loading")) return { loading: true, findings: [], truncated: false, byUid: new Map() };
  const lookup = lookupOf(lists, [
    { kind: "Service", spec: entry.services, state: services },
    { kind: "Secret", spec: entry.secrets, state: secrets },
  ]);
  const findings: TraefikFinding[] = [];
  for (const { kind, state } of lists) {
    for (const obj of state.items.values()) {
      findings.push({
        uid: obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`,
        ref: { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" },
        judgement: judge(kind, obj, lookup),
      });
    }
  }
  return { loading: false, findings, truncated: lists.some((l) => isCapped(l.state)), byUid: new Map(findings.map((f) => [f.uid, f])) };
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
  if (held.linger) {
    clearTimeout(held.linger);
    held.linger = undefined;
  }
  held.refs++;
  sync(held);
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

const EMPTY: TraefikState = { loading: true, findings: [], truncated: false, byUid: new Map() };

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
