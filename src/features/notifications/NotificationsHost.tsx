// Draws nothing: while notifications are on, watches the enabled categories of every connected cluster that is not
// muted (a cluster is never connected for notifications) and hands each source to the notifier. Mounted once, in the
// rail footer slot; a remount (narrow ↔ wide layout) reuses the watches (`LINGER_MS`).
import { useEffect, useMemo, useRef } from "react";
import { useSettings, type ClusterId } from "../../api";
import { displayNameOf } from "../clusters/clusterSettings";
import { useClustersStore } from "../clusters/clustersStore";
import { useNow, useProblemSources } from "../problems/hooks";
import type { ProblemCategory } from "../problems/model";
import { notifier, setClusterNames, wireNotificationActions } from "./notifier";
import { enabledCategories, prefsOf } from "./prefs";

export function NotificationsHost() {
  const { settings } = useSettings();
  const states = useClustersStore((s) => s.states);
  const clusters = useClustersStore((s) => s.clusters);
  const prefs = useMemo(() => prefsOf(settings), [settings]);

  useEffect(() => {
    notifier.setPrefs(prefs);
  }, [prefs]);
  useEffect(() => {
    setClusterNames((id) => {
      const cluster = clusters.find((c) => c.id === id);
      return cluster ? displayNameOf(cluster, settings) : id;
    });
  }, [clusters, settings]);

  const on = prefs?.enabled === true;
  useEffect(() => {
    if (on) void wireNotificationActions();
  }, [on]);

  const categoriesKey = prefs ? enabledCategories(prefs).join(",") : "";
  const categories = useMemo(
    () => (categoriesKey ? (categoriesKey.split(",") as ProblemCategory[]) : []),
    [categoriesKey],
  );
  if (!prefs || !on || categories.length === 0) return null;
  const watched = Object.entries(states)
    .filter(([id, state]) => state.state === "connected" && !prefs.mutedClusters.has(id))
    .map(([id]) => id);
  return (
    <>
      {watched.map((id) => (
        <ClusterNotifier key={id} clusterId={id} categories={categories} />
      ))}
    </>
  );
}

function ClusterNotifier({ clusterId, categories }: { clusterId: ClusterId; categories: readonly ProblemCategory[] }) {
  const sources = useProblemSources(clusterId, categories);
  const now = useNow();
  const looked = useRef(new Set<string>());

  useEffect(() => {
    const keys = new Set(sources.map((s) => s.key));
    for (const key of looked.current) if (!keys.has(key)) notifier.forget(key);
    looked.current = keys;
    // `now` only makes it look again as time passes (grace periods end); the engine reads its own clock.
    void now;
    for (const source of sources) notifier.observe(source);
  }, [sources, now]);

  useEffect(() => {
    const seen = looked;
    return () => {
      for (const key of seen.current) notifier.forget(key);
      seen.current = new Set();
    };
  }, []);
  return null;
}
