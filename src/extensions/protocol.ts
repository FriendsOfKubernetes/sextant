// The message protocol between Sextant (the host window) and an extension's frame. This file is the single source of
// truth for both sides: the host implements it in `bridge.ts`, the SDK (`sdk/`) implements the frame side.
//
// An extension runs in `<iframe sandbox="allow-scripts allow-forms allow-popups-to-escape-sandbox">` (never
// `allow-same-origin`), so its origin is opaque and it reaches nothing of Sextant but `window.parent.postMessage`.
// Every message carries `sextant: 1` (the API major version, `sextantApi` of the manifest); the host ignores messages
// without it, and messages from any window but the frame's own.
//
// Every message also carries `doc`: the id of the document in the frame that sent it, or that it is for. The
// document (the SDK) makes it up at start — 128 random bits as 32 hex digits (`[A-Za-z0-9_-]{16,128}`) — and puts it
// in everything it sends; the host puts it in everything it answers. A frame message without a valid `doc` is ignored.
//
//   frame → host   {sextant: 1, doc, type: "ready"}              the document listens; sent first, before any call;
//                                                                 the host answers with the context
//   frame → host   {sextant: 1, doc, id, method, params?}        a call; `id` (string or number) is chosen by the frame
//   host  → frame  {sextant: 1, doc, id, result}                 its answer
//   host  → frame  {sextant: 1, doc, id, error: {code, message}} or its failure (`code`: `ErrorCode` — denied, invalid…)
//   host  → frame  {sextant: 1, doc, stream: <id>, event}        an update of a `resources.watch` call (`event`: a
//                                                                 `WatchUpdate`); the stream is named by the `id` of
//                                                                 the call that opened it, so the frame can listen
//                                                                 before the answer comes
//   host  → frame  {sextant: 1, doc, type: "context", context}   on `ready`, on every load of the frame and whenever
//                                                                 any of it changes: theme, language, cluster,
//                                                                 namespaces, selection (sent to the document that
//                                                                 said `ready` last)
//   frame → host   {sextant: 1, doc, type: "resize", height}     content height in CSS pixels (details sections)
//   frame → host   {sextant: 1, doc, type: "error", message}     an uncaught error: the host shows "Extension failed"
//
// Documents. Calls, their ids, watches and the limit of open watches are per document: a new document in the frame
// (`location.reload()`, another page of the package, an update) has ids, watches and answers of its own, whether it
// starts before or after the frame's `load` event. The frame (the SDK) ignores every message whose `doc` is not its
// own. The host ends documents that are gone: at every `load` of the frame after the first it closes the watches and
// drops the answers of every document except the one whose `ready` came last and after the previous load (the new
// document — an unloaded one sends nothing more); when that one was in fact the previous document saying `ready` late,
// the `ready` of the next document ends it. Messages of an ended document are ignored; everything ends when the frame
// goes away. A frame has at most `MAX_DOCUMENTS_PER_FRAME` documents going: a new one beyond that ends the oldest
// document that is neither the current one nor the one the last load kept.
//
// `doc` separates only well-behaved documents. It is not a secret from the frame: answers and stream updates for a
// document still on their way when it unloads can reach the next document in the same frame (until the next `load`
// ends the old document), which could read that `doc` and use it until then. This gives no more than the frame
// already has — the same extension, the same permissions on the backend — so `doc` keeps documents apart, it does not
// guard them from each other.
//
// The SDK therefore: makes up `doc` once per document; sends `ready` before anything else, as early as it can (the
// previous document's leftovers end with it); puts `doc` in every message; ignores messages for another `doc`.
//
// Methods. `ui.*`, `context.get` and `resources.unwatch` are answered by the window; the others go to the backend
// (`extension_call`), which checks each call against what the user granted to the extension. A method not listed here
// fails with `invalid`.
//
//   context.get()                         → HostContext
//   ui.openDetails(ref: ObjectRef)        → null       opens the details panel of the object (in the active cluster)
//   ui.navigate({page})                   → null       opens a page: one of the extension's own page ids, a page id of
//                                                      Sextant, or a table view (`kind:<group>/<Kind>`)
//   ui.notify({text})                     → null       a short notice in the window (at most 500 characters)
//   ui.close()                            → null       closes the frame's window (action) or dock tab
//   resources.unwatch({stream})           → null       stops a watch opened by `resources.watch`
//   clusters.list, kinds, resources.list/get/watch/apply/patch/delete, logs.tail, secret.value, storage.get/set/remove
//                                                      backend methods (`src-tauri/src/extensions/api.rs`)
//
// The host sends the frame no object data of its own: the context names the selected objects (`selection`) and the
// shown object's `resourceVersion`; the frame reads them through `resources.get` / `resources.watch`, which the
// backend checks against the extension's permissions.
import type { ClusterId, ErrorCode, ObjectRef } from "../api";

