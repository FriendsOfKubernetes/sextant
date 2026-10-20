// The only place that talks to Tauri. Everything else in the frontend goes through src/api.
import { getBundleType, getVersion } from "@tauri-apps/api/app";
import { Channel as TauriChannel, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { resourceDir } from "@tauri-apps/api/path";
import { open as tauriOpen, save as tauriSave } from "@tauri-apps/plugin-dialog";
import {
  onAction as tauriOnNotificationAction,
  registerActionTypes as tauriRegisterActionTypes,
} from "@tauri-apps/plugin-notification";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { check as tauriCheck } from "@tauri-apps/plugin-updater";
// The same file the backend is built with: the updater plugin is registered only when it has a public key.
import tauriConfig from "../../src-tauri/tauri.conf.json";
import { toApiError } from "./errors";
import type { DesktopNotification, NotificationAction, NotificationActionType } from "./notifications";
import { installedBundleKind, updaterConfiguredIn, type AppInfo, type AvailableUpdate } from "./updater";

export type Unsubscribe = () => void;

/**
 * Where the backend sends one stream's payloads: passed as the `onEvent` argument of a `*_start` command (a Tauri
 * `Channel`), otherwise opaque. The backend drops its end when the stream stops.
 */
export interface StreamChannel<T = unknown> {
  /** Stops delivering payloads to the handler (idempotent). */
  close(): void;
  /** Never set: only ties the channel to the type of its payloads, so a channel of logs cannot start a watch. */
  readonly payloadType?: (payload: T) => void;
}

/** A Tauri `Channel` whose handler can be cut off from the window's side. */
class TauriStreamChannel<T> extends TauriChannel<T> implements StreamChannel<T> {
  private open = true;

  constructor(handler: (payload: T) => void) {
    super();
    this.onmessage = (payload) => {
      if (this.open) handler(payload);
    };
  }

  close(): void {
    this.open = false;
  }
}

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
  /** A channel for the payloads of one backend stream (`onEvent` of its `*_start` command). */
  channel<T>(handler: (payload: T) => void): StreamChannel<T>;
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
  /** Shows a desktop notification (Tauri notification plugin). */
  notify(notification: DesktopNotification): Promise<void>;
  /** Registers the buttons notifications may carry (`actionTypeId`). */
  registerNotificationActions(types: NotificationActionType[]): Promise<void>;
  /** Hears clicks on Sextant's notifications and on their buttons. */
  onNotificationAction(handler: (action: NotificationAction) => void): Promise<Unsubscribe>;
}

export const tauriTransport: Transport = {
  invoke: (cmd, args) => tauriInvoke(cmd, args),
  listen: async (event, handler) => tauriListen(event, (e) => handler(e.payload as never)),
  channel: (handler) => new TauriStreamChannel(handler),
  openFile: async (options) => {
    const picked = await tauriOpen({ ...options, multiple: false, directory: options.directory ?? false });
    return typeof picked === "string" ? picked : null;
  },
  saveFile: (options) => tauriSave(options),
  openUrl: (url) => tauriOpenUrl(url),
  updaterConfigured: () => updaterConfiguredIn(tauriConfig),
  appInfo: async () => {
    const [version, bundle] = await Promise.all([getVersion(), getBundleType().catch(() => null)]);
    // Only macOS reports `app`; there the resource directory tells a real `.app` from a bare binary. A copy with no
    // bundle kind may be Scoop's (its directory tells).
    const resources = bundle === "app" || !bundle ? await resourceDir().catch(() => null) : null;
    return { version, bundleKind: installedBundleKind(bundle, resources), devBuild: import.meta.env.DEV };
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
  // The plugin's own command (what its `sendNotification` sends through `window.Notification`, which drops failures),
  // so a failure is seen: it is logged with the title only, never the body.
  notify: async (notification) => {
    try {
      await tauriInvoke("plugin:notification|notify", { options: notification });
    } catch (err) {
      console.warn(`Sextant: the notification "${Array.from(notification.title).slice(0, 80).join("")}" was not shown`, err);
      throw err;
    }
  },
  registerNotificationActions: (types) => tauriRegisterActionTypes(types),
  onNotificationAction: async (handler) => {
    const listener = await tauriOnNotificationAction((event) =>
      handler({ actionId: event.actionId, extra: event.notification?.extra ?? null }),
    );
    return () => void listener.unregister();
  },
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

/** A channel for one backend stream's payloads (see `openStream`). */
export function streamChannel<T>(handler: (payload: T) => void): StreamChannel<T> {
  return current.channel<T>(handler);
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
