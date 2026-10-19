// State the comparison views share: the connected clusters (never connected implicitly) and the saved ignore paths
// of a kind (`AppSettings.compare.ignorePaths`, frontend-written).
import { useCallback, useEffect, useMemo, useState } from "react";
import { toApiError, useSettings, type ApiError, type ClusterId, type ClusterInfo, type KindRef } from "../../api";
import { displayNameOf } from "../clusters/clusterSettings";
import { useClustersStore } from "../clusters/clustersStore";
import { useClusters } from "../clusters/hooks";
import { kindKey } from "../../resources/refs";
import { cleanIgnorePaths, MAX_IGNORE_PATHS } from "./paths";

export interface ClusterChoice {
  id: ClusterId;
  label: string;
  connected: boolean;
}

/** Every cluster of the kubeconfig with its shown name, connected ones first (each group in kubeconfig order). */
export function useClusterChoices(): ClusterChoice[] {
  const { clusters } = useClusters();
  const states = useClustersStore((s) => s.states);
  const { settings } = useSettings();
  return useMemo(() => {
    const choices = clusters.map((c: ClusterInfo) => ({
      id: c.id,
      label: displayNameOf(c, settings),
      connected: states[c.id]?.state === "connected",
    }));
    return [...choices.filter((c) => c.connected), ...choices.filter((c) => !c.connected)];
  }, [clusters, states, settings]);
}

export interface IgnorePaths {
  paths: string[];
  add: (path: string) => void;
  remove: (path: string) => void;
  error: ApiError | null;
}

/** The saved ignore paths of `kind`, and changing them (saved at once). */
export function useIgnorePaths(kind: Pick<KindRef, "group" | "kind">): IgnorePaths {
  const { settings, update } = useSettings();
  const key = kindKey(kind);
  const [error, setError] = useState<ApiError | null>(null);
  const paths = useMemo(() => cleanIgnorePaths(settings?.compare?.ignorePaths?.[key]), [settings, key]);
  const save = useCallback(
    (change: (current: string[]) => string[]) => {
      setError(null);
      update((current) => {
        const all = { ...(current.compare?.ignorePaths ?? {}) };
        const next = cleanIgnorePaths(change(cleanIgnorePaths(all[key])));
        if (next.length > 0) all[key] = next;
        else delete all[key];
        return { ...current, compare: { ...current.compare, ignorePaths: all } };
      }).catch((err: unknown) => setError(toApiError(err)));
    },
    [update, key],
  );
  const add = useCallback(
    (path: string) => save((current) => (current.length >= MAX_IGNORE_PATHS ? current : [...current, path.trim()])),
    [save],
  );
  const remove = useCallback((path: string) => save((current) => current.filter((p) => p !== path)), [save]);
  return { paths, add, remove, error };
}

/** The saved ignore paths of every kind (read only). */
export function useAllIgnorePaths(): Record<string, string[]> {
  const { settings } = useSettings();
  return useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [key, paths] of Object.entries(settings?.compare?.ignorePaths ?? {})) out[key] = cleanIgnorePaths(paths);
    return out;
  }, [settings]);
}

export interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
}

/** Runs `load` whenever `key` changes (nothing while `key` is `null`); a late answer for an older key is dropped. */
export function useLoaded<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<Loaded<T> & { key: string | null }>({ data: null, error: null, loading: false, key: null });
  useEffect(() => {
    if (key === null) return;
    let live = true;
    setState({ data: null, error: null, loading: true, key });
    load().then(
      (data) => live && setState({ data, error: null, loading: false, key }),
      (err: unknown) => live && setState({ data: null, error: toApiError(err), loading: false, key }),
    );
    return () => {
      live = false;
    };
    // `load` is a fresh closure on every render; `key` says when it asks for something else.
  }, [key]);
  if (key === null || state.key !== key) return { data: null, error: null, loading: key !== null };
  return state;
}
