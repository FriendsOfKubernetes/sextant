// The host side of the extension message protocol (src/extensions/protocol.ts) for one frame: it accepts messages
// only from that frame's own window, only with `sextant: 1` and a document id (`doc`), answers `ui.*`, `context.get`
// and `resources.unwatch` itself, sends the rest to the backend as the extension (`extension_call`), and streams
// `resources.watch` updates through `openStream`. Calls, ids and watches are kept per document, and every answer goes
// to the document that asked. A load of the frame ends the documents that are gone; `dispose` (the frame goes away)
// ends all of them.
import { api, events, openStream, toApiError, type ErrorCode } from "../api";
import {
  LOCAL_METHODS,
  MAX_DOCUMENTS_PER_FRAME,
  MAX_FRAME_HEIGHT,
  MAX_STREAMS_PER_DOCUMENT,
  PROTOCOL_VERSION,
  REMOTE_METHODS,
  parseFrameMessage,
  type HostContext,
  type HostMessage,
  type RequestId,
  type RequestMessage,
} from "./protocol";

/** What the window does for `ui.*`; a handler throws (an `ApiError`) to answer with an error. */
export interface BridgeUi {
  openDetails(ref: unknown): void;
  navigate(params: unknown): void;
  notify(params: unknown): void;
  close(): void;
}

export interface BridgeOptions {
  extensionId: string;
  /** The frame's window (`iframe.contentWindow`): messages from any other window are ignored. */
  frame: () => Window | null;
  /** The context as it is now. */
  context: () => HostContext;
  ui: BridgeUi;
  /** The frame asks to be `height` pixels tall (already limited to `MAX_FRAME_HEIGHT`). */
  onResize?: (height: number) => void;
  /** The frame reports an uncaught error. */
  onFrameError?: (message: string) => void;
}

export interface Bridge {
  /** The host window's `message` listener. */
  handle(event: MessageEvent): void;
  /** Sends the current context to the document that said `ready` last. */
  pushContext(): void;
  /** The frame's `load` event: at every load after the first, documents that are gone end (protocol.ts, "Documents"). */
  frameLoaded(): void;
  /** Closes the frame's streams; nothing is sent to the frame any more. */
  dispose(): void;
}

class ProtocolFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const LOCAL: ReadonlySet<string> = new Set(LOCAL_METHODS);
const REMOTE: ReadonlySet<string> = new Set(REMOTE_METHODS);
/** Ended documents remembered, so their late messages are ignored. */
const MAX_ENDED = 64;

/** One document in the frame: its open watches by the id of the call that opened them. */
interface Doc {
  streams: Map<string, () => void>;
}

