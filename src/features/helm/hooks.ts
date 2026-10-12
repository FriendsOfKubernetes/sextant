// Hooks of the Helm pages. Releases are read natively by the backend; the list refreshes whenever a release Secret
// (`sh.helm.release.v1.*`, label owner=helm) changes in the watched namespaces — the watch carries only the Secrets'
// metadata, never the stored releases.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api, toApiError, useWatch, type ApiError, type ClusterId, type HelmRelease, type HelmStatus, type WatchSpec } from "../../api";

// ---------- helm status (shared by every page; checked again whenever a Helm page opens, the window gets focus
// or `refreshHelmStatus` is called — Helm installed while the app runs is picked up) ----------

let status: HelmStatus | null = null;
let pending: Promise<void> | null = null;
const statusListeners = new Set<() => void>();

function loadStatus(): void {
  if (pending) return;
  pending = api.helm
    .status()
    .catch((): HelmStatus => ({ available: false, version: null, path: null }))
    .then((s) => {
      status = s;
      for (const fn of statusListeners) fn();
    })
    .finally(() => {
      pending = null;
    });
}

/** Whether `helm` is installed: `null` while checking. */
export function useHelmStatus(): HelmStatus | null {
  const value = useSyncExternalStore(
    (fn) => {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    () => status,
    () => status,
  );
  useEffect(() => {
    // The last answer stays on screen while the new one comes.
    loadStatus();
    const onFocus = () => loadStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return value;
}

/** Checks for `helm` again. */
export function refreshHelmStatus(): void {
  status = null;
  for (const fn of statusListeners) fn();
  loadStatus();
}

/** Forgets the cached status (tests). */
export function resetHelmStatus(): void {
  status = null;
  pending = null;
}

// ---------- releases ----------

export const RELEASE_SECRET_KIND = { group: "", version: "v1", kind: "Secret" } as const;

/** The watch that tells when releases change: the metadata of the release Secrets of the selected namespaces. */
export function releaseSecretsSpec(namespaces: string[] | null): WatchSpec {
  return {
    kind: { ...RELEASE_SECRET_KIND },
    namespaces,
    labelSelector: "owner=helm",
    fieldSelector: "type=helm.sh/release.v1",
    metadataOnly: true,
  };
}

export interface ReleasesState {
  releases: HelmRelease[];
  loading: boolean;
  error: ApiError | null;
  refresh: () => void;
}

/** Latest revision of every release in `namespaces` (`null` = all), refreshed on every change of their Secrets. */
export function useHelmReleases(clusterId: ClusterId, namespaces: string[] | null | undefined): ReleasesState {
  const nsKey = namespaces === undefined ? null : JSON.stringify(namespaces);
  const spec = useMemo(() => (nsKey === null ? null : releaseSecretsSpec(JSON.parse(nsKey) as string[] | null)), [nsKey]);
  const watch = useWatch(clusterId, spec);
  // Changes of the Secrets (a new revision, an uninstall) as a key: uid and resourceVersion of each.
  const secretsKey = useMemo(
    () =>
      [...watch.items.values()]
        .map((s) => `${s.metadata?.uid ?? ""}@${s.metadata?.resourceVersion ?? ""}`)
        .sort()
        .join(","),
    [watch.items],
  );
  const [state, setState] = useState<{ releases: HelmRelease[]; loading: boolean; error: ApiError | null }>({
    releases: [],
    loading: true,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (nsKey === null) return;
    let alive = true;
    const ns = JSON.parse(nsKey) as string[] | null;
    api.helm
      .releases(clusterId, ns)
      .then((releases) => {
        if (alive) setState({ releases, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (alive) setState((s) => ({ releases: s.releases, loading: false, error: toApiError(err) }));
      });
    return () => {
      alive = false;
    };
  }, [clusterId, nsKey, secretsKey, tick]);

  return { ...state, refresh };
}

// ---------- small async loader ----------

export interface Loaded<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

/** Runs `load` when `key` changes (or on `reload`); `null` key loads nothing. */
export function useLoad<T>(key: string | null, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; data: T | null; loading: boolean; error: ApiError | null }>({
    key: null,
    data: null,
    loading: false,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    setState((s) => ({ key, data: s.key === key ? s.data : null, loading: true, error: null }));
    load()
      .then((data) => {
        if (alive) setState({ key, data, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (alive) setState({ key, data: null, loading: false, error: toApiError(err) });
      });
    return () => {
      alive = false;
    };
    // `load` is a fresh closure every render; `key` says when it means something new.
  }, [key, tick]);
  const current = state.key === key;
  return {
    data: current ? state.data : null,
    loading: key !== null && (!current || state.loading),
    error: current ? state.error : null,
    reload,
  };
}
