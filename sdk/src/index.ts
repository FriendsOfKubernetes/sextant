// @sextant/extension-sdk — what an extension's page needs: `connect()` to Sextant, the API's types, the theme helper
// and the manifest's types.
export { connect, type ConnectOptions, type Sextant, type Watch, type WatchHandlers } from "./client";
export { SextantError, isSextantError } from "./errors";
export { applyTheme, addBaseStyles, type ThemeOptions } from "./theme";
export { trackObjects, objectKey } from "./live";
export { createI18n, catalogProblems, matchLanguage, type Catalog, type Catalogs, type I18n, type TranslationValues } from "./i18n";
export type * from "./api";
export type { HostContext, FrameView, RequestId } from "./protocol";
export { PROTOCOL_VERSION, THEME_TOKENS } from "./protocol";
export * from "./manifest";
export type { ErrorCode } from "./generated/ErrorCode";
