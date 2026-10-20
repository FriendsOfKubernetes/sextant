// Newer chart versions of the listed releases (#209). Asked of the backend only while the Releases page is open (this
// hook runs nowhere else, and there is no timer): the backend reads Helm's local copies of the repository indexes.
// Answers are kept per cluster for an hour; Refresh asks again, and "Update repositories" (the only path to
// `helm repo update`) downloads the indexes first, on the user's click. A cluster's answers are dropped whenever its
// connection comes or goes (a reconnect may reach other releases), like the problem and map stores drop their watches.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  toApiError,
  type ApiError,
  type ChartUpdate,
  type ClusterId,
  type HelmRelease,
  type InstalledChart,
  type RepoProblem,
} from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import { chartKey } from "./revisionModel";

/** How long an answer is reused before the page asks again (when it is open). */
export const CHART_UPDATES_TTL_MS = 60 * 60 * 1000;

interface Entry {
  /** When the whole set was last asked. */
  at: number;
  byKey: Map<string, ChartUpdate>;
  repos: number;
  problems: RepoProblem[];
  skipped: number;
}

const cache = new Map<ClusterId, Entry>();
/** Per cluster: bumped whenever its connection comes or goes (its kept answer is dropped then). */
const epochs = new Map<ClusterId, number>();
/** Per cluster: connected when last looked at. */
const connected = new Map<ClusterId, boolean>();
const listeners = new Set<() => void>();
let unfollow: (() => void) | undefined;

function followConnections(): void {
  if (unfollow) return;
  const look = (states: ReturnType<typeof useClustersStore.getState>["states"]) => {
    for (const id of new Set([...Object.keys(states), ...connected.keys()])) {
      const now = states[id]?.state === "connected";
      const was = connected.get(id);
      connected.set(id, now);
      if (was === undefined || was === now) continue;
      cache.delete(id);
      epochs.set(id, (epochs.get(id) ?? 0) + 1);
      for (const fn of [...listeners]) fn();
    }
  };
  look(useClustersStore.getState().states);
  unfollow = useClustersStore.subscribe((s, prev) => {
    if (s.states !== prev.states) look(s.states);
  });
}

/** Forgets every kept answer and the connections seen (tests). */
export function resetChartUpdates(): void {
  cache.clear();
  epochs.clear();
  connected.clear();
  unfollow?.();
  unfollow = undefined;
}

export interface ChartUpdatesState {
  /** By `chartKey(chart, version)`. */
  updates: ReadonlyMap<string, ChartUpdate>;
  /** How many repositories Helm has; `null` before the first answer. */
  repos: number | null;
  problems: RepoProblem[];
  skipped: number;
  loading: boolean;
  error: ApiError | null;
  updatingRepos: boolean;
  /** Asks again, ignoring the kept answer. */
  refresh: () => void;
  /** `helm repo update`, then asks again. */
  updateRepos: () => void;
}

function chartsOf(releases: readonly HelmRelease[]): InstalledChart[] {
  const seen = new Map<string, InstalledChart>();
  for (const r of releases) {
    if (r.unreadable || r.chart === "") continue;
    seen.set(chartKey(r.chart, r.chartVersion), { chart: r.chart, version: r.chartVersion });
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, c]) => c);
}

/** Newer chart versions for `releases` of `clusterId`; nothing is asked while `enabled` is false (no `helm`). */
export function useChartUpdates(clusterId: ClusterId, releases: readonly HelmRelease[], enabled: boolean): ChartUpdatesState {
  const charts = useMemo(() => chartsOf(releases), [releases]);
  const chartsKey = useMemo(() => charts.map((c) => chartKey(c.chart, c.version)).join("\n"), [charts]);
  const [view, setView] = useState<{ entry: Entry | null; loading: boolean; error: ApiError | null }>(() => ({
    entry: cache.get(clusterId) ?? null,
    loading: false,
    error: null,
  }));
  const [force, setForce] = useState(0);
  /** The last Refresh acted on: a later one asks again for every chart. */
  const handled = useRef(0);
  const [updatingRepos, setUpdatingRepos] = useState(false);
  const refresh = useCallback(() => setForce((n) => n + 1), []);
  // The connection's epoch: a new one means the kept answer was dropped and the charts are asked again.
  const [epoch, setEpoch] = useState(() => epochs.get(clusterId) ?? 0);
  useEffect(() => {
    followConnections();
    const look = () => setEpoch(epochs.get(clusterId) ?? 0);
    listeners.add(look);
    look();
    return () => {
      listeners.delete(look);
    };
  }, [clusterId]);

  useEffect(() => {
    if (!enabled || charts.length === 0) {
      setView({ entry: cache.get(clusterId) ?? null, loading: false, error: null });
      return;
    }
    const kept = cache.get(clusterId);
    const forced = force !== handled.current;
    handled.current = force;
    const fresh = kept !== undefined && Date.now() - kept.at < CHART_UPDATES_TTL_MS && !forced;
    const missing = fresh ? charts.filter((c) => !kept.byKey.has(chartKey(c.chart, c.version))) : charts;
    if (missing.length === 0) {
      setView({ entry: kept ?? null, loading: false, error: null });
      return;
    }
    let alive = true;
    const askedIn = epochs.get(clusterId) ?? 0;
    setView((v) => ({ entry: v.entry, loading: true, error: null }));
    api.helm
      .chartUpdates(missing)
      .then((report) => {
        const base = fresh && kept ? kept : null;
        const byKey = new Map(base?.byKey ?? []);
        for (const u of report.charts) byKey.set(chartKey(u.chart, u.version), u);
        const entry: Entry = {
          at: base?.at ?? Date.now(),
          byKey,
          repos: report.repos,
          problems: report.repoProblems,
          skipped: report.skipped,
        };
        // An answer asked before the connection changed belongs to the old one: shown at most, never kept.
        if ((epochs.get(clusterId) ?? 0) === askedIn) cache.set(clusterId, entry);
        if (alive) setView({ entry, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (alive) setView((v) => ({ entry: v.entry, loading: false, error: toApiError(err) }));
      });
    return () => {
      alive = false;
    };
    // `charts` changes with `chartsKey`; `epoch` is read through the cache it emptied.
  }, [clusterId, chartsKey, enabled, force, epoch]);

  const updateRepos = useCallback(() => {
    setUpdatingRepos(true);
    api.helm
      .repoUpdate()
      .then(() => setForce((n) => n + 1))
      .catch((err: unknown) => setView((v) => ({ ...v, error: toApiError(err) })))
      .finally(() => setUpdatingRepos(false));
  }, []);

  const entry = view.entry;
  return {
    updates: entry?.byKey ?? new Map(),
    repos: entry?.repos ?? null,
    problems: entry?.problems ?? [],
    skipped: entry?.skipped ?? 0,
    loading: view.loading,
    error: view.error,
    updatingRepos,
    refresh,
    updateRepos,
  };
}
