// The fill levels of a cluster's claims (#152), polled once a minute while at least one user holds them — the PVC
// table's Usage column, a claim's or pod's details, the problems source of "disk almost full" — and shared by all of
// them: one `storage_volume_usage` call per cluster and minute however many cells ask. A released cluster keeps
// polling for `LINGER_MS` (a remount reuses it), then stops and forgets its value. Nothing is asked of a cluster that
// is known not to be connected.
import { useEffect, useSyncExternalStore } from "react";
import { api, toApiError, type ApiError, type ClusterId, type VolumeUsage, type VolumeUsageReport } from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import { claimKey } from "./usage";

export const USAGE_POLL_MS = 60_000;
export const LINGER_MS = 5000;

export interface UsageState {
  report: VolumeUsageReport | null;
  /** By `namespace/name`. */
  byClaim: ReadonlyMap<string, VolumeUsage>;
  error: ApiError | null;
  /** True until the first answer. */
  loading: boolean;
}

interface Entry {
  state: UsageState;
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
  linger: ReturnType<typeof setTimeout> | null;
  /** Bumped by each request; an older answer is dropped. */
  seq: number;
  /** A round is running (one can take 40 s and a Prometheus fallback): no second one starts meanwhile. */
  running: boolean;
  /** Asked again while a round ran (the cluster connected): a new round starts as soon as it ends. */
  again: boolean;
}

const LOADING: UsageState = Object.freeze({ report: null, byClaim: new Map(), error: null, loading: true });
const entries = new Map<ClusterId, Entry>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of [...listeners]) fn();
}

const connected = (clusterId: ClusterId) => {
  const state = useClustersStore.getState().states[clusterId]?.state;
  return state === undefined || state === "connected";
};

function load(clusterId: ClusterId, entry: Entry): void {
  if (!connected(clusterId)) return;
  if (entry.running) {
    entry.again = true;
    return;
  }
  entry.running = true;
  entry.again = false;
  const seq = ++entry.seq;
  const done = (state: UsageState) => {
    if (entries.get(clusterId) !== entry || seq !== entry.seq) return;
    entry.running = false;
    entry.state = state;
    changed();
    if (entry.again && entry.timer) load(clusterId, entry);
  };
  api.storage.volumeUsage(clusterId).then(
    (report) =>
      done({ report, byClaim: new Map(report.volumes.map((v) => [claimKey(v.namespace, v.claim), v])), error: null, loading: false }),
    (err: unknown) => done({ report: null, byClaim: new Map(), error: toApiError(err), loading: false }),
  );
}

let unfollow: (() => void) | undefined;

/** A held cluster that connects (again) is measured at once, not at the next tick. */
function followConnections(): void {
  if (unfollow) return;
  unfollow = useClustersStore.subscribe((s, prev) => {
    if (s.states === prev.states) return;
    for (const [clusterId, entry] of entries) {
      const now = s.states[clusterId]?.state;
      if (now === "connected" && prev.states[clusterId]?.state !== "connected" && entry.timer) load(clusterId, entry);
    }
  });
}

/** Starts (or shares) polling the cluster's fill levels; the returned function releases it. */
export function acquireVolumeUsage(clusterId: ClusterId): () => void {
  followConnections();
  let entry = entries.get(clusterId);
  if (!entry) {
    entry = { state: LOADING, refs: 0, timer: null, linger: null, seq: 0, running: false, again: false };
    entries.set(clusterId, entry);
  }
  const held = entry;
  if (held.linger) clearTimeout(held.linger);
  held.linger = null;
  held.refs += 1;
  if (!held.timer) {
    if (held.state === LOADING || held.state.error) load(clusterId, held);
    held.timer = setInterval(() => load(clusterId, held), USAGE_POLL_MS);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    if (held.refs > 0) return;
    held.linger = setTimeout(() => {
      if (entries.get(clusterId) !== held || held.refs > 0) return;
      if (held.timer) clearInterval(held.timer);
      entries.delete(clusterId);
      changed();
    }, LINGER_MS);
  };
}

/** The cluster's fill levels while someone holds them. */
export function getVolumeUsage(clusterId: ClusterId): UsageState | undefined {
  return entries.get(clusterId)?.state;
}

/** The latest fill level of one claim (sorting the Usage column). */
export function latestClaimUsage(clusterId: ClusterId | null, namespace: string | undefined, name: string | undefined): VolumeUsage | undefined {
  return clusterId ? entries.get(clusterId)?.state.byClaim.get(claimKey(namespace, name)) : undefined;
}

export function subscribeVolumeUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Holds the cluster's fill levels while mounted (`null`: nothing) and returns them. */
export function useVolumeUsage(clusterId: ClusterId | null): UsageState {
  useEffect(() => (clusterId ? acquireVolumeUsage(clusterId) : undefined), [clusterId]);
  return useSyncExternalStore(
    subscribeVolumeUsage,
    () => (clusterId ? (entries.get(clusterId)?.state ?? LOADING) : LOADING),
    () => LOADING,
  );
}

/** How many clusters are polled (tests). */
export function volumeUsageStats(): { clusters: number; polling: number } {
  return { clusters: entries.size, polling: [...entries.values()].filter((e) => e.timer !== null).length };
}

/** Stops every poller and forgets every value (tests). */
export function resetVolumeUsage(): void {
  for (const entry of entries.values()) {
    if (entry.timer) clearInterval(entry.timer);
    if (entry.linger) clearTimeout(entry.linger);
  }
  entries.clear();
  unfollow?.();
  unfollow = undefined;
  changed();
}
