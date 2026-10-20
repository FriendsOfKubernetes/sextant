// Hooks of the metrics feature. Every value is fetched by one shared poller per key (cluster + metrics settings +
// what is asked), refreshed every 30 seconds while at least one component uses it (a tick is skipped while the last
// load is still in flight, so rounds never overlap) and stopped when the last one unmounts — so a table with a thousand CPU cells makes one `metrics_pods` call, and only while the table is open.
// A value nobody shows is kept for `IDLE_TTL_MS` (at most `MAX_IDLE_ENTRIES` of them) and then forgotten.
// A change of the cluster's metrics settings changes the key, so the next values come from the new source at once.
import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  api,
  toApiError,
  useSettings,
  type ApiError,
  type ChartTarget,
  type ClusterId,
  type ClusterSettings,
  type MetricsStatus,
  type NodeUsage,
  type PodUsage,
  type Series,
} from "../../api";
import { clusterSettingsOf } from "../clusters/clusterSettings";
import { useSelectedNamespaces } from "../namespaces";

/** How often current values, the status and charts refresh while shown. */
export const POLL_INTERVAL_MS = 30_000;
/** How long a value nobody shows is kept, so a quick reopen shows it at once (and polls on from it). */
export const IDLE_TTL_MS = POLL_INTERVAL_MS;
/** At most this many values nobody shows are kept; the oldest goes first. */
export const MAX_IDLE_ENTRIES = 32;
/** Charts show the last hour. */
export const CHART_RANGE_SECS = 3600;

export interface Polled<T> {
  data: T | null;
  error: ApiError | null;
  /** True until the first answer. */
  loading: boolean;
}

interface Entry {
  state: Polled<unknown>;
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
  fetchedAt: number;
  seq: number;
  /** A load is in flight: the next tick is skipped rather than overlapping it (a slow Prometheus would otherwise
   * get a new round of queries every interval while the last are still running). */
  busy: boolean;
  fetch: () => Promise<unknown>;
  listeners: Set<() => void>;
  /** Drops the entry once nobody has shown it for `IDLE_TTL_MS`. */
  expiry: ReturnType<typeof setTimeout> | null;
}

const LOADING: Polled<never> = Object.freeze({ data: null, error: null, loading: true });
const IDLE: Polled<never> = Object.freeze({ data: null, error: null, loading: false });
const entries = new Map<string, Entry>();
// Keys of the entries nobody shows, oldest first (a Set keeps insertion order).
const idle = new Set<string>();

function setEntryState(entry: Entry, state: Polled<unknown>): void {
  entry.state = state;
  for (const fn of entry.listeners) fn();
}

function load(entry: Entry): void {
  if (entry.busy) return;
  entry.busy = true;
  const seq = ++entry.seq;
  entry.fetchedAt = Date.now();
  const done = () => {
    entry.busy = false;
  };
  entry
    .fetch()
    .then(
      (data) => seq === entry.seq && setEntryState(entry, { data, error: null, loading: false }),
      (err: unknown) => seq === entry.seq && setEntryState(entry, { data: null, error: toApiError(err), loading: false }),
    )
    .finally(done);
}

function acquire(key: string, fetch: () => Promise<unknown>, interval: number): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      state: LOADING,
      refs: 0,
      timer: null,
      fetchedAt: 0,
      seq: 0,
      busy: false,
      fetch,
      listeners: new Set(),
      expiry: null,
    };
    entries.set(key, entry);
  }
  idle.delete(key);
  if (entry.expiry) clearTimeout(entry.expiry);
  entry.expiry = null;
  entry.fetch = fetch;
  entry.refs += 1;
  if (entry.refs === 1) {
    if (Date.now() - entry.fetchedAt >= interval || entry.state === LOADING) load(entry);
    const current = entry;
    entry.timer = setInterval(() => load(current), interval);
  }
  return entry;
}

function release(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entry.refs = 0;
    if (entry.timer) clearInterval(entry.timer);
    entry.timer = null;
    // Kept for a while, so a quick reopen shows the value at once; then forgotten (each object's details would
    // otherwise leave its charts behind for good, #120).
    idle.add(key);
    entry.expiry = setTimeout(() => drop(key), IDLE_TTL_MS);
    for (const oldest of idle) {
      if (idle.size <= MAX_IDLE_ENTRIES) break;
      drop(oldest);
    }
  }
}

function drop(key: string): void {
  const entry = entries.get(key);
  idle.delete(key);
  if (!entry || entry.refs > 0) return;
  if (entry.expiry) clearTimeout(entry.expiry);
  entry.expiry = null;
  // An answer still in flight is ignored.
  entry.seq += 1;
  entries.delete(key);
  pruneLatest();
}

