// The one place that owns the order of a backend stream's life (watch, logs, terminal sessions):
//
//   start (`*_start` → id) → listen (`<event>:<id>`) → onListening → … → unlisten → stop (`*_stop`)
//
// The window can listen to `<event>:<id>` only after the start answered; the backend holds the first output back
// until then (interfaces.md, «Правило для стримов»). Closing at any point leaves nothing behind: a stream that
// started after the close is stopped at once, a listener attached after it is removed, and no callback runs after
// the close.
import type { Unsubscribe } from "./transport";

export interface StreamSpec<T> {
  /** Starts the stream; resolves to its id. */
  start: () => Promise<string>;
  /** Subscribes to the stream's events (e.g. `events.onLogs`). */
  listen: (id: string, handler: (payload: T) => void) => Promise<Unsubscribe>;
  /** Stops the stream (e.g. `api.logs.stop`); its failure is ignored. */
  stop: (id: string) => Promise<unknown>;
  /** One event of the stream. */
  onEvent: (payload: T) => void;
  /** The stream runs and its events are being received. */
  onListening?: (id: string) => void;
  /** The start failed (the stream does not exist). */
  onStartError?: (err: unknown) => void;
}

/** Opens the stream; the returned function closes it (idempotent). */
export function openStream<T>(spec: StreamSpec<T>): () => void {
  let closed = false;
  let id: string | null = null;
  let unlisten: Unsubscribe | null = null;

  const stop = (streamId: string) => void spec.stop(streamId).catch(() => undefined);

  spec.start().then(
    async (started) => {
      if (closed) {
        stop(started);
        return;
      }
      id = started;
      const off = await spec.listen(started, (payload) => {
        if (!closed) spec.onEvent(payload);
      });
      // Closed while subscribing: the close already stopped the stream.
      if (closed) {
        off();
        return;
      }
      unlisten = off;
      spec.onListening?.(started);
    },
    (err: unknown) => {
      if (!closed) spec.onStartError?.(err);
    },
  );

  return () => {
    if (closed) return;
    closed = true;
    unlisten?.();
    if (id) stop(id);
  };
}
