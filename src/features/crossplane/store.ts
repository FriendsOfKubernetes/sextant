// The claims and composites of a cluster, shared by the "Composite resources" page, the section counter and the
// problems provider (#213). Their kinds are defined by the XRDs, so the store watches the XRDs (few, small,
// cluster-scoped) and then the composite and claim kinds of at most `MAX_XRDS` of them (by name) that discovery says
// the cluster serves, in all namespaces. Kinds the cluster does not serve are never watched and nothing is watched
// before discovery. The watches are the shared ones (`resource-map/watches.ts`), released `LINGER_MS` after the last
// user and taken anew when the cluster reconnects. Each object is reduced to a row; objects stay only in the shared
// registry, which a table of the same kind reuses.
import { useEffect, useSyncExternalStore } from "react";
import type { ClusterId, KindRef, KubeObject, ObjectRef, WatchSpec } from "../../api";
import { findKind, status, useClusterKinds } from "../../resources";
import { knownClusterKinds } from "../../resources/useKinds";
import { acquireWatch, epochOf, specKey, subscribeSharedWatches, watchState } from "../resource-map/watches";
import {
  claimRefOf,
  compositionOf,
  conditionStatus,
  firstFailing,
  parseXrd,
  resourceHealth,
  XRD,
  type Condition,
  type Health,
  type Role,
  type XrdInfo,
} from "./model";

export const LINGER_MS = 5000;
/** XRDs whose kinds are watched at most (two kinds each). */
export const MAX_XRDS = 20;
/** Rows kept at most per cluster; beyond it the page says it shows a part. */
export const MAX_ROWS = 5000;

export interface Row {
  ref: ObjectRef;
  uid: string;
  role: Role;
  health: Health;
  synced?: string;
  ready?: string;
  failing?: Condition;
  composition?: string;
  /** A composite a claim stands for: its problems are told through the claim. */
  claimed: boolean;
  created?: string;
}

export interface CrossplaneState {
  /** Discovery or a list has not come yet. */
  loading: boolean;
  /** The cluster serves XRDs. */
  served: boolean;
  xrds: XrdInfo[];
  /** More XRDs than `MAX_XRDS`: the kinds of the others are not watched. */
  xrdsTruncated: boolean;
  rows: Row[];
  rowsTruncated: boolean;
}

interface Entry {
  clusterId: ClusterId;
  refs: number;
  linger?: ReturnType<typeof setTimeout>;
  held: Map<string, { spec: WatchSpec; release: () => void }>;
  epoch: number;
  xrdKind?: KindRef | null;
  /** The served kinds watched, with their role. */
  watched: { kind: KindRef; role: Role }[];
  state?: CrossplaneState;
}

const entries = new Map<ClusterId, Entry>();
const listeners = new Set<() => void>();
let unsubscribeShared: (() => void) | undefined;

const everywhere = (kind: KindRef): WatchSpec => ({ kind, namespaces: null, labelSelector: null, fieldSelector: null });

function notify(): void {
  for (const fn of [...listeners]) fn();
}

function onShared(): void {
  for (const entry of entries.values()) {
    entry.state = undefined;
    sync(entry);
  }
  notify();
}

