// Public surface of the backend bridge. Components import from "src/api" only.
import * as commands from "./commands";
import { openExternalUrl, openFileDialog, saveFileDialog } from "./transport";

export const api = {
  clusters: commands.clusters,
  resources: commands.resources,
  actions: commands.actions,
  logs: commands.logs,
  terminal: commands.terminal,
  portForward: commands.portForward,
  metrics: commands.metrics,
  helm: commands.helm,
  settings: commands.settings,
  files: commands.files,
  streams: commands.streams,
  dialog: { openFile: openFileDialog, saveFile: saveFileDialog },
  /** The operating system: `openUrl(url)` opens a link in the default browser. */
  shell: { openUrl: openExternalUrl },
};

export type { KubeObject } from "./commands";
export { ApiError, ERROR_CODES, errorKey, toApiError } from "./errors";
export { events } from "./events";
export { mockBackend, type MockBackend, type MockBackendOptions, type MockCall, type MockHandler } from "./mockBackend";
export { defaultAppSettings, loadSettings, updateSettings, useSettings, type UseSettings } from "./settings";
export type { FileFilter, OpenFileOptions, SaveFileOptions, Unsubscribe } from "./transport";
export { newStreamId, openStream, resetStreams, type StreamSpec } from "./stream";
export { applyWatchUpdate, uidOf, useWatch, type WatchState, type WatchStatus } from "./useWatch";
export type * from "./types";
