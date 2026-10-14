// The installed extensions as the window knows them: `api.extensions.list()`, asked again on `extensions-changed`, and
// a counter per extension that grows on `extension-files-changed` (development mode), which reloads its frames.
// One shared copy: it starts with its first subscriber and stops (forgetting the list) after the last one leaves.
import { useSyncExternalStore } from "react";
import { api, events, toApiError, type ApiError, type ExtensionInfo, type Unsubscribe } from "../api";

export interface ExtensionsSnapshot {
  /** Installed extensions (any state); empty until the first answer. */
  extensions: readonly ExtensionInfo[];
  /** The list was read at least once. */
  loaded: boolean;
  /** Why the last read failed. */
  error: ApiError | null;
  /** Changes of each extension's files seen since the window started (development mode). */
  files: Readonly<Record<string, number>>;
}

const EMPTY: ExtensionsSnapshot = Object.freeze({ extensions: [], loaded: false, error: null, files: {} });

let snapshot: ExtensionsSnapshot = EMPTY;
const listeners = new Set<() => void>();
let unsubscribers: Promise<Unsubscribe>[] = [];
let sequence = 0;

function set(next: Partial<ExtensionsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of [...listeners]) listener();
}

/** Reads the list again; answers that arrive out of order are dropped. */
export async function refreshExtensions(): Promise<void> {
  const mine = ++sequence;
  try {
    const extensions = await api.extensions.list();
    if (mine === sequence) set({ extensions, loaded: true, error: null });
  } catch (err) {
    if (mine === sequence) set({ loaded: true, error: toApiError(err) });
  }
}

function start(): void {
  unsubscribers = [
    events.onExtensionsChanged(() => void refreshExtensions()),
    events.onExtensionFilesChanged(({ id }) => {
      set({ files: { ...snapshot.files, [id]: (snapshot.files[id] ?? 0) + 1 } });
      // A changed manifest changes the contributions.
      void refreshExtensions();
    }),
  ];
  void refreshExtensions();
}

function stop(): void {
  for (const off of unsubscribers) void off.then((fn) => fn(), () => undefined);
  unsubscribers = [];
  sequence++;
  snapshot = EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const getSnapshot = () => snapshot;

/** Installed extensions with their states, kept up to date. */
export function useExtensions(): ExtensionsSnapshot & { refresh: () => Promise<void> } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...current, refresh: refreshExtensions };
}

/** One installed extension, kept up to date (`undefined` when it is not installed or the list is not read yet). */
export function useExtension(id: string): ExtensionInfo | undefined {
  return useSyncExternalStore(subscribe, () => findExtension(id), () => findExtension(id));
}

/** How many times the extension's files changed (development mode): a new value means its frames reload. */
export function useExtensionFiles(id: string): number {
  return useSyncExternalStore(subscribe, () => snapshot.files[id] ?? 0, () => snapshot.files[id] ?? 0);
}

/** The extension as last read, outside React. */
export function findExtension(id: string): ExtensionInfo | undefined {
  return snapshot.extensions.find((e) => e.id === id);
}

/** Forgets the list and reads it again from the current backend if anyone is subscribed (tests). */
export function resetExtensionsStore(): void {
  stop();
  if (listeners.size > 0) start();
  for (const listener of [...listeners]) listener();
}
