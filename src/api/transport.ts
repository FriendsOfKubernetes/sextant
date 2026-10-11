// The only place that talks to Tauri. Everything else in the frontend goes through src/api.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { open as tauriOpen, save as tauriSave } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { toApiError } from "./errors";

export type Unsubscribe = () => void;

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileOptions {
  title?: string;
  filters?: FileFilter[];
  defaultPath?: string;
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
}

export const tauriTransport: Transport = {
  invoke: (cmd, args) => tauriInvoke(cmd, args),
  listen: async (event, handler) => tauriListen(event, (e) => handler(e.payload as never)),
  openFile: async (options) => {
    const picked = await tauriOpen({ ...options, multiple: false, directory: false });
    return typeof picked === "string" ? picked : null;
  },
  saveFile: (options) => tauriSave(options),
  openUrl: (url) => tauriOpenUrl(url),
};

let current: Transport = tauriTransport;

export function setTransport(transport: Transport | null): void {
  current = transport ?? tauriTransport;
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