// The latest usage of a cluster is kept only while a poller of it is (it sorts the open table's columns).
function pruneLatest(): void {
  const polled = (kind: string, clusterId: ClusterId) => {
    const prefix = `${kind}|${clusterId}|`;
    for (const key of entries.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };
  for (const clusterId of lastPods.keys()) if (!polled("pods", clusterId)) lastPods.delete(clusterId);
  for (const clusterId of lastNodes.keys()) if (!polled("nodes", clusterId)) lastNodes.delete(clusterId);
}

/** Shared, polled value of `fetch` under `key` (`null` key: nothing to fetch yet). */
export function usePolled<T>(key: string | null, fetch: () => Promise<T>, interval = POLL_INTERVAL_MS): Polled<T> {
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (key === null) return () => undefined;
      const entry = acquire(key, () => fetchRef.current(), interval);
      entry.listeners.add(notify);
      return () => {
        entry.listeners.delete(notify);
        release(key);
      };
    },
    [key, interval],
  );
  const snapshot = useCallback(() => (key === null ? IDLE : (entries.get(key)?.state ?? LOADING)), [key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot) as Polled<T>;
}

/** Stops every poller and forgets every value (tests). */
export function resetMetricsCache(): void {
  for (const entry of entries.values()) {
    if (entry.timer) clearInterval(entry.timer);
    if (entry.expiry) clearTimeout(entry.expiry);
  }
  entries.clear();
  idle.clear();
  lastPods.clear();
  lastNodes.clear();
}

/** How many values the metrics cache holds (tests): pollers, and the latest pod/node usage kept per cluster. */
export function metricsCacheStats(): { entries: number; podClusters: number; nodeClusters: number } {
  return { entries: entries.size, podClusters: lastPods.size, nodeClusters: lastNodes.size };
}

/** The cluster's metrics settings, `null` until the settings are loaded. */
export function useMetricsSettings(clusterId: ClusterId): ClusterSettings | null {
  const { settings, error } = useSettings();
  if (!settings && !error) return null;
  return clusterSettingsOf(settings, clusterId);
}

function settingsKey(settings: ClusterSettings): string {
  return JSON.stringify([settings.prometheus, settings.usageSource]);
}

/** What is available (metrics-server, Prometheus) and where current values come from. */
export function useMetricsStatus(clusterId: ClusterId): Polled<MetricsStatus> {
  const settings = useMetricsSettings(clusterId);
  const key = settings ? `status|${clusterId}|${settingsKey(settings)}` : null;
  return usePolled(key, () => api.metrics.status(clusterId));
}

// Latest values per cluster, for sorting table columns (a column's `value` gets only the object).
const lastPods = new Map<ClusterId, Map<string, PodUsage>>();
const lastNodes = new Map<ClusterId, Map<string, NodeUsage>>();

export function podKey(namespace: string | undefined, name: string | undefined): string {
  return `${namespace ?? ""}/${name ?? ""}`;
}

export function latestPodUsage(clusterId: ClusterId | null, key: string): PodUsage | undefined {
  return clusterId ? lastPods.get(clusterId)?.get(key) : undefined;
}

export function latestNodeUsage(clusterId: ClusterId | null, name: string): NodeUsage | undefined {
  return clusterId ? lastNodes.get(clusterId)?.get(name) : undefined;
}

/** Current usage of the pods in the selected namespaces, by `namespace/name` (`enabled` false: nothing is fetched). */
export function usePodUsage(clusterId: ClusterId, enabled = true): Polled<Map<string, PodUsage>> {
  const settings = useMetricsSettings(clusterId);
  const namespaces = useSelectedNamespaces(clusterId);
  const key =
    enabled && settings && namespaces !== undefined
      ? `pods|${clusterId}|${settingsKey(settings)}|${JSON.stringify(namespaces)}`
      : null;
  return usePolled(key, async () => {
    const list = await api.metrics.pods(clusterId, namespaces ?? null);
    const byKey = new Map(list.map((p) => [podKey(p.namespace, p.name), p]));
    if (key !== null && entries.has(key)) lastPods.set(clusterId, byKey);
    return byKey;
  });
}

/** Current usage of every node, by name. */
export function useNodeUsage(clusterId: ClusterId): Polled<Map<string, NodeUsage>> {
  const settings = useMetricsSettings(clusterId);
  const key = settings ? `nodes|${clusterId}|${settingsKey(settings)}` : null;
  return usePolled(key, async () => {
    const list = await api.metrics.nodes(clusterId);
    const byName = new Map(list.map((n) => [n.name, n]));
    if (key !== null && entries.has(key)) lastNodes.set(clusterId, byName);
    return byName;
  });
}

/** Last hour of `target` from Prometheus (`null` target or `enabled` false: nothing is fetched). */
export function useCharts(clusterId: ClusterId, target: ChartTarget | null, enabled: boolean): Polled<Series[]> {
  const settings = useMetricsSettings(clusterId);
  const key =
    settings && target && enabled ? `charts|${clusterId}|${settingsKey(settings)}|${JSON.stringify(target)}` : null;
  return usePolled(key, () => api.metrics.charts(clusterId, target!, CHART_RANGE_SECS), POLL_INTERVAL_MS * 2);
}
