// Searching the log text: case-insensitive substring matches.

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
  const needle = query.toLowerCase();
  const found: LogMatch[] = [];
  if (!needle) return found;
  for (let line = 0; line < lines.length && found.length < MAX_MATCHES; line++) {
    const haystack = (lines.at(line) ?? "").toLowerCase();
    let from = 0;
    for (;;) {
      const start = haystack.indexOf(needle, from);
      if (start < 0) break;
      found.push({ line, start });
      if (found.length >= MAX_MATCHES) break;
      from = start + needle.length;
    }
  }
  return found;
}

export interface LinePart {
  text: string;
  match: boolean;
}

/** `text` cut into plain and matching parts, for highlighting. */
export function splitLine(text: string, query: string): LinePart[] {
  const needle = query.toLowerCase();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLowerCase();
  const parts: LinePart[] = [];
  let from = 0;
  for (;;) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    if (start > from) parts.push({ text: text.slice(from, start), match: false });
    parts.push({ text: text.slice(start, start + needle.length), match: true });
    from = start + needle.length;
  }
  if (from < text.length || parts.length === 0) parts.push({ text: text.slice(from), match: false });
  return parts;
}
