// Only unsaved edits live here. Saved filters are always read from the shared settings cache, so imports and
// backend settings reloads take effect immediately and visiting a table does not retain another copy of it.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { getSettingsSnapshot, loadSettings, subscribeSettings, updateSettings } from "../../api";
import type { TableFilters } from "../../api/generated/TableFilters";
import { clusterSettingsOf } from "../clusters/clusterSettings";
import { EMPTY_TABLE_FILTERS } from "./model";
import { FILTER_LIMITS, readTableFilterMap, TableFilterLimitError } from "./validation";

type FilterChange = TableFilters | ((current: TableFilters) => TableFilters);
interface Edit {
  clusterId: string;
  viewId: string;
  filters: TableFilters;
  error: unknown | null;
  dirty: boolean;
  pending: number;
}
interface Snapshot { filters: TableFilters; error: unknown | null }

const edits = new Map<string, Edit>();
const listeners = new Set<() => void>();
let epoch = 0;
let loading: Promise<void> | null = null;
let loadError: unknown | null = null;
const keyOf = (clusterId: string, viewId: string) => JSON.stringify([clusterId, viewId]);
const pathOf = (clusterId: string) => `$.clusters.${clusterId}.tableFilters`;
const isEmpty = (filters: TableFilters) => !Object.keys(filters.columns).length && filters.advanced === null;
const signatureOf = (filters: TableFilters) => JSON.stringify([
  Object.keys(filters.columns).sort().map((key) => [key, filters.columns[key]]), filters.advanced,
]);
const notify = () => { for (const listener of listeners) listener(); };

function ensureLoaded(): Promise<void> {
  if (getSettingsSnapshot()) return Promise.resolve();
  if (!loading) {
    const started = epoch;
    const pending = loadSettings().then(
      () => { if (started === epoch) loadError = null; },
      (error: unknown) => { if (started === epoch) loadError = error; throw error; },
    ).finally(() => {
      if (loading === pending) { loading = null; notify(); }
    });
    loading = pending;
  }
  return loading;
}

/** Synchronous optimistic state, independent of the transient open table in ClusterView. Never starts a load. */
export function getTableFilters(clusterId: string, viewId: string): TableFilters {
  const edit = edits.get(keyOf(clusterId, viewId));
  return (edit?.dirty ? edit.filters : getSettingsSnapshot()?.clusters[clusterId]?.tableFilters?.[viewId]) ?? EMPTY_TABLE_FILTERS;
}

