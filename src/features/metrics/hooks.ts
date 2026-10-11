// Hooks of the metrics feature. Every value is fetched by one shared poller per key (cluster + metrics settings +
// what is asked), refreshed every 30 seconds while at least one component uses it and stopped when the last one
// unmounts — so a table with a thousand CPU cells makes one `metrics_pods` call, and only while the table is open.
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
  fetch: () => Promise<unknown>;
  listeners: Set<() => void>;
}

const LOADING: Polled<never> = Object.freeze({ data: null, error: null, loading: true });
const IDLE: Polled<never> = Object.freeze({ data: null, error: null, loading: false });
const entries = new Map<string, Entry>();

function setEntryState(entry: Entry, state: Polled<unknown>): void {
  entry.state = state;
  for (const fn of entry.listeners) fn();
}

function load(entry: Entry): void {
  const seq = ++entry.seq;
  entry.fetchedAt = Date.now();
  entry.fetch().then(
    (data) => seq === entry.seq && setEntryState(entry, { data, error: null, loading: false }),
    (err: unknown) => seq === entry.seq && setEntryState(entry, { data: null, error: toApiError(err), loading: false }),
  );
}

function acquire(key: string, fetch: () => Promise<unknown>, interval: number): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { state: LOADING, refs: 0, timer: null, fetchedAt: 0, seq: 0, fetch, listeners: new Set() };
    entries.set(key, entry);
  }
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
  }
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
  for (const entry of entries.values()) if (entry.timer) clearInterval(entry.timer);
  entries.clear();
  lastPods.clear();
  lastNodes.clear();
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

/** Current usage of the pods in the selected namespaces, by `namespace/name`. */
export function usePodUsage(clusterId: ClusterId): Polled<Map<string, PodUsage>> {
  const settings = useMetricsSettings(clusterId);
  const namespaces = useSelectedNamespaces(clusterId);
  const key =
    settings && namespaces !== undefined
      ? `pods|${clusterId}|${settingsKey(settings)}|${JSON.stringify(namespaces)}`
      : null;
  return usePolled(key, async () => {
    const list = await api.metrics.pods(clusterId, namespaces ?? null);
    const byKey = new Map(list.map((p) => [podKey(p.namespace, p.name), p]));
    lastPods.set(clusterId, byKey);
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
    lastNodes.set(clusterId, byName);
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
