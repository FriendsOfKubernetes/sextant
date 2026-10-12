// In-app updates (G15): the check at start (`UpdateNotice`, mounted by the Settings button) and the "Updates"
// section of Settings (`UpdatesPanel`). Releases come from `latest.json` of the latest GitHub release, signed with
// the key whose public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
export { UpdateNotice } from "./UpdateNotice";
export { UpdatesPanel, type UpdatesPanelProps } from "./UpdatesPanel";
export {
  canInstall,
  checkForUpdates,
  classifyUpdateError,
  resetUpdatesState,
  useAppInfo,
  useUpdates,
  type UpdateErrorKind,
  type UpdatePhase,
  type UpdatesState,
} from "./store";