/** Saves captured edits through the common serialized settings queue, preserving every unrelated setting. */
export async function setTableFilters(clusterId: string, viewId: string, next: FilterChange): Promise<void> {
  const key = keyOf(clusterId, viewId);
  // Plain values are copied before any await. Updaters need the loaded settings and latest optimistic edit.
  const change = typeof next === "function" ? next : readTableFilterMap({ [viewId]: next }, pathOf(clusterId))[viewId]!;
  if (!getSettingsSnapshot()) await ensureLoaded();
  const filters = typeof change === "function"
    ? readTableFilterMap({ [viewId]: change(getTableFilters(clusterId, viewId)) }, pathOf(clusterId))[viewId]!
    : change;
  const clearing = isEmpty(filters);
  const persisted = getSettingsSnapshot()?.clusters[clusterId]?.tableFilters ?? {};
  const previous = edits.get(key);
  // Discard an idle unsaved filter locally. An in-flight write still needs a queued removal, or its result
  // could bring the filter back after this clear. Failed siblings never take part in clearing this table.
  if (clearing && !Object.hasOwn(persisted, viewId) && !previous?.pending) {
    if (previous) { previous.dirty = false; edits.delete(key); notify(); }
    return;
  }
  if (!clearing) {
    const occupied = new Set(Object.keys(persisted));
    for (const edit of edits.values()) if (edit.clusterId === clusterId && edit.dirty) occupied.add(edit.viewId);
    occupied.add(viewId);
    if (occupied.size > FILTER_LIMITS.tables) throw new TableFilterLimitError(`${pathOf(clusterId)}: too many tables`);
  }
  const edit: Edit = { clusterId, viewId, filters, error: null, dirty: true, pending: 0 };
  edits.set(key, edit);
  notify();
  // Include earlier failed edits of this cluster, but never read newer clicks inside the lazy callback.
  const captured = clearing ? [edit] : [...edits.values()].filter((edit) => edit.clusterId === clusterId && edit.dirty);
  for (const edit of captured) edit.pending++;
  const started = epoch;
  let capacityError: Error | null = null;
  try {
    await updateSettings((settings) => {
      const cluster = clusterSettingsOf(settings, clusterId);
      const tableFilters = { ...cluster.tableFilters };
      for (const edit of captured) {
        // Another queued filter write may already have stored this captured edit. Do not replay it over an
        // import or backend reload that ran since that write; only unsaved snapshots need retrying.
        if (!edit.dirty) continue;
        if (isEmpty(edit.filters)) delete tableFilters[edit.viewId];
        else tableFilters[edit.viewId] = edit.filters;
      }
      if (Object.keys(tableFilters).length > FILTER_LIMITS.tables) {
        capacityError = new TableFilterLimitError(`${pathOf(clusterId)}: too many tables`);
        throw capacityError;
      }
      return { ...settings, clusters: { ...settings.clusters, [clusterId]: { ...cluster, tableFilters } } };
    });
    if (started !== epoch) return;
    for (const edit of captured) {
      edit.dirty = false;
      const key = keyOf(edit.clusterId, edit.viewId);
      if (edits.get(key) === edit) edits.delete(key);
    }
  } catch (error) {
    if (started === epoch) {
      // A queued import can fill the map after the optimistic preflight. This is a rejected edit, not an I/O
      // failure: retain an earlier failed valid value if any, but never add a new over-cap session record.
      if (error === capacityError) {
        if (edits.get(key) === edit) {
          if (previous?.dirty) edits.set(key, previous);
          else edits.delete(key);
        }
      } else for (const edit of captured) {
        if (edits.get(keyOf(edit.clusterId, edit.viewId)) === edit) edit.error = error;
      }
    }
    throw error;
  } finally {
    for (const edit of captured) edit.pending--;
    if (started === epoch) notify();
  }
}

/** Current filters and an explicit session-only save error. Disabled tables neither subscribe nor load settings. */
export function useTableFilters(clusterId: string, viewId: string, enabled = true): {
  filters: TableFilters;
  error: unknown | null;
  setFilters: (next: FilterChange) => Promise<void>;
} {
  const subscribe = useCallback((listener: () => void) => {
    if (!enabled) return () => {};
    listeners.add(listener);
    const unsubscribe = subscribeSettings(listener);
    return () => { listeners.delete(listener); unsubscribe(); };
  }, [enabled]);
  const getSnapshot = useMemo(() => {
    let source: TableFilters | undefined;
    let serialized = "";
    let snapshot: Snapshot | undefined;
    return (): Snapshot => {
      const filters = enabled ? getTableFilters(clusterId, viewId) : EMPTY_TABLE_FILTERS;
      const error = enabled ? edits.get(keyOf(clusterId, viewId))?.error ?? (getSettingsSnapshot() ? null : loadError) : null;
      if (snapshot && source === filters && snapshot.error === error) return snapshot;
      const signature = source === filters ? serialized : signatureOf(filters);
      // Settings are reserialized on every write; equal filters keep their identity for the mounted predicate.
      if (!snapshot || signature !== serialized) snapshot = { filters, error };
      else if (snapshot.error !== error) snapshot = { filters: snapshot.filters, error };
      source = filters;
      serialized = signature;
      return snapshot;
    };
  }, [clusterId, viewId, enabled]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    if (enabled) void ensureLoaded().catch(() => {});
  }, [clusterId, viewId, enabled]);
  const setFilters = useCallback((next: FilterChange) => setTableFilters(clusterId, viewId, next), [clusterId, viewId]);
  return { ...snapshot, setFilters };
}

/** Forgets only session state (tests/restart); persisted filters stay in the settings cache. */
export function resetTableFiltersState(): void {
  epoch++;
  edits.clear();
  loading = null;
  loadError = null;
  notify();
}
