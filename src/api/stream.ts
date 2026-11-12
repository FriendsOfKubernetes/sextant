// The one place that owns the order of a backend stream's life (watch, logs, terminal sessions, extension watches,
// GitOps installs, file transfers):
//
//   id = crypto.randomUUID() → channel → start (`*_start(…, id, onEvent: channel)`) → onListening → … → close → stop
//
// The window chooses the id and creates the channel the backend sends the stream's payloads through (a Tauri
// `Channel`, not an event: ADR-0078) before it starts the stream, so the backend sends output as soon as it has some
// and nothing is lost (interfaces.md §1). Closing at any point leaves nothing behind: a stream whose start is still in
// flight is stopped once it answers, the channel stops delivering at once, and no callback runs after the close.
// Streams wait for `resetStreams` (once per page load) before they start.
//
// The window acknowledges what it received (ADR-0170): a stream's backend may be at most `MAX_UNACKED` payloads ahead
// of the window, so a page that does not run (a minimized or suspended web view) holds the streams back instead of
// letting Tauri's queue of undelivered payloads grow in the backend. `openStream` counts the payloads it hands to
// `onEvent` and tells the backend the counts (`streams_ack`), batched: at most every `ACK_INTERVAL_MS` while a stream
// has payloads not yet acknowledged, and at once when one stream reaches half of `MAX_UNACKED`.
import { streams } from "./commands";
import { streamChannel, type StreamChannel } from "./transport";

export interface StreamSpec<T> {
  /**
   * Starts the stream under `id` (chosen here), its payloads sent through `channel` (the command's `onEvent`).
   * Rejects if it cannot start.
   */
  start: (id: string, channel: StreamChannel<T>) => Promise<unknown>;
  /** Stops the stream (e.g. `api.logs.stop`); its failure is ignored. */
  stop: (id: string) => Promise<unknown>;
  /** One payload of the stream; may come before `onListening`. */
  onEvent: (payload: T) => void;
  /** The stream was started and its payloads are being received. */
  onListening?: (id: string) => void;
  /** The start failed (the stream does not exist). */
  onStartError?: (err: unknown) => void;
}

/** A fresh stream id: a UUID, which is safe in stream ids (`[A-Za-z0-9_-]`). */
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

/** Payloads a stream may send ahead of the window's acknowledgements; equal to `streams::MAX_UNACKED` in Rust. */
export const MAX_UNACKED = 32;
/** How long acknowledgements wait to be sent together. */
export const ACK_INTERVAL_MS = 250;
/** A stream with this many payloads not yet acknowledged is acknowledged at once. */
export const ACK_AT_ONCE = MAX_UNACKED / 2;

// Per open stream: payloads received in all, and those not acknowledged yet.
const received = new Map<string, number>();
const unacked = new Map<string, number>();
let ackTimer: ReturnType<typeof setTimeout> | null = null;

/** Sends the counts of the streams with payloads not acknowledged yet (a failure is ignored: the next one says it). */
function sendAcks(): void {
  if (ackTimer !== null) {
    clearTimeout(ackTimer);
    ackTimer = null;
  }
  if (unacked.size === 0) return;
  const acks: Record<string, number> = {};
  for (const id of unacked.keys()) acks[id] = received.get(id) ?? 0;
  unacked.clear();
  void streams.ack(acks).catch(() => undefined);
}

/** One more payload of the open stream `id` was handed to its `onEvent`. */
function countPayload(id: string): void {
  received.set(id, (received.get(id) ?? 0) + 1);
  const waiting = (unacked.get(id) ?? 0) + 1;
  unacked.set(id, waiting);
  if (waiting >= ACK_AT_ONCE) sendAcks();
  else ackTimer ??= setTimeout(sendAcks, ACK_INTERVAL_MS);
}

/** The stream `id` was closed: nothing of it is acknowledged any more. */
function forgetPayloads(id: string): void {
  received.delete(id);
  unacked.delete(id);
  if (unacked.size === 0 && ackTimer !== null) {
    clearTimeout(ackTimer);
    ackTimer = null;
  }
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

/** Forgets that the streams were reset and what was acknowledged (a new backend in tests). */
export function resetStreamsState(): void {
  resetRequested = false;
  streamsReady = Promise.resolve();
  received.clear();
  unacked.clear();
  if (ackTimer !== null) clearTimeout(ackTimer);
  ackTimer = null;
}

/** Opens the stream; the returned function closes it (idempotent). */
export function openStream<T>(spec: StreamSpec<T>): () => void {
  const id = newStreamId();
  let closed = false;
  let channel: StreamChannel<T> | null = null;
  // Resolves to whether the backend runs the stream (set once the start was sent).
  let running: Promise<boolean> | null = null;

  const stop = () => void spec.stop(id).catch(() => undefined);
  const fail = (err: unknown) => {
    if (!closed) spec.onStartError?.(err);
  };

  void (async () => {
    await streamsReady;
    if (closed) return;
    let own: StreamChannel<T>;
    try {
      own = streamChannel<T>((payload) => {
        if (closed) return;
        countPayload(id);
        spec.onEvent(payload);
      });
    } catch (err) {
      fail(err);
      return;
    }
    channel = own;
    running = spec.start(id, own).then(
      () => true,
      (err: unknown) => {
        // Unless a close already closed it.
        channel?.close();
        channel = null;
        forgetPayloads(id);
        fail(err);
        return false;
      },
    );
    if ((await running) && !closed) spec.onListening?.(id);
  })();

  return () => {
    if (closed) return;
    closed = true;
    channel?.close();
    channel = null;
    forgetPayloads(id);
    // A start still in flight is stopped once it answers.
    void running?.then((started) => {
      if (started) stop();
    });
  };
}