function xrdsOf(entry: Entry): { xrds: XrdInfo[]; truncated: boolean } {
  if (!entry.xrdKind) return { xrds: [], truncated: false };
  const all = [...watchState(entry.clusterId, everywhere(entry.xrdKind)).items.values()]
    .map(parseXrd)
    .filter((x): x is XrdInfo => x !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { xrds: all, truncated: all.length > MAX_XRDS };
}

/** Takes the watches the entry needs now and lets go of the others. */
function sync(entry: Entry): void {
  if (entry.refs === 0 && !entry.linger) return;
  if (entry.epoch !== epochOf(entry.clusterId)) {
    for (const h of entry.held.values()) h.release();
    entry.held.clear();
    entry.epoch = epochOf(entry.clusterId);
  }
  const kinds = knownClusterKinds(entry.clusterId);
  entry.xrdKind = kinds ? (findKind(kinds, XRD)?.kindRef ?? null) : undefined;
  const wanted = new Map<string, WatchSpec>();
  entry.watched = [];
  if (entry.xrdKind) {
    wanted.set(specKey(entry.clusterId, everywhere(entry.xrdKind)), everywhere(entry.xrdKind));
    for (const x of xrdsOf(entry).xrds.slice(0, MAX_XRDS)) {
      for (const [kind, role] of [[x.composite, "composite"], [x.claim, "claim"]] as const) {
        const served = kind && kinds ? findKind(kinds, kind)?.kindRef : undefined;
        if (!served) continue;
        entry.watched.push({ kind: served, role });
        wanted.set(specKey(entry.clusterId, everywhere(served)), everywhere(served));
      }
    }
  }
  for (const [key, h] of [...entry.held]) {
    if (wanted.has(key)) continue;
    h.release();
    entry.held.delete(key);
  }
  for (const [key, spec] of wanted) {
    if (!entry.held.has(key)) entry.held.set(key, { spec, release: acquireWatch(entry.clusterId, spec) });
  }
}

/** One claim or composite as a row (cached per object: a watch hands out the same object until it changes). */
const rowCache = new WeakMap<KubeObject, Row>();
export function toRow(obj: KubeObject, kind: KindRef, role: Role): Row {
  const cached = rowCache.get(obj);
  if (cached && cached.role === role) return cached;
  const row: Row = {
    ref: { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" },
    uid: obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`,
    role,
    health: resourceHealth(obj),
    synced: conditionStatus(obj, "Synced"),
    ready: conditionStatus(obj, "Ready"),
    failing: firstFailing(obj),
    composition: compositionOf(obj),
    claimed: role === "composite" && claimRefOf(obj) !== undefined,
    created: status.str(obj.metadata?.creationTimestamp),
  };
  rowCache.set(obj, row);
  return row;
}

function build(entry: Entry): CrossplaneState {
  const { xrds, truncated } = xrdsOf(entry);
  const xrdState = entry.xrdKind ? watchState(entry.clusterId, everywhere(entry.xrdKind)) : undefined;
  const states = entry.watched.map((w) => watchState(entry.clusterId, everywhere(w.kind)));
  const loading = entry.xrdKind === undefined || xrdState?.status === "loading" || states.some((s) => s.status === "loading");
  const rows: Row[] = [];
  let rowsTruncated = false;
  entry.watched.forEach((w, i) => {
    for (const obj of states[i]!.items.values()) {
      if (rows.length >= MAX_ROWS) {
        rowsTruncated = true;
        return;
      }
      rows.push(toRow(obj, w.kind, w.role));
    }
  });
  return { loading, served: !!entry.xrdKind, xrds, xrdsTruncated: truncated, rows, rowsTruncated };
}

/** Holds the cluster's claims and composites; returns the function that lets go of them. */
export function acquireCrossplane(clusterId: ClusterId): () => void {
  unsubscribeShared ??= subscribeSharedWatches(onShared);
  let entry = entries.get(clusterId);
  if (!entry) {
    entry = { clusterId, refs: 0, held: new Map(), epoch: epochOf(clusterId), watched: [] };
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
export function refreshCrossplane(clusterId: ClusterId): void {
  const entry = entries.get(clusterId);
  if (!entry) return;
  entry.state = undefined;
  sync(entry);
  notify();
}

const EMPTY: CrossplaneState = { loading: true, served: false, xrds: [], xrdsTruncated: false, rows: [], rowsTruncated: false };

export function getCrossplane(clusterId: ClusterId): CrossplaneState {
  const entry = entries.get(clusterId);
  if (!entry) return EMPTY;
  entry.state ??= build(entry);
  return entry.state;
}

export function subscribeCrossplane(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The cluster's claims and composites, held while mounted (`enabled` false holds nothing). */
export function useCrossplane(clusterId: ClusterId, enabled = true): CrossplaneState {
  const { kinds } = useClusterKinds(clusterId);
  useEffect(() => {
    if (!enabled) return;
    return acquireCrossplane(clusterId);
  }, [clusterId, enabled]);
  useEffect(() => {
    if (enabled) refreshCrossplane(clusterId);
  }, [clusterId, enabled, kinds]);
  const state = useSyncExternalStore(subscribeCrossplane, () => getCrossplane(clusterId));
  return enabled ? state : EMPTY;
}

/** Forgets everything (tests). */
export function resetCrossplaneStore(): void {
  for (const entry of entries.values()) {
    if (entry.linger) clearTimeout(entry.linger);
    for (const h of entry.held.values()) h.release();
  }
  entries.clear();
  unsubscribeShared?.();
  unsubscribeShared = undefined;
}
