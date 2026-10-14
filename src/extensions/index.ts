// The extension host: what the window does with installed extensions (src/extensions is core UI, not a feature). It
// registers their contributions, draws their frames and answers their messages (protocol.ts). Settings → Extensions
// (features/extensions) builds on `useExtensions` and `ExtensionSettingsFrame`.
export { registerExtension, registeredExtensions, syncExtensions, unregisterExtension } from "./contributions";
export { ExtensionFrame, ExtensionSettingsFrame, FRAME_SANDBOX, type ExtensionFrameProps } from "./ExtensionFrame";
export { ExtensionsHost } from "./ExtensionsHost";
export { pushNotice, resetNotices, useNotices, type Notice } from "./notices";
export * from "./protocol";
export {
  findExtension,
  refreshExtensions,
  resetExtensionsStore,
  useExtension,
  useExtensionFiles,
  useExtensions,
  type ExtensionsSnapshot,
} from "./store";
