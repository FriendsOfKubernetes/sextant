// The text of a log tab: the newest lines, bounded so a chatty pod cannot grow the window without limit.

/** Lines kept per log tab; older ones are discarded and counted. */
export const LOG_BUFFER_LIMIT = 100_000;

export interface LogBuffer {
  lines: string[];
  /** How many older lines were discarded to stay within the limit. */
  dropped: number;
}

export const EMPTY_BUFFER: LogBuffer = Object.freeze({ lines: [], dropped: 0 }) as LogBuffer;

/** `buffer` plus `batch`, cut to the newest `limit` lines. Never mutates its arguments. */
export function appendLines(buffer: LogBuffer, batch: readonly string[], limit = LOG_BUFFER_LIMIT): LogBuffer {
  if (batch.length === 0) return buffer;
  const total = buffer.lines.length + batch.length;
  if (total <= limit) return { lines: buffer.lines.concat(batch), dropped: buffer.dropped };
  const overflow = total - limit;
  const lines =
    overflow >= buffer.lines.length
      ? batch.slice(overflow - buffer.lines.length)
      : buffer.lines.slice(overflow).concat(batch);
  return { lines, dropped: buffer.dropped + overflow };
}
