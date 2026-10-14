// The messages between Sextant (the window) and an extension's frame, as the frame sees them. Sextant's side is
// `src/extensions/protocol.ts` (the source of truth); `test/types.test.ts` and `test/protocol.test.ts` keep this copy
// equal to it.
import type { ClusterId } from "./generated/ClusterId";
import type { ErrorCode } from "./generated/ErrorCode";
import type { ObjectRef } from "./generated/ObjectRef";

/** The protocol (and extension API) major version carried by every message. */
export const PROTOCOL_VERSION = 1;

/** Where a frame is shown; also the `view` query parameter of its URL. */
export type FrameView = "page" | "details" | "action" | "dock" | "settings";

export type RequestId = string | number;

/** What the frame knows about where it is shown. */
export interface HostContext {
  apiVersion: typeof PROTOCOL_VERSION;
  extensionId: string;
  view: FrameView;
  /** The manifest id of the contribution the frame shows (`"settings"` for the settings section). */
  contribution: string;
  /** The cluster the frame is about (the API's default `clusterId`); `null` when none is open. */
  clusterId: ClusterId | null;
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

export interface ProtocolError {
  code: ErrorCode;
  message: string;
}

/** Frame → window. */
export type FrameMessage =
  | { sextant: typeof PROTOCOL_VERSION; doc: string; type: "ready" }
  | { sextant: typeof PROTOCOL_VERSION; doc: string; id: RequestId; method: string; params?: unknown }
  | { sextant: typeof PROTOCOL_VERSION; doc: string; type: "resize"; height: number }
  | { sextant: typeof PROTOCOL_VERSION; doc: string; type: "error"; message: string };

/** Window → frame. */
export type HostMessage =
  | { sextant: typeof PROTOCOL_VERSION; doc: string; id: RequestId; result: unknown }
  | { sextant: typeof PROTOCOL_VERSION; doc: string; id: RequestId; error: ProtocolError }
  | { sextant: typeof PROTOCOL_VERSION; doc: string; stream: RequestId; event: unknown }
  | { sextant: typeof PROTOCOL_VERSION; doc: string; type: "context"; context: HostContext };

/** Methods the backend serves (each checked against what the user granted the extension). */
export const REMOTE_METHODS = [
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
] as const;

/** Methods the window answers itself. */
export const LOCAL_METHODS = [
  "context.get",
  "ui.openDetails",
  "ui.navigate",
  "ui.notify",
  "ui.close",
  "resources.unwatch",
] as const;

export type MethodName = (typeof REMOTE_METHODS)[number] | (typeof LOCAL_METHODS)[number];

/** What a document id looks like (`doc`). */
export const DOC_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** Longest `ui.notify` text Sextant shows. */
export const MAX_NOTICE_CHARS = 500;
/** Watches one document may keep open at once. */
export const MAX_STREAMS_PER_DOCUMENT = 32;
/** Tallest a frame may ask to be (`resize`). */
export const MAX_FRAME_HEIGHT = 5000;

/** The CSS variables Sextant sends in `HostContext.tokens`. */
export const THEME_TOKENS = [
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
] as const;
