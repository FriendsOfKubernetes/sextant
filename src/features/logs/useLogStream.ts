// One log stream of a dock tab: starts it, collects the batches into the bounded buffer, stops it on cleanup.
//
// `openStream` chooses the stream id and creates the channel of its batches before `api.logs.start(…, id, channel)`,
// so the first batch the backend sends is never lost.
import { useCallback, useEffect, useState } from "react";
import {
  api,
  openStream,
  toApiError,
  type ApiError,
  type ClusterId,
  type LogOptions,
  type LogUpdate,
  type ObjectRef,
} from "../../api";
import { i18n } from "../../i18n";
import { appendLines, EMPTY_BUFFER, markCutLines, type LogBuffer } from "./buffer";

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
    const update = (fn: (s: LogStreamState) => LogStreamState) =>
      setState((prev) => ({ key, value: fn(prev.key === key ? prev.value : INITIAL) }));

    return openStream<LogUpdate>({
      start: (id, channel) => api.logs.start(cluster, podRef, logOptions, id, channel),
      stop: api.logs.stop,
      // Events may arrive before the subscription is confirmed: only a stream still "connecting" becomes "streaming".
      onListening: () => update((s) => (s.status === "connecting" ? { ...s, status: "streaming" } : s)),
      onEvent: (u) => {
        switch (u.type) {
          case "lines": {
            // A line the backend cut at its cap goes on as the next line; the marker says so.
            const lines = markCutLines(u.lines, u.cut, i18n.t("logs:lineCut"));
            update((s) => ({ ...s, buffer: appendLines(s.buffer, lines) }));
            break;
          }
          case "ended":
            update((s) => (s.status === "error" ? s : { ...s, status: "ended" }));
            break;
          case "error":
            update((s) => ({ ...s, status: "error", error: toApiError(u) }));
            break;
        }
      },
      onStartError: (err) => update((s) => ({ ...s, status: "error", error: toApiError(err) })),
    });
  }, [key]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);
  const value = state.key === key ? state.value : INITIAL;
  return { ...value, reconnect };
}
