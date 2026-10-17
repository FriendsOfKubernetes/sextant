// The text of a log tab: the newest lines, bounded by count and by size so a chatty pod cannot grow the window
// without limit.
//
// The lines sit in chunks of `CHUNK` lines; every chunk but the last is full and never changes, so appending a
// batch copies only the list of chunks and the last, partial chunk — not every line — and buffers stay immutable
// (an older buffer still reads the same lines).

/** Lines kept per log tab; older ones are discarded and counted. */
export const LOG_BUFFER_LIMIT = 100_000;
/** Characters (UTF-16 code units) of text kept per log tab; older lines are discarded and counted. */
export const LOG_BUFFER_TEXT_LIMIT = 32 * 1024 * 1024;

/** Lines per chunk. */
const CHUNK = 1024;

/** What a buffer holds: plain lines, or entries carrying their text (the merged view of several pods). */
export type LogItem = string | { readonly text: string };

function lengthOf(item: LogItem): number {
  return typeof item === "string" ? item.length : item.text.length;
}

/** An immutable, indexable list of log lines (or entries with a `text`). */
export class LogLines<T extends LogItem = string> {
  static readonly EMPTY = new LogLines<never>([], 0, 0, 0);

  /** A list holding `items` (no limits applied). */
  static of<T extends LogItem>(items: readonly T[]): LogLines<T> {
    return (LogLines.EMPTY as LogLines<T>).append(items, Infinity, Infinity).lines;
  }

  private constructor(
    /** Full chunks of `CHUNK` lines, then the last one (maybe partial). */
    private readonly chunks: readonly (readonly T[])[],
    /** Discarded lines at the start of the first chunk. */
    private readonly skip: number,
    readonly length: number,
    /** Characters of all the lines. */
    readonly size: number,
  ) {}

  /** The line at `index` (0 is the oldest kept), `undefined` outside the list. */
  at(index: number): T | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return undefined;
    const i = index + this.skip;
    return this.chunks[Math.floor(i / CHUNK)]![i % CHUNK];
  }

  /** A fresh array of the lines. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.length; i++) out.push(this.at(i)!);
    return out;
  }

  /** These lines plus `batch`, then the oldest dropped until at most `limit` lines and `maxSize` characters are
   * left (the newest line always stays). */
  append(batch: readonly T[], limit: number, maxSize: number): { lines: LogLines<T>; dropped: number } {
    const chunks = this.chunks.slice();
    let skip = this.skip;
    let length = this.length;
    let size = this.size;
    // The last chunk is shared with this buffer: copy it before adding to it.
    let last: T[] | undefined;
    const tail = chunks[chunks.length - 1];
    if (tail && tail.length < CHUNK) {
      last = tail.slice();
      chunks[chunks.length - 1] = last;
    }
    for (const line of batch) {
      if (!last || last.length === CHUNK) {
        last = [];
        chunks.push(last);
      }
      last.push(line);
      length++;
      size += lengthOf(line);
    }
    let dropped = 0;
    while (length > 1 && (length > limit || size > maxSize)) {
      const first = chunks[0]!;
      size -= lengthOf(first[skip]!);
      skip++;
      length--;
      dropped++;
      if (skip === first.length) {
        chunks.shift();
        skip = 0;
      }
    }
    return { lines: new LogLines(chunks, skip, length, size), dropped };
  }
}

export interface LogBuffer<T extends LogItem = string> {
  lines: LogLines<T>;
  /** How many older lines were discarded to stay within the limits. */
  dropped: number;
}

export const EMPTY_BUFFER: LogBuffer = Object.freeze({ lines: LogLines.EMPTY, dropped: 0 }) as LogBuffer;

/** A buffer holding `lines` (for tests and callers that start from an array). */
export function bufferOf(lines: readonly string[], dropped = 0): LogBuffer {
  return { lines: LogLines.of(lines), dropped };
}

/**
 * `buffer` plus `batch`, cut to the newest `limit` lines and at most `maxSize` characters of text. Never mutates
 * its arguments; the cost is the batch plus a few hundred references, not the whole buffer.
 */
export function appendLines<T extends LogItem = string>(
  buffer: LogBuffer<T>,
  batch: readonly T[],
  limit = LOG_BUFFER_LIMIT,
  maxSize = LOG_BUFFER_TEXT_LIMIT,
): LogBuffer<T> {
  if (batch.length === 0) return buffer;
  const { lines, dropped } = buffer.lines.append(batch, limit, maxSize);
  return { lines, dropped: buffer.dropped + dropped };
}

/** `lines` with the ones at the indices in `cut` (cut by the backend at its line cap) ending in `marker`. */
export function markCutLines(lines: readonly string[], cut: readonly number[] | undefined, marker: string): readonly string[] {
  if (!cut || cut.length === 0) return lines;
  const out = lines.slice();
  for (const i of cut) if (i >= 0 && i < out.length) out[i] = `${out[i]}${marker}`;
  return out;
}
