// React side of the problem sources: watch the categories a component shows while it is mounted, read their problems,
// and a clock that moves so grace periods and past restarts change what counts without a new update.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSettings, type ClusterId } from "../../api";
import { useClusterKinds } from "../../resources";
import { useClustersStore } from "../clusters/clustersStore";
import { isActive, isOptIn, NOTIFY_CATEGORIES, OPT_IN_CATEGORIES, type Problem, type ProblemCategory } from "./model";
import { extensionSourcesFor, requestScopes, useExtensionCategories, useExtensionProblemsVersion } from "./extensionCategories";
import { needsDiscovery, sourceKey, sourcesFor } from "./sources";
import {
  acquireSource,
  applyCertExpiryDays,
  epochOf,
  getSource,
  sourcesVersion,
  subscribeSources,
  type SourceState,
} from "./store";

/** How often time-based problems (grace periods, past restarts, certificate expiry) are looked at again. */
export const TICK_MS = 30_000;

/** The current time, moving every `intervalMs`. */
export function useNow(intervalMs = TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Watches `categories` of the cluster while mounted (shared with every other user of the same kinds) and returns their
 * sources. A tool's kinds are watched once discovery says the cluster serves them; `null` watches nothing.
 */
export function useProblemSources(clusterId: ClusterId | null, categories: readonly ProblemCategory[]): SourceState[] {
  const discovery = useClusterKinds(clusterId && needsDiscovery(categories) ? clusterId : null);
  const kinds = discovery.kinds ?? (discovery.error ? null : undefined);
  // Extensions' categories: their rules and where they run in this cluster (asked from Rust once per extension).
  const extensions = useExtensionProblemsVersion();
  useEffect(() => {
    if (clusterId) requestScopes(clusterId, categories);
  }, [clusterId, categories, extensions]);
  const defs = useMemo(
    () => {
      void extensions;
      return clusterId ? [...sourcesFor(categories, kinds), ...extensionSourcesFor(categories, clusterId, kinds)] : [];
    },
    [clusterId, categories, kinds, extensions],
  );
  const keys = JSON.stringify(defs.map((d) => sourceKey(clusterId ?? "", d)));
  const version = useSyncExternalStore(subscribeSources, sourcesVersion, sourcesVersion);
  // A new connection (or its loss) dropped the cluster's sources: acquire them again.
  const epoch = clusterId ? epochOf(clusterId) : 0;
  // Nothing is watched while the cluster is known not to be connected (its watches would only fail).
  const offline = useClustersStore((s) => {
    const state = clusterId ? s.states[clusterId]?.state : undefined;
    return state !== undefined && state !== "connected";
  });

  // The expiry warning setting decides when a certificate counts as expiring; a change moves held problems at once.
  const certExpiryDays = useSettings().settings?.notifications.certExpiryDays;
  useEffect(() => {
    if (certExpiryDays !== undefined) applyCertExpiryDays(certExpiryDays);
  }, [certExpiryDays]);

  useEffect(() => {
    if (!clusterId || offline) return;
    const releases = defs.map((def) => acquireSource(clusterId, def));
    return () => {
      for (const release of releases) release();
    };
    // `keys` stands for `defs`: the same kinds keep the same watches.
  }, [clusterId, keys, epoch, offline]);

  return useMemo(
    () => {
      void version;
      return (JSON.parse(keys) as string[]).map((key) => getSource(key)).filter((s): s is SourceState => s !== undefined);
    },
    [keys, version],
  );
}

export interface ClusterProblems {
  sources: SourceState[];
  /** The problems that count now. */
  active: Problem[];
  /** A source has not listed its kind yet. */
  loading: boolean;
}

/** The problems of `categories` in the cluster that count at `now`. */
export function activeProblems(sources: readonly SourceState[], now: number): Problem[] {
  const out: Problem[] = [];
  for (const source of sources) for (const p of source.problems) if (isActive(p, now)) out.push(p);
  return out;
}

export function useClusterProblems(clusterId: ClusterId | null, categories: readonly ProblemCategory[]): ClusterProblems {
  const sources = useProblemSources(clusterId, categories);
  // The tick only makes it look again as time passes; what counts is judged at the time of the look.
  const tick = useNow();
  return useMemo(
    () => {
      void tick;
      return {
        sources,
        active: activeProblems(sources, Date.now()),
        loading: sources.some((s) => s.status === "loading"),
      };
    },
    [sources, tick],
  );
}

/**
 * The sidebar badge (`registerSectionBadge`): the problems that need attention — those that would notify (crash loops,
 * failed Jobs, nodes not ready, …), not a pod still pending, a container that restarted once or a Warning event, which
 * the page lists too. The same rule as the notifications, so the badge and the notifications agree.
 */
export function useProblemCount(clusterId: ClusterId): number {
  const extensions = useExtensionCategories();
  const categories = useMemo((): readonly ProblemCategory[] => [...NOTIFY_CATEGORIES, ...extensions], [extensions]);
  return useClusterProblems(clusterId, useCategoriesOn(categories)).active.filter((p) => p.notify).length;
}

const EMPTY: readonly string[] = [];

/**
 * `categories` without the opt-in ones that are off (`notifications.enabledCategories`): the one setting the problems
 * screen, the sidebar counter and the notifications follow. The same list (by value) until the setting changes.
 */
export function useCategoriesOn(categories: readonly ProblemCategory[]): readonly ProblemCategory[] {
  const optedIn = useSettings().settings?.notifications.enabledCategories ?? EMPTY;
  const key = `${categories.join(",")}#${OPT_IN_CATEGORIES.filter((c) => optedIn.includes(c)).join(",")}`;
  return useMemo(
    () => {
      const on = key.split("#")[1]!.split(",");
      return categories.filter((c) => !isOptIn(c) || on.includes(c));
    },
    // `key` stands for both lists by value.
    [key],
  );
}
