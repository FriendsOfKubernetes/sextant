// The one place that owns the order of a backend stream's life (watch, logs, terminal sessions):
//
//   id = crypto.randomUUID() → listen (`<event>:<id>`) → start (`*_start(…, id)`) → onListening → … → unlisten → stop
//
// The window chooses the id and listens before the backend starts the stream, so the backend sends output as soon as
// it has some and nothing is lost (interfaces.md §1). Closing at any point leaves nothing behind: a stream whose start
// is still in flight is stopped once it answers, a listener attached after the close is removed, and no callback
// runs after the close. Streams wait for `resetStreams` (once per page load) before they listen.
import { streams } from "./commands";
import type { Unsubscribe } from "./transport";

export interface StreamSpec<T> {
  /** Starts the stream under `id` (chosen here; its events are already listened to). Rejects if it cannot start. */
  start: (id: string) => Promise<unknown>;
  /** Subscribes to the stream's events (e.g. `events.onLogs`). */
  listen: (id: string, handler: (payload: T) => void) => Promise<Unsubscribe>;
  /** Stops the stream (e.g. `api.logs.stop`); its failure is ignored. */
  stop: (id: string) => Promise<unknown>;
  /** One event of the stream; may come before `onListening`. */
  onEvent: (payload: T) => void;
  /** The stream was started and its events are being received. */
  onListening?: (id: string) => void;
  /** The start failed (the stream does not exist). */
  onStartError?: (err: unknown) => void;
}

/** A fresh stream id: a UUID, which is safe in event names. */
export function newStreamId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Older engines without `randomUUID`: the same format from random bytes (RFC 9562, version 4).
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let streamsReady: Promise<void> = Promise.resolve();
let resetRequested = false;

/**
 * Stops the streams and terminal sessions an earlier page of this window left in the backend (`streams_reset`; a
 * reloaded page cannot see them any more). Runs once per page load; streams opened meanwhile wait for it. A failure
 * is ignored: the page works, the old streams just keep running.
 */
export function resetStreams(): Promise<void> {
  if (!resetRequested) {
    resetRequested = true;
    streamsReady = streams.reset().then(
      () => undefined,
      () => undefined,
    );
  }
  return streamsReady;
}

/** Forgets that the streams were reset (a new backend in tests). */
export function resetStreamsState(): void {
  resetRequested = false;
  streamsReady = Promise.resolve();
}

/** Opens the stream; the returned function closes it (idempotent). */
export function openStream<T>(spec: StreamSpec<T>): () => void {
  const id = newStreamId();
  let closed = false;
  let unlisten: Unsubscribe | null = null;
  // Resolves to whether the backend runs the stream (set once the start was sent).
  let running: Promise<boolean> | null = null;

  const stop = () => void spec.stop(id).catch(() => undefined);
  const fail = (err: unknown) => {
    if (!closed) spec.onStartError?.(err);
  };

  void (async () => {
    await streamsReady;
    if (closed) return;
    let off: Unsubscribe;
    try {
      off = await spec.listen(id, (payload) => {
        if (!closed) spec.onEvent(payload);
      });
    } catch (err) {
      fail(err);
      return;
    }
    // Closed while subscribing: nothing was started.
    if (closed) {
      off();
      return;
    }
    unlisten = off;
    running = spec.start(id).then(
      () => true,
      (err: unknown) => {
        // A close already unlistened.
        unlisten?.();
        unlisten = null;
        fail(err);
        return false;
      },
    );
    if ((await running) && !closed) spec.onListening?.(id);
  })();

  return () => {
    if (closed) return;
    closed = true;
    unlisten?.();
    unlisten = null;
    // A start still in flight is stopped once it answers.
    void running?.then((started) => {
      if (started) stop();
    });
  };
}
