// Public surface of the backend bridge. Components import from "src/api" only.
import * as commands from "./commands";
import { notifications } from "./notifications";
import { openExternalUrl, openFileDialog, saveFileDialog } from "./transport";
import { updates } from "./updater";

export const api = {
  clusters: commands.clusters,
  cloud: commands.cloud,
  resources: commands.resources,
  actions: commands.actions,
  logs: commands.logs,
  terminal: commands.terminal,
  portForward: commands.portForward,
  metrics: commands.metrics,
  helm: commands.helm,
  settings: commands.settings,
  about: commands.about,
  files: commands.files,
  argocd: commands.argocd,
  gitopsInstall: commands.gitopsInstall,
  access: commands.access,
  rbac: commands.rbac,
  upgrade: commands.upgrade,
  cleanup: commands.cleanup,
  timeline: commands.timeline,
  storage: commands.storage,
  openapi: commands.openapi,
  tls: commands.tls,
  cost: commands.cost,
  kubeconfig: commands.kubeconfig,
  mcp: commands.mcp,
  extensions: commands.extensions,
  streams: commands.streams,
  dialog: { openFile: openFileDialog, saveFile: saveFileDialog },
  /** The operating system: `openUrl(url)` opens a link in the default browser. */
  shell: { openUrl: openExternalUrl },
  /** In-app updates and the app's own version (Tauri updater and process plugins). */
  updates,
  /** Desktop notifications (Tauri notification plugin). */
  notifications,
};

export type { KubeObject } from "./commands";
export { ApiError, ERROR_CODES, errorKey, toApiError } from "./errors";
export { events } from "./events";
export { observeWatchUpdates, type WatchObserver } from "./watchObservers";
export { mockBackend, UPDATER_COMMANDS, type MockBackend, type MockBackendOptions, type MockCall, type MockHandler } from "./mockBackend";
export {
  NOTIFICATION_COMMANDS,
  type DesktopNotification,
  type NotificationAction,
  type NotificationActionType,
} from "./notifications";
export { defaultAppSettings, loadSettings, updateSettings, useSettings, type UseSettings } from "./settings";
export { withBackendSettingsChange } from "./settings";
export type { FileFilter, OpenFileOptions, SaveFileOptions, StreamChannel, Unsubscribe } from "./transport";
export { newStreamId, openStream, resetStreams, type StreamSpec } from "./stream";
export { applyWatchUpdate, uidOf, useWatch, type WatchState, type WatchStatus } from "./useWatch";
export type * from "./types";
export {
  RELEASES_URL,
  updaterConfiguredIn,
  type AppInfo,
  type AvailableUpdate,
  type BundleKind,
  type DownloadProgress,
  type UpdateInfo,
} from "./updater";