export function createBridge(options: BridgeOptions): Bridge {
  const { extensionId } = options;
  let disposed = false;
  const docs = new Map<string, Doc>();
  const ended: string[] = [];
  // The document that said `ready` last (gets the context), and the one that said it since the last load.
  let current: string | null = null;
  let readySinceLoad: string | null = null;
  // The document the last load kept. It may be the new document (its `ready` came before the load) or the previous
  // one that said `ready` late (after its own load): a `ready` of any other document then ends it.
  let kept: string | null = null;
  let loads = 0;
  const streamKey = (id: RequestId) => `${typeof id}:${id}`;

  /** Sends `message` if the document it is for is still going. */
  const post = (message: HostMessage) => {
    if (disposed || !docs.has(message.doc)) return;
    // A sandboxed frame without `allow-same-origin` has an opaque origin: "*" is the only target that reaches it.
    options.frame()?.postMessage(message, "*");
  };
  const reply = (doc: string, id: RequestId, result: unknown) =>
    post({ sextant: PROTOCOL_VERSION, doc, id, result: result === undefined ? null : result });
  const fail = (doc: string, id: RequestId, err: unknown) => {
    const error =
      err instanceof ProtocolFailure ? { code: err.code, message: err.message } : toProtocolError(err);
    post({ sextant: PROTOCOL_VERSION, doc, id, error });
  };
  const pushContext = () => {
    if (current) post({ sextant: PROTOCOL_VERSION, doc: current, type: "context", context: options.context() });
  };

  /** Ends a document: its watches close, answers on their way to it are dropped, its later messages ignored. */
  const end = (doc: string) => {
    const state = docs.get(doc);
    if (!state) return;
    docs.delete(doc);
    for (const close of state.streams.values()) close();
    ended.push(doc);
    if (ended.length > MAX_ENDED) ended.shift();
    if (current === doc) current = null;
    if (readySinceLoad === doc) readySinceLoad = null;
    if (kept === doc) kept = null;
  };

  /** The document's state, started by its first message; `null` for one that ended or one too many. */
  const docOf = (doc: string): Doc | null => {
    const known = docs.get(doc);
    if (known) return known;
    if (ended.includes(doc) || docs.size >= MAX_DOCUMENTS_PER_FRAME) return null;
    const state: Doc = { streams: new Map() };
    docs.set(doc, state);
    return state;
  };

  const local = (doc: Doc, request: RequestMessage): unknown => {
    const { ui } = options;
    switch (request.method) {
      case "context.get":
        return options.context();
      case "ui.openDetails":
        return ui.openDetails(request.params);
      case "ui.navigate":
        return ui.navigate(request.params);
      case "ui.notify":
        return ui.notify(request.params);
      case "ui.close":
        return ui.close();
      case "resources.unwatch": {
        const stream = (request.params as { stream?: unknown } | null | undefined)?.stream;
        if (typeof stream !== "string" && typeof stream !== "number") {
          throw new ProtocolFailure("invalid", "resources.unwatch needs {stream}: the id of the resources.watch call");
        }
        const close = doc.streams.get(streamKey(stream));
        doc.streams.delete(streamKey(stream));
        close?.();
        return null;
      }
      default:
        throw new ProtocolFailure("invalid", `unknown method ${request.method}`);
    }
  };

  const watch = (doc: Doc, request: RequestMessage) => {
    const key = streamKey(request.id);
    const from = request.doc;
    if (doc.streams.has(key)) {
      fail(from, request.id, new ProtocolFailure("invalid", `a watch with id ${String(request.id)} is already open`));
      return;
    }
    if (doc.streams.size >= MAX_STREAMS_PER_DOCUMENT) {
      const message = `at most ${MAX_STREAMS_PER_DOCUMENT} watches may be open at once`;
      fail(from, request.id, new ProtocolFailure("invalid", message));
      return;
    }
    const close = openStream<unknown>({
      start: (streamId) => api.extensions.call(extensionId, "resources.watch", request.params, streamId),
      listen: (streamId, handler) => events.onExtWatch(streamId, handler),
      stop: (streamId) => api.extensions.watchStop(extensionId, streamId),
      onEvent: (event) => post({ sextant: PROTOCOL_VERSION, doc: from, stream: request.id, event }),
      onListening: () => reply(from, request.id, { stream: request.id }),
      onStartError: (err) => {
        if (doc.streams.get(key) === close) doc.streams.delete(key);
        fail(from, request.id, err);
      },
    });
    doc.streams.set(key, close);
  };

  const call = (doc: Doc, request: RequestMessage) => {
    const from = request.doc;
    if (LOCAL.has(request.method)) {
      try {
        reply(from, request.id, local(doc, request));
      } catch (err) {
        fail(from, request.id, err);
      }
      return;
    }
    if (!REMOTE.has(request.method)) {
      fail(from, request.id, new ProtocolFailure("invalid", `unknown method ${request.method}`));
      return;
    }
    if (request.method === "resources.watch") {
      watch(doc, request);
      return;
    }
    api.extensions.call(extensionId, request.method, request.params).then(
      (result) => reply(from, request.id, result),
      (err: unknown) => fail(from, request.id, err),
    );
  };

  return {
    handle(event) {
      if (disposed) return;
      const frame = options.frame();
      // Only the frame's own window: not the app, not another extension, not a window the frame opened or embeds.
      if (!frame || event.source !== frame) return;
      const message = parseFrameMessage(event.data);
      if (!message) return;
      const doc = docOf(message.doc);
      if (!doc) return;
      if ("method" in message) {
        call(doc, message);
        return;
      }
      switch (message.type) {
        case "ready":
          if (kept !== null && kept !== message.doc) end(kept);
          kept = null;
          current = message.doc;
          readySinceLoad = message.doc;
          pushContext();
          return;
        case "resize":
          options.onResize?.(Math.min(MAX_FRAME_HEIGHT, Math.max(0, Math.round(message.height))));
          return;
        case "error":
          options.onFrameError?.(message.message);
          return;
      }
    },
    pushContext,
    frameLoaded() {
      if (disposed) return;
      // A new document is in the frame: every document but the one that said `ready` since the previous load (the new
      // one, when it started before this load) is gone — an unloaded document sends nothing more.
      if (loads > 0) {
        for (const doc of [...docs.keys()]) if (doc !== readySinceLoad) end(doc);
        kept = readySinceLoad;
      }
      loads++;
      readySinceLoad = null;
      pushContext();
    },
    dispose() {
      if (disposed) return;
      for (const doc of [...docs.keys()]) end(doc);
      disposed = true;
    },
  };
}

function toProtocolError(err: unknown): { code: ErrorCode; message: string } {
  const error = toApiError(err);
  return { code: error.code, message: error.message };
}
