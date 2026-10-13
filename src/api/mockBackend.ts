// Test double for the backend: replaces `invoke`/`listen`/dialogs with a table of handlers.
// Used by Vitest; never imported by application code.
import type { AppSettings } from "./generated/AppSettings";
import { defaultAppSettings, resetSettingsCache } from "./settings";
import { resetStreamsState } from "./stream";
import { setTransport, type OpenFileOptions, type SaveFileOptions, type Transport } from "./transport";
import type { AppInfo, UpdateInfo } from "./updater";

export type MockHandler = (args: Record<string, unknown>) => unknown;

export interface MockCall {
  cmd: string;
  args: Record<string, unknown>;
}

export interface MockBackendOptions {
  /** Initial settings served by the default `settings_get` / `settings_update` handlers. */
  settings?: Partial<AppSettings>;
  /** Result of the "open file" dialog. */
  openFile?: (options: OpenFileOptions) => string | null;
  /** Result of the "save file" dialog. */
  saveFile?: (options: SaveFileOptions) => string | null;
  /** Whether the build has an update signing key (default `true`). */
  updaterConfigured?: boolean;
  /** Version and bundle kind of the app (default `0.4.0`, no bundle: not installed from a release package). */
  app?: Partial<AppInfo>;
}

export interface MockBackend {
  /** Every command invoked, in order. */
  readonly calls: MockCall[];
  /** Settings as stored by the default settings handlers. */
  readonly settings: AppSettings;
  /** URLs passed to `api.shell.openUrl` (the system browser), in order. */
  readonly openedUrls: string[];
  /** Adds or replaces a command handler. */
  on(cmd: string, handler: MockHandler): void;
  /**
   * Delivers a backend event to the current listeners. A stream can be named by the string its `*_start` handler
   * returned (`watch:watch-1`) as well as by the id the frontend chose (`watch:<uuid>`).
   */
  emit(event: string, payload: unknown): void;
  /** Listeners of an event; stream events can be named by the handler's name for the stream, as in `emit`. */
  listenerCount(event: string): number;
  /** Restores the real Tauri transport. */
  restore(): void;
}

const NOT_IMPLEMENTED = { code: "other", message: "not implemented" } as const;

/** Mock command names of the Tauri plugins behind `api.updates` (the commands the plugins invoke). */
export const UPDATER_COMMANDS = {
  /** Handler returns an `UpdateInfo` or `null`; may throw (network error). Args: `{}`. */
  check: "plugin:updater|check",
  /** Handler installs the update; may throw. Args: `{ version }`. */
  install: "plugin:updater|download_and_install",
  /** Restart of the application; resolves by default. Args: `{}`. */
  relaunch: "plugin:process|restart",
} as const;

/**
 * Installs a mock backend. Commands without a handler reject like the backend stubs do
 * (`{ code: "other", message: "not implemented" }`); a handler that throws rejects with the thrown value.
 * `settings_get` / `settings_update` work out of the box on an in-memory copy.
 *
 * Stream ids come from the frontend (`streamId` of `*_start`). A `*_start` handler may still answer with a name of
 * its own for the stream (`"watch-1"`); `emit` and `listenerCount` then accept that name in place of the id.
 */
export function mockBackend(handlers: Record<string, MockHandler> = {}, options: MockBackendOptions = {}): MockBackend {
  const table = new Map<string, MockHandler>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const calls: MockCall[] = [];
  const openedUrls: string[] = [];
  // Name a `*_start` handler gave a stream → the id the frontend chose for it.
  const streamNames = new Map<string, string>();
  const resolve = (event: string) => {
    const colon = event.indexOf(":");
    if (colon < 0) return event;
    const id = streamNames.get(event.slice(colon + 1));
    return id ? `${event.slice(0, colon + 1)}${id}` : event;
  };
  const defaults = defaultAppSettings();
  let settings: AppSettings = {
    ...defaults,
    ...options.settings,
    window: { ...defaults.window, ...options.settings?.window },
  };

  table.set(UPDATER_COMMANDS.relaunch, () => undefined);
  table.set("settings_get", () => structuredClone(settings));
  table.set("settings_update", (args) => {
    settings = structuredClone(args.settings as AppSettings);
    return structuredClone(settings);
  });
  for (const [cmd, handler] of Object.entries(handlers)) table.set(cmd, handler);

  const transport: Transport = {
    async invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ cmd, args });
      const handler = table.get(cmd);
      if (!handler) throw { ...NOT_IMPLEMENTED };
      const result = await handler(args);
      if (typeof args.streamId === "string" && typeof result === "string" && result !== args.streamId) {
        streamNames.set(result, args.streamId);
      }
      return result as T;
    },
    async listen<T>(event: string, handler: (payload: T) => void) {
      const set = listeners.get(event) ?? new Set();
      const fn = handler as (payload: unknown) => void;
      set.add(fn);
      listeners.set(event, set);
      return () => {
        set.delete(fn);
      };
    },
    async openFile(opts) {
      return options.openFile?.(opts) ?? null;
    },
    async saveFile(opts) {
      return options.saveFile?.(opts) ?? null;
    },
    async openUrl(url) {
      openedUrls.push(url);
    },
    updaterConfigured: () => options.updaterConfigured ?? true,
    appInfo: async () => ({ version: "0.4.0", bundleKind: null, ...options.app }),
    async checkUpdate() {
      const info = await transport.invoke<UpdateInfo | null>(UPDATER_COMMANDS.check, {});
      if (!info) return null;
      return {
        ...info,
        install: async () => {
          await transport.invoke<void>(UPDATER_COMMANDS.install, { version: info.version });
        },
      };
    },
    async relaunch() {
      await transport.invoke<void>(UPDATER_COMMANDS.relaunch, {});
    },
  };

  resetSettingsCache();
  resetStreamsState();
  setTransport(transport);

  return {
    calls,
    openedUrls,
    get settings() {
      return settings;
    },
    on(cmd, handler) {
      table.set(cmd, handler);
    },
    emit(event, payload) {
      for (const fn of [...(listeners.get(resolve(event)) ?? [])]) fn(payload);
    },
    listenerCount(event) {
      return listeners.get(resolve(event))?.size ?? 0;
    },
    restore() {
      setTransport(null);
      resetSettingsCache();
      resetStreamsState();
    },
  };
}
