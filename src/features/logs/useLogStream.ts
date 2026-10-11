// One log stream of a dock tab: starts it, collects the batches into the bounded buffer, stops it on cleanup.
//
// Starting the stream is `api.logs.start`, which answers with the stream id; the window can listen to
// `logs:<id>` only afterwards, and the backend holds the first batch back long enough for that.
import { useCallback, useEffect, useState } from "react";
import { api, events, toApiError, type ApiError, type ClusterId, type LogOptions, type ObjectRef } from "../../api";
import { appendLines, EMPTY_BUFFER, type LogBuffer } from "./buffer";

export type LogStatus = "connecting" | "streaming" | "ended" | "error";

export interface LogStreamState {
  buffer: LogBuffer;
  status: LogStatus;
  error?: ApiError;
}

const INITIAL: LogStreamState = Object.freeze({ buffer: EMPTY_BUFFER, status: "connecting" }) as LogStreamState;

export interface UseLogStream extends LogStreamState {
  /** Starts a new stream with the same options (after "Stream ended" or an error). The text is cleared. */
  reconnect: () => void;
}

/**
 * Streams the logs of `pod`. A different cluster, pod or option (or `reconnect`) stops the stream, empties the
 * buffer and starts another one; unmounting stops it.
 */
export function useLogStream(clusterId: ClusterId, pod: ObjectRef, options: LogOptions): UseLogStream {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([clusterId, pod, options, attempt]);
  // Keyed state: a new key starts from "connecting" in the same render, with an empty buffer.
  const [state, setState] = useState<{ key: string; value: LogStreamState }>({ key, value: INITIAL });

  useEffect(() => {
    const [cluster, podRef, logOptions] = JSON.parse(key) as [ClusterId, ObjectRef, LogOptions];
    let cancelled = false;
    let streamId: string | null = null;
    let unlisten: (() => void) | null = null;
    const update = (fn: (s: LogStreamState) => LogStreamState) =>
      setState((prev) => ({ key, value: fn(prev.key === key ? prev.value : INITIAL) }));

    api.logs.start(cluster, podRef, logOptions).then(
      async (id) => {
        if (cancelled) {
          void api.logs.stop(id).catch(() => undefined);
          return;
        }
        streamId = id;
        update((s) => ({ ...s, status: "streaming" }));
        const off = await events.onLogs(id, (u) => {
          if (cancelled) return;
          switch (u.type) {
            case "lines":
              update((s) => ({ ...s, buffer: appendLines(s.buffer, u.lines) }));
              break;
            case "ended":
              update((s) => (s.status === "error" ? s : { ...s, status: "ended" }));
              break;
            case "error":
              update((s) => ({ ...s, status: "error", error: toApiError(u) }));
              break;
          }
        });
        if (cancelled) off();
        else unlisten = off;
      },
      (err: unknown) => {
        if (!cancelled) update((s) => ({ ...s, status: "error", error: toApiError(err) }));
      },
    );

    return () => {
      cancelled = true;
      unlisten?.();
      if (streamId) void api.logs.stop(streamId).catch(() => undefined);
    };
  }, [key]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  const value = state.key === key ? state.value : INITIAL;
  return { ...value, reconnect };
}
