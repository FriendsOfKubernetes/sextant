// State of the in-app updater, shared by the check at start (`UpdateNotice`) and Settings (`UpdatesPanel`):
// one check or installation at a time, and the update found stays offered until the app restarts.
import { useEffect, useSyncExternalStore } from "react";
import {
  api,
  toApiError,
  type ApiError,
  type AppInfo,
  type AvailableUpdate,
  type BundleKind,
  type DownloadProgress,
} from "../../api";

export type UpdatePhase = "idle" | "checking" | "upToDate" | "available" | "installing" | "restarting" | "error";

/** What went wrong, for a message the user can act on (`updates:error.<kind>`). */
export type UpdateErrorKind = "network" | "noRelease" | "signature" | "other";

export interface UpdateFailure {
  kind: UpdateErrorKind;
  /** During the check or the installation of an update that was found. */
  during: "check" | "install";
  error: ApiError;
}

export interface UpdatesState {
  phase: UpdatePhase;
  update: AvailableUpdate | null;
  failure: UpdateFailure | null;
  progress: DownloadProgress | null;
  /** The dialog that offers an update found by the check at start. */
  dialogOpen: boolean;
}

const INITIAL: UpdatesState = { phase: "idle", update: null, failure: null, progress: null, dialogOpen: false };

let state: UpdatesState = INITIAL;
let startupCheckDone = false;
let appInfo: AppInfo | null = null;
let appInfoRequest: Promise<AppInfo | null> | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<UpdatesState>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

/** Bundles that the updater replaces in place; `.deb`/`.rpm` belong to the package manager. */
export function canInstall(kind: BundleKind | null): boolean {
  return kind === "appimage" || kind === "app" || kind === "msi" || kind === "nsis";
}

/** Sorts an updater error (the plugins report plain text) into something to tell the user. */
export function classifyUpdateError(error: ApiError): UpdateErrorKind {
  const text = error.message;
  if (/signature|minisign|public key/i.test(text)) return "signature";
  if (/valid release JSON|platforms?\b.*not found|fallback platforms/i.test(text)) return "noRelease";
  if (
    error.code === "timeout" ||
    /error sending request|connect|dns|resolve|timed? ?out|network|tls|certificate|proxy|unreachable|offline/i.test(text)
  ) {
    return "network";
  }
  return "other";
}

function fail(during: UpdateFailure["during"], err: unknown): UpdateFailure {
  const error = toApiError(err);
  return { kind: classifyUpdateError(error), during, error };
}

/**
 * Asks for a newer release. `automatic` (the check at start) opens the update dialog when one is found and keeps a
 * failure out of sight (Settings still shows it).
 */
export async function checkForUpdates({ automatic = false }: { automatic?: boolean } = {}): Promise<void> {
  if (state.phase === "checking" || state.phase === "installing" || state.phase === "restarting") return;
  setState({ phase: "checking", failure: null });
  try {
    const update = await api.updates.check();
    if (update) setState({ phase: "available", update, dialogOpen: automatic || state.dialogOpen });
    else setState({ phase: "upToDate", update: null });
  } catch (err) {
    setState({ phase: "error", failure: fail("check", err) });
  }
}

/** The check at start: once per run of the app. */
export function checkAtStart(): void {
  if (startupCheckDone) return;
  startupCheckDone = true;
  void checkForUpdates({ automatic: true });
}

/** Downloads and installs the update that was found, then restarts the app. */
export async function installUpdate(): Promise<void> {
  const update = state.update;
  if (!update || state.phase === "installing" || state.phase === "restarting") return;
  setState({ phase: "installing", failure: null, progress: null });
  try {
    await update.install((progress) => setState({ progress }));
  } catch (err) {
    setState({ phase: "error", failure: fail("install", err), progress: null });
    return;
  }
  setState({ phase: "restarting" });
  try {
    await api.updates.relaunch();
  } catch (err) {
    setState({ phase: "error", failure: fail("install", err) });
  }
}

export function closeUpdateDialog(): void {
  setState({ dialogOpen: false });
}

/** Forgets everything (tests). */
export function resetUpdatesState(): void {
  state = INITIAL;
  startupCheckDone = false;
  appInfo = null;
  appInfoRequest = null;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useUpdates(): UpdatesState {
  return useSyncExternalStore(subscribe, () => state);
}

function loadAppInfo(): void {
  if (appInfoRequest) return;
  appInfoRequest = api.updates.appInfo().then(
    (info) => {
      appInfo = info;
      for (const fn of listeners) fn();
      return info;
    },
    () => null,
  );
}

/** Version and bundle kind of the running app; `null` until known (or if they cannot be read). */
export function useAppInfo(): AppInfo | null {
  const info = useSyncExternalStore(subscribe, () => appInfo);
  useEffect(loadAppInfo, []);
  return info;
}
