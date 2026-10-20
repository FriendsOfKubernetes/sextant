// Test double for the backend: replaces `invoke`/`listen`/stream channels/dialogs with a table of handlers.
// Used by Vitest; never imported by application code.
import type { AppSettings } from "./generated/AppSettings";
import { NOTIFICATION_COMMANDS } from "./notifications";
import { defaultAppSettings, resetSettingsCache } from "./settings";
import { resetStreamsState } from "./stream";
import {
  setTransport,
  type OpenFileOptions,
  type SaveFileOptions,
  type StreamChannel,
  type Transport,
  type Unsubscribe,
} from "./transport";
import type { AppInfo, UpdateInfo } from "./updater";

export type MockHandler = (args: Record<string, unknown>) => unknown;

export interface MockCall {
  cmd: string;
  args: Record<string, unknown>;
}

export interface MockBackendOptions {
  /** Initial settings served by the default `settings_get` / `settings_update` handlers. */
  settings?: Partial<AppSettings>;
  /** Result of the "open file" dialog (`options.directory` when a folder is asked for). */
  openFile?: (options: OpenFileOptions) => string | null;
  /** Result of the "save file" dialog. */
  saveFile?: (options: SaveFileOptions) => string | null;
  /** Whether the build has an update signing key (default `true`). */
  updaterConfigured?: boolean;
  /** Version and bundle kind of the app (default `0.15.5`, no bundle: not installed from a release package). */
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
   * Delivers a backend event to the current listeners. The payloads of a stream, which the real backend sends through
   * the channel of its `*_start` command (`onEvent`), are emitted here under an event name as before:
   * `<prefix>:<streamId>` (see {@link STREAM_PREFIXES}). A stream can be named by the string its `*_start` handler
   * returned (`watch:watch-1`) as well as by the id the frontend chose (`watch:<uuid>`).
   */
  emit(event: string, payload: unknown): void;
  /** Listeners of an event (a stream's open channel counts as one); streams can be named as in `emit`. */
  listenerCount(event: string): number;
  /** Restores the real Tauri transport. */
  restore(): void;
}

const NOT_IMPLEMENTED = { code: "other", message: "not implemented" } as const;

/**
 * The event name `emit` and `listenerCount` know a stream by, `<prefix>:<streamId>`, for each command whose `onEvent`
 * channel carries a stream's payloads.
 */
export const STREAM_PREFIXES: Readonly<Record<string, string>> = {
  watch_start: "watch",
  logs_start: "logs",
  exec_start: "term",
  terminal_start: "term",
  node_shell_start: "term",
  debug_start: "term",
  gitops_install_start: "gitops-install",
  files_download_start: "files",
  files_upload_start: "files",
  extension_call: "ext-watch",
};

/** The mock's stream channel: the handler, and what `close` removes it from once it is registered. */
class MockChannel implements StreamChannel {
  closed = false;
  unregister: (() => void) | null = null;

  constructor(readonly handler: (payload: unknown) => void) {}

  close(): void {
    this.closed = true;
    this.unregister?.();
    this.unregister = null;
  }
}

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
 * `settings_get` / `settings_update` work out of the box on an in-memory copy, `extensions_list` answers `[]`, and
 * `extension_install_cancel`, `term_ack` and `files_transfer_stop` resolve.
 *
 * Stream ids come from the frontend (`streamId` of `*_start`), and so does the channel of the stream's payloads
 * (`onEvent`): it is registered as a listener of `<prefix>:<streamId>` before the handler runs, so a handler may emit
 * at once, and closing it removes the listener. A `*_start` handler may still answer with a name of its own for the
 * stream (`"watch-1"`); `emit` and `listenerCount` then accept that name in place of the id.
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
  // Desktop notifications are shown and their buttons registered; nothing to answer.
  table.set(NOTIFICATION_COMMANDS.notify, () => undefined);
  table.set(NOTIFICATION_COMMANDS.registerActionTypes, () => undefined);
  // The window asks for the installed extensions on start; none unless a test says otherwise.
  table.set("extensions_list", () => []);
  // Closing a window of consent drops its pending install; nothing to answer.
  table.set("extension_install_cancel", () => undefined);
  // Closing an install dialog stops its stream; nothing to answer.
  table.set("gitops_install_stop", () => undefined);
  // Terminals acknowledge the output they wrote; nothing to answer.
  table.set("term_ack", () => undefined);
  // Closing a file transfer stops its stream; nothing to answer.
  table.set("files_transfer_stop", () => undefined);
  // A desktop with a tray, unless a test says otherwise.
  table.set("tray_status", () => ({ available: true }));
  // The window sends the tray menu's texts when the UI language changes; nothing to answer.
  table.set("tray_set_texts", () => undefined);
  // A machine the About dialog can describe.
  table.set("about_info", () => ({
    os: "Linux",
    arch: "x86_64",
    osVersion: "Ubuntu 24.04.1 LTS",
    webviewVersion: "2.44.1",
    tauriVersion: "2.12.3",
  }));
  table.set("settings_get", () => structuredClone(settings));
  table.set("settings_update", (args) => {
    settings = structuredClone(args.settings as AppSettings);
    return structuredClone(settings);
  });
  for (const [cmd, handler] of Object.entries(handlers)) table.set(cmd, handler);

  const listen = (event: string, fn: (payload: unknown) => void): Unsubscribe => {
    const set = listeners.get(event) ?? new Set();
    set.add(fn);
    listeners.set(event, set);
    return () => {
      set.delete(fn);
    };
  };

  const transport: Transport = {
    async invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ cmd, args });
      const prefix = STREAM_PREFIXES[cmd];
      const channel = args.onEvent;
      if (prefix && channel instanceof MockChannel && !channel.closed && typeof args.streamId === "string") {
        channel.unregister = listen(`${prefix}:${args.streamId}`, channel.handler);
      }
      const handler = table.get(cmd);
      if (!handler) throw { ...NOT_IMPLEMENTED };
      const result = await handler(args);
      if (typeof args.streamId === "string" && typeof result === "string" && result !== args.streamId) {
        streamNames.set(result, args.streamId);
      }
      return result as T;
    },
    async listen<T>(event: string, handler: (payload: T) => void) {
      return listen(event, handler as (payload: unknown) => void);
    },
    channel<T>(handler: (payload: T) => void): StreamChannel<T> {
      return new MockChannel(handler as (payload: unknown) => void);
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
    appInfo: async () => ({ version: "0.15.5", bundleKind: null, devBuild: false, ...options.app }),
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
    async notify(notification) {
      await transport.invoke<void>(NOTIFICATION_COMMANDS.notify, { options: notification });
    },
    async registerNotificationActions(types) {
      await transport.invoke<void>(NOTIFICATION_COMMANDS.registerActionTypes, { types });
    },
    onNotificationAction(handler) {
      return transport.listen(NOTIFICATION_COMMANDS.actionEvent, handler);
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
