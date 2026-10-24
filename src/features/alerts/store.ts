// A cluster's alerts (#264), polled once a minute while at least one user holds them — the Alerts page, an object's
// "Alerts" section, the cluster settings' alerts block, the problems source of the opt-in `alerts` category — and
// shared by all of them: one `alerts_list` call per cluster and minute however many views ask. A poll is skipped while
// the window is hidden and made at once when it shows again. A released cluster keeps polling for `LINGER_MS` (a
// remount reuses it), then stops and forgets its value. Nothing is asked of a cluster that is known not to be
// connected.
import { useEffect, useSyncExternalStore } from "react";
import { api, toApiError, type AlertsReport, type ApiError, type ClusterId } from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import { indexAlerts, type AlertIndex } from "./model";

export const ALERTS_POLL_MS = 60_000;
export const LINGER_MS = 5000;

export interface AlertsState {
  report: AlertsReport | null;
  index: AlertIndex;
  error: ApiError | null;
  /** True until the first answer. */
  loading: boolean;
}

interface Entry {
  state: AlertsState;
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
  linger: ReturnType<typeof setTimeout> | null;
  /** Bumped by each request; an older answer is dropped. */
  seq: number;
  running: boolean;
  /** Asked again while a round ran: a new round starts as soon as it ends. */
  again: boolean;
  /** A tick was skipped while the window was hidden. */
  missed: boolean;
}

const EMPTY_INDEX: AlertIndex = { byTarget: new Map(), byPod: new Map() };
const LOADING: AlertsState = Object.freeze({ report: null, index: EMPTY_INDEX, error: null, loading: true });
const entries = new Map<ClusterId, Entry>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const fn of [...listeners]) fn();
}

const connected = (clusterId: ClusterId) => {
  const state = useClustersStore.getState().states[clusterId]?.state;
  return state === undefined || state === "connected";
};

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function load(clusterId: ClusterId, entry: Entry): void {
  if (!connected(clusterId)) return;
  if (entry.running) {
    entry.again = true;
    return;
  }
  entry.running = true;
  entry.again = false;
  entry.missed = false;
  const seq = ++entry.seq;
  const done = (state: AlertsState) => {
    if (entries.get(clusterId) !== entry || seq !== entry.seq) return;
    entry.running = false;
    entry.state = state;
    changed();
    if (entry.again && entry.timer) load(clusterId, entry);
  };
  api.alerts.list(clusterId).then(
    (report) => done({ report, index: indexAlerts(report.alerts), error: null, loading: false }),
    (err: unknown) => done({ report: null, index: EMPTY_INDEX, error: toApiError(err), loading: false }),
  );
}

function tick(clusterId: ClusterId, entry: Entry): void {
  if (hidden()) entry.missed = true;
  else load(clusterId, entry);
}

let unfollow: (() => void) | undefined;

/** A held cluster that connects (again), and every held one when the window shows again after a missed tick, is
 * asked at once. */
function follow(): void {
  if (unfollow) return;
  const unsubscribe = useClustersStore.subscribe((s, prev) => {
    if (s.states === prev.states) return;
    for (const [clusterId, entry] of entries) {
      const now = s.states[clusterId]?.state;
      if (now === "connected" && prev.states[clusterId]?.state !== "connected" && entry.timer) load(clusterId, entry);
    }
  });
  const onVisible = () => {
    if (hidden()) return;
    for (const [clusterId, entry] of entries) if (entry.missed && entry.timer) load(clusterId, entry);
  };
  document.addEventListener("visibilitychange", onVisible);
  unfollow = () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Starts (or shares) polling the cluster's alerts; the returned function releases it. */
export function acquireAlerts(clusterId: ClusterId): () => void {
  follow();
  let entry = entries.get(clusterId);
  if (!entry) {
    entry = { state: LOADING, refs: 0, timer: null, linger: null, seq: 0, running: false, again: false, missed: false };
    entries.set(clusterId, entry);
  }
  const held = entry;
  if (held.linger) clearTimeout(held.linger);
  held.linger = null;
  held.refs += 1;
  if (!held.timer) {
    if (held.state === LOADING || held.state.error) load(clusterId, held);
    held.timer = setInterval(() => tick(clusterId, held), ALERTS_POLL_MS);
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

/** Asks a held cluster again now (the cluster settings changed how the sources are found). */
export function refreshAlerts(clusterId: ClusterId): void {
  const entry = entries.get(clusterId);
  if (entry?.timer) load(clusterId, entry);
}

/** The cluster's alerts while someone holds them. */
export function getAlerts(clusterId: ClusterId): AlertsState | undefined {
  return entries.get(clusterId)?.state;
}

export function subscribeAlerts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Holds the cluster's alerts while mounted (`null`: nothing) and returns them. */
export function useAlerts(clusterId: ClusterId | null): AlertsState {
  useEffect(() => (clusterId ? acquireAlerts(clusterId) : undefined), [clusterId]);
  return useSyncExternalStore(
    subscribeAlerts,
    () => (clusterId ? (entries.get(clusterId)?.state ?? LOADING) : LOADING),
    () => LOADING,
  );
}

/** How many clusters are polled (tests). */
export function alertsStats(): { clusters: number; polling: number } {
  return { clusters: entries.size, polling: [...entries.values()].filter((e) => e.timer !== null).length };
}

/** Stops every poller and forgets every value (tests). */
export function resetAlerts(): void {
  for (const entry of entries.values()) {
    if (entry.timer) clearInterval(entry.timer);
    if (entry.linger) clearTimeout(entry.linger);
  }
  entries.clear();
  unfollow?.();
  unfollow = undefined;
  changed();
}