/** The protocol (and extension API) major version carried by every message. */
export const PROTOCOL_VERSION = 1;

/** Where a frame is shown; also the `view` query parameter of its URL. */
export type FrameView = "page" | "details" | "action" | "dock" | "settings";

/** The views by name (for JSX props). */
export const VIEW = {
  page: "page",
  details: "details",
  action: "action",
  dock: "dock",
  settings: "settings",
} as const satisfies Record<FrameView, FrameView>;

/** The contribution id of the settings section (`contributes.settings` has none of its own). */
export const SETTINGS_CONTRIBUTION = "settings";

export type RequestId = string | number;

export interface RequestMessage {
  sextant: typeof PROTOCOL_VERSION;
  /** The document the message is from (frame → host) or for (host → frame). */
  doc: string;
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface ReadyMessage {
  sextant: typeof PROTOCOL_VERSION;
  /** The document the message is from (frame → host) or for (host → frame). */
  doc: string;
  type: "ready";
}

export interface ResizeMessage {
  sextant: typeof PROTOCOL_VERSION;
  /** The document the message is from (frame → host) or for (host → frame). */
  doc: string;
  type: "resize";
  height: number;
}

export interface FrameErrorMessage {
  sextant: typeof PROTOCOL_VERSION;
  /** The document the message is from (frame → host) or for (host → frame). */
  doc: string;
  type: "error";
  message: string;
}

/** What a frame may send. */
export type FrameMessage = RequestMessage | ReadyMessage | ResizeMessage | FrameErrorMessage;

export interface ProtocolError {
  code: ErrorCode;
  message: string;
}

export interface ResultMessage {
  sextant: typeof PROTOCOL_VERSION;
  /** The document the message is from (frame → host) or for (host → frame). */
  doc: string;
  id: RequestId;
  result: unknown;
}

export interface ErrorMessage {
  sextant: typeof PROTOCOL_VERSION;
  /** The document the message is from (frame → host) or for (host → frame). */
  doc: string;
  id: RequestId;
  error: ProtocolError;
}

export interface StreamMessage {
  sextant: typeof PROTOCOL_VERSION;
  /** The document the message is from (frame → host) or for (host → frame). */
  doc: string;
  /** The `id` of the `resources.watch` call. */
  stream: RequestId;
  /** A `WatchUpdate`: snapshot, delta, reconnecting, error or forbidden. */
  event: unknown;
}

export interface ContextMessage {
  sextant: typeof PROTOCOL_VERSION;
  /** The document the message is from (frame → host) or for (host → frame). */
  doc: string;
  type: "context";
  context: HostContext;
}

/** What the host sends. */
export type HostMessage = ResultMessage | ErrorMessage | StreamMessage | ContextMessage;

/** What a frame knows about where it is shown. */
export interface HostContext {
  apiVersion: typeof PROTOCOL_VERSION;
  extensionId: string;
  view: FrameView;
  /** The manifest id of the contribution the frame shows (`"settings"` for the settings section). */
  contribution: string;
  /** The cluster the frame is about (pass it as `clusterId` to the API); `null` when none is open. */
  clusterId: ClusterId | null;
  /**
   * The namespaces selected in Sextant's namespace filter for that cluster; `null` for all namespaces (and when no
   * cluster is open). It follows the filter: a new context comes when it changes.
   */
  namespaces: string[] | null;
  theme: "light" | "dark";
  /** UI language, e.g. `en`. */
  language: string;
  /** Sextant's CSS variables (`--color-*`, sizes, fonts) with their current values. */
  tokens: Record<string, string>;
  /** Details: the shown object; action: the objects it runs on; otherwise empty. */
  selection: ObjectRef[];
  /** Details: the shown object's `metadata.resourceVersion` (changes when the object changes); otherwise `null`. */
  resourceVersion: string | null;
}

/** Methods the backend serves (`METHODS` in `src-tauri/src/extensions/api.rs`). */
export const REMOTE_METHODS: readonly string[] = [
  "clusters.list",
  "kinds",
  "resources.list",
  "resources.get",
  "resources.watch",
  "resources.apply",
  "resources.patch",
  "resources.delete",
  "logs.tail",
  "secret.value",
  "storage.get",
  "storage.set",
  "storage.remove",
];

/** Methods the window answers itself. */
export const LOCAL_METHODS: readonly string[] = [
  "context.get",
  "ui.openDetails",
  "ui.navigate",
  "ui.notify",
  "ui.close",
  "resources.unwatch",
];

/** Longest `ui.notify` text shown. */
export const MAX_NOTICE_CHARS = 500;
/** Watches one document may keep open at once. */
export const MAX_STREAMS_PER_DOCUMENT = 32;
/**
 * Documents a frame may have going at once (a new one normally ends the old at the next load; one beyond the limit
 * ends the oldest that is neither current nor kept).
 */
export const MAX_DOCUMENTS_PER_FRAME = 8;
/** Tallest a frame may ask to be (`resize`). */
export const MAX_FRAME_HEIGHT = 5000;

/** The CSS variables a frame gets in `HostContext.tokens` (a versioned contract with the SDK). */
export const THEME_TOKENS: readonly string[] = [
  "--color-bg",
  "--color-rail",
  "--color-sidebar",
  "--color-main",
  "--color-panel",
  "--color-dock",
  "--color-dock-header",
  "--color-text",
  "--color-text-muted",
  "--color-border",
  "--color-hover",
  "--color-selected",
  "--color-accent",
  "--color-accent-text",
  "--color-danger",
  "--color-warning",
  "--color-success",
  "--shadow-panel",
  "--control-height",
  "--control-height-compact",
  "--control-font-size",
  "--icon-size",
  "--font-family",
  "--font-mono",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRequestId = (value: unknown): value is RequestId =>
  (typeof value === "string" && value.length > 0 && value.length <= 128) ||
  (typeof value === "number" && Number.isFinite(value));

/** What a document id looks like (`doc`). */
export const DOC_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** A frame's message, or `null` when it is not one (no `sextant: 1`, no valid `doc`, an unknown shape). */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!isRecord(data) || data.sextant !== PROTOCOL_VERSION) return null;
  const doc = data.doc;
  if (typeof doc !== "string" || !DOC_PATTERN.test(doc)) return null;
  const base = { sextant: PROTOCOL_VERSION, doc } as const;
  if (typeof data.method === "string" && isRequestId(data.id)) {
    return { ...base, id: data.id, method: data.method, params: data.params };
  }
  switch (data.type) {
    case "ready":
      return { ...base, type: "ready" };
    case "resize":
      return typeof data.height === "number" && Number.isFinite(data.height)
        ? { ...base, type: "resize", height: data.height }
        : null;
    case "error":
      return { ...base, type: "error", message: typeof data.message === "string" ? data.message : "" };
    default:
      return null;
  }
}

/** The URL a frame opens: the extension's entry with `view` and the contribution id. */
export function frameUrl(entryUrl: string, view: FrameView, contribution: string): string {
  const query = `view=${encodeURIComponent(view)}&id=${encodeURIComponent(contribution)}`;
  return `${entryUrl}${entryUrl.includes("?") ? "&" : "?"}${query}`;
}

/** The registry id of an extension's contribution: `ext:<extensionId>:<id>`. */
export function contributionKey(extensionId: string, id: string): `ext:${string}` {
  return `ext:${extensionId}:${id}`;
}

/** The prefix of every registry id of an extension's contributions. */
export function contributionPrefix(extensionId: string): string {
  return `ext:${extensionId}:`;
}
