// The only place that talks to Tauri. Everything else in the frontend goes through src/api.
import { getBundleType, getVersion } from "@tauri-apps/api/app";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { open as tauriOpen, save as tauriSave } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { check as tauriCheck } from "@tauri-apps/plugin-updater";
// The same file the backend is built with: the updater plugin is registered only when it has a public key.
import tauriConfig from "../../src-tauri/tauri.conf.json";
import { toApiError } from "./errors";
import { updaterConfiguredIn, type AppInfo, type AvailableUpdate, type BundleKind } from "./updater";

export type Unsubscribe = () => void;

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileOptions {
  title?: string;
  filters?: FileFilter[];
  defaultPath?: string;
  /** Pick a folder instead of a file (`filters` do not apply). */
  directory?: boolean;
}

export interface SaveFileOptions {
  title?: string;
  filters?: FileFilter[];
  defaultPath?: string;
}

/** How commands, events and native dialogs reach the backend. Swapped by `mockBackend` in tests. */
export interface Transport {
  invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<Unsubscribe>;
  openFile(options: OpenFileOptions): Promise<string | null>;
  saveFile(options: SaveFileOptions): Promise<string | null>;
  /** Opens a URL in the system's default browser (never inside the app window). */
  openUrl(url: string): Promise<void>;
  /** Whether the build has an update signing key (`plugins.updater` in `tauri.conf.json`). */
  updaterConfigured(): boolean;
  appInfo(): Promise<AppInfo>;
  /** Asks the update endpoint for a newer release (Tauri updater plugin). */
  checkUpdate(): Promise<AvailableUpdate | null>;
  /** Restarts the application (Tauri process plugin). */
  relaunch(): Promise<void>;
}

const BUNDLE_KINDS: readonly string[] = ["appimage", "deb", "rpm", "app", "msi", "nsis"] satisfies BundleKind[];

export const tauriTransport: Transport = {
  invoke: (cmd, args) => tauriInvoke(cmd, args),
  listen: async (event, handler) => tauriListen(event, (e) => handler(e.payload as never)),
  openFile: async (options) => {
    const picked = await tauriOpen({ ...options, multiple: false, directory: options.directory ?? false });
    return typeof picked === "string" ? picked : null;
  },
  saveFile: (options) => tauriSave(options),
  openUrl: (url) => tauriOpenUrl(url),
  updaterConfigured: () => updaterConfiguredIn(tauriConfig),
  appInfo: async () => {
    const [version, bundle] = await Promise.all([getVersion(), getBundleType().catch(() => null)]);
    const kind = typeof bundle === "string" ? bundle : null;
    return { version, bundleKind: kind && BUNDLE_KINDS.includes(kind) ? (kind as BundleKind) : null };
  },
  checkUpdate: async () => {
    const update = await tauriCheck();
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date ?? null,
      notes: update.body ?? null,
      install: async (onProgress) => {
        let downloaded = 0;
        let total: number | null = null;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? null;
          else if (event.event === "Progress") downloaded += event.data.chunkLength;
          onProgress?.({ downloaded, total });
        });
      },
    };
  },
  relaunch: () => tauriRelaunch(),
};

let current: Transport = tauriTransport;

export function setTransport(transport: Transport | null): void {
  current = transport ?? tauriTransport;
}

/** The transport in use (the Tauri one, or the one `mockBackend` installed). */
export function currentTransport(): Transport {
  return current;
}

/** Invokes a command; failures are rethrown as `ApiError`. */
export async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await current.invoke<T>(cmd, args);
  } catch (err) {
    throw toApiError(err);
  }
}

/** Subscribes to a backend event; resolves to the unsubscribe function. */
export function subscribe<T>(event: string, handler: (payload: T) => void): Promise<Unsubscribe> {
  return current.listen<T>(event, handler);
}

export function openFileDialog(options: OpenFileOptions = {}): Promise<string | null> {
  return current.openFile(options);
}

export function saveFileDialog(options: SaveFileOptions = {}): Promise<string | null> {
  return current.saveFile(options);
}

/** Opens `url` in the system browser; failures are rethrown as `ApiError`. */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    await current.openUrl(url);
  } catch (err) {
    throw toApiError(err);
  }
}
