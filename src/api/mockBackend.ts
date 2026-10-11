// Test double for the backend: replaces `invoke`/`listen`/dialogs with a table of handlers.
// Used by Vitest; never imported by application code.
import type { AppSettings } from "./generated/AppSettings";
import { defaultAppSettings, resetSettingsCache } from "./settings";
import { setTransport, type OpenFileOptions, type SaveFileOptions, type Transport } from "./transport";

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
  /** Delivers a backend event to the current listeners. */
  emit(event: string, payload: unknown): void;
  listenerCount(event: string): number;
  /** Restores the real Tauri transport. */
  restore(): void;
}

const NOT_IMPLEMENTED = { code: "other", message: "not implemented" } as const;

/**
 * Installs a mock backend. Commands without a handler reject like the backend stubs do
 * (`{ code: "other", message: "not implemented" }`); a handler that throws rejects with the thrown value.
 * `settings_get` / `settings_update` work out of the box on an in-memory copy.
 */
export function mockBackend(handlers: Record<string, MockHandler> = {}, options: MockBackendOptions = {}): MockBackend {
  const table = new Map<string, MockHandler>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const calls: MockCall[] = [];
  const openedUrls: string[] = [];
  const defaults = defaultAppSettings();
  let settings: AppSettings = {
    ...defaults,
    ...options.settings,
    window: { ...defaults.window, ...options.settings?.window },
  };

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
      return (await handler(args)) as T;
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
  };

  resetSettingsCache();
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
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    restore() {
      setTransport(null);
      resetSettingsCache();
    },
  };
}
