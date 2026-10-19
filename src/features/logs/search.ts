// Searching the log text: case-insensitive substring matches in the visible text of each line (without ANSI escape
// codes, line breaks as `\n`; see ansi.ts), so what is found is what the reader sees.
import { visibleText } from "./ansi";

export interface LogMatch {
  /** Index into the buffer's lines. */
  line: number;
  /** Offset of the match inside the line. */
  start: number;
}

/** More matches than this are not tracked (the counter shows the cap). */
export const MAX_MATCHES = 10_000;

/** Lines that can be read by index: an array or the log buffer's `LogLines`. */
export interface IndexedLines {
  readonly length: number;
  at(index: number): string | undefined;
}

/** Every occurrence of `query` in `lines`, in reading order, up to [`MAX_MATCHES`]. */
export function findMatches(lines: IndexedLines, query: string): LogMatch[] {
  return new MatchIndex().update(lines, 0, query, "");
}

/**
 * The matches of a query in a log buffer that grows at the end and drops lines at the start: each line is read (and
 * its escape codes parsed) once, when it first shows up, not on every batch. A new `generation` (another stream)
 * or query starts over.
 */
export class MatchIndex {
  private key: string | null = null;
  /** Matches by absolute line (`dropped` + index), from `head` on. */
  private found: LogMatch[] = [];
  private head = 0;
  /** Absolute index of the first line not read yet. */
  private scanned = 0;

  /** The matches in `lines` (whose first line is absolute line `dropped`), indexed into `lines`. */
  update(lines: IndexedLines, dropped: number, query: string, generation: string): LogMatch[] {
    const needle = query.toLowerCase();
    if (!needle) return [];
    const key = `${generation}\u0000${needle}`;
    const end = dropped + lines.length;
    if (key !== this.key || end < this.scanned) {
      this.key = key;
      this.found = [];
      this.head = 0;
      this.scanned = dropped;
    }
    const found = this.found;
    while (this.head < found.length && found[this.head]!.line < dropped) this.head++;
    if (this.head > 4096 && this.head * 2 > found.length) {
      found.splice(0, this.head);
      this.head = 0;
    }
    // Past the cap nothing more is read; reading goes on once older matches are discarded. A line is read whole,
    // so the list may pass the cap by one line's matches (the result is cut).
    for (let abs = Math.max(this.scanned, dropped); abs < end && found.length - this.head < MAX_MATCHES; abs++) {
      const haystack = visibleText(lines.at(abs - dropped) ?? "").toLowerCase();
      for (let from = 0; ; ) {
        const start = haystack.indexOf(needle, from);
        if (start < 0) break;
        found.push({ line: abs, start });
        from = start + needle.length;
      }
      this.scanned = abs + 1;
    }
    if (this.scanned < dropped) this.scanned = dropped;
    const out: LogMatch[] = [];
    for (let i = this.head; i < found.length && out.length < MAX_MATCHES; i++) {
      out.push({ line: found[i]!.line - dropped, start: found[i]!.start });
    }
    return out;
  }
}

/** The offsets of every match of `query` in `text` (already visible text), for highlighting. */
export function matchRanges(text: string, query: string): { start: number; end: number }[] {
  const needle = query.toLowerCase();
  const ranges: { start: number; end: number }[] = [];
  if (!needle) return ranges;
  const haystack = text.toLowerCase();
  for (let from = 0; ; ) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    ranges.push({ start, end: start + needle.length });
    from = start + needle.length;
  }
  return ranges;
}
