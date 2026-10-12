// Settings cache shared by every `useSettings()` caller. Updates are serialized so concurrent callers never
// overwrite each other's changes.
import { useEffect, useSyncExternalStore } from "react";
import { ApiError, toApiError } from "./errors";
import type { AppSettings } from "./generated/AppSettings";
import { call } from "./transport";

/** Same defaults as `AppSettings::default()` in Rust. */
export function defaultAppSettings(): AppSettings {
  return {
    theme: "system",
    language: "en",
    kubeconfigSources: [],
    clusters: {},
    window: {
      sidebarWidth: 220,
      dockHeight: 300,
      dockOpen: false,
      lastCluster: null,
      width: null,
      height: null,
      maximized: false,
    },
    helmPath: null,
    editorTheme: "auto",
  };
}

export interface SettingsState {
  settings: AppSettings | null;
  loading: boolean;
  error: ApiError | null;
}

let state: SettingsState = { settings: null, loading: false, error: null };
let loadStarted = false;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function setState(next: Partial<SettingsState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

function ensureLoaded(): void {
  if (loadStarted) return;
  loadStarted = true;
  setState({ loading: true });
  call<AppSettings>("settings_get").then(
    (settings) => setState({ settings, loading: false, error: null }),
    (err: unknown) => setState({ loading: false, error: toApiError(err) }),
  );
}

/** Loads settings once (later calls return the cached copy). */
export async function loadSettings(): Promise<AppSettings> {
  if (state.settings) return state.settings;
  const settings = await call<AppSettings>("settings_get");
  setState({ settings, error: null });
  return settings;
}

/**
 * Applies `change` to the latest settings and saves them through `settings_update`.
 * Resolves to what the backend stored.
 */
export function updateSettings(change: (current: AppSettings) => AppSettings): Promise<AppSettings> {
  const run = async () => {
    const current = state.settings ?? (await loadSettings());
    const saved = await call<AppSettings>("settings_update", { settings: change(current) });
    setState({ settings: saved, error: null });
    return saved;
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

export function resetSettingsCache(): void {
  state = { settings: null, loading: false, error: null };
  loadStarted = false;
  queue = Promise.resolve();
  for (const fn of listeners) fn();
}

function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): SettingsState {
  return state;
}

export interface UseSettings extends SettingsState {
  update: (change: (current: AppSettings) => AppSettings) => Promise<AppSettings>;
}

/** Current application settings (loaded on first use) and a serialized `update`. */
export function useSettings(): UseSettings {
  const snapshot = useSyncExternalStore(subscribeSettings, getSnapshot, getSnapshot);
  useEffect(ensureLoaded, []);
  return { ...snapshot, update: updateSettings };
}
