// One log entry as React nodes: the text without escape codes, ANSI colours and styles as classes (palette, drawn
// with theme tokens) or checked `rgb(…)` colours, search matches in `<mark>`, and line breaks inside the entry as
// line breaks (wrapped view) or as a small "↵" symbol (one line per entry). Only text nodes and fixed elements are
// made: nothing of the line is ever read as markup.
import type { CSSProperties, ReactNode } from "react";
import { hasSpecial, parseAnsi, type AnsiColour, type AnsiSegment, type AnsiStyle } from "./ansi";

/** A part of the visible text (offsets into `visibleText(raw)`), highlighted as a match. */
export interface TextRange {
  start: number;
  end: number;
  /** The current search match: drawn stronger. */
  current?: boolean;
}

export interface LogTextOptions {
  /** Draw ANSI colours and styles; `false` shows the plain text (the codes are dropped either way). */
  colours: boolean;
  /** `true`: a line break inside the entry breaks the line; `false`: it is shown as "↵". */
  wrap: boolean;
  /** The accessible name of the "↵" symbol. */
  lineBreakLabel: string;
  /** Matches to highlight, sorted and not overlapping; or a function giving them for the visible text (so the
   * line is parsed once). */
  ranges?: readonly TextRange[] | ((visible: string) => readonly TextRange[] | undefined);
}

/** The symbol of a line break in the one-line view. */
export const LINE_BREAK_SYMBOL = "↵";

function colourStyle(colour: AnsiColour, background: boolean): string | CSSProperties {
  if (typeof colour === "number") return `logs__ansi-${background ? "bg" : "fg"}${colour}`;
  const { r, g, b } = colour;
  // Backgrounds are a tint, so the text on them keeps its contrast in both themes.
  return background ? { backgroundColor: `rgba(${r}, ${g}, ${b}, 0.35)` } : { color: `rgb(${r}, ${g}, ${b})` };
}

/** The class names and inline style of an ANSI style. */
export function ansiProps(style: AnsiStyle): { className: string; style?: CSSProperties } {
  const classes = ["logs__ansi"];
  let inline: CSSProperties | undefined;
  if (style.bold) classes.push("logs__ansi-bold");
  if (style.dim) classes.push("logs__ansi-dim");
  if (style.italic) classes.push("logs__ansi-italic");
  if (style.underline) classes.push("logs__ansi-underline");
  if (style.strike) classes.push("logs__ansi-strike");
  if (style.inverse) {
    classes.push("logs__ansi-inverse");
  } else {
    for (const [colour, background] of [
      [style.fg, false],
      [style.bg, true],
    ] as const) {
      if (colour === undefined) continue;
      const made = colourStyle(colour, background);
      if (typeof made === "string") classes.push(made);
      else inline = { ...inline, ...made };
    }
  }
  return inline ? { className: classes.join(" "), style: inline } : { className: classes.join(" ") };
}

/** `raw` (one log entry) as React nodes; see the module comment. */
export function logText(raw: string, options: LogTextOptions): ReactNode {
  const special = hasSpecial(raw);
  const segments: AnsiSegment[] = special ? parseAnsi(raw) : [{ text: raw, style: null }];
  const ranges =
    (typeof options.ranges === "function"
      ? options.ranges(segments.length === 1 ? segments[0]!.text : segments.map((s) => s.text).join(""))
      : options.ranges) ?? [];
  if (ranges.length === 0 && !special) return raw === "" ? " " : raw;
  const nodes: ReactNode[] = [];
  let key = 0;
  let offset = 0;
  let r = 0;
  for (const segment of segments) {
    const text = segment.text;
    const style = options.colours && segment.style ? ansiProps(segment.style) : null;
    let pos = 0;
    while (pos < text.length) {
      if (text.charCodeAt(pos) === 0x0a) {
        nodes.push(
          options.wrap ? (
            "\n"
          ) : (
            <span key={key++} className="logs__nl" role="img" aria-label={options.lineBreakLabel}>
              {LINE_BREAK_SYMBOL}
            </span>
          ),
        );
        pos++;
        continue;
      }
      const at = offset + pos;
      while (r < ranges.length && ranges[r]!.end <= at) r++;
      const range = ranges[r];
      const inRange = range !== undefined && range.start <= at;
      let end = text.indexOf("\n", pos);
      if (end < 0) end = text.length;
      if (range) end = Math.min(end, (inRange ? range.end : range.start) - offset);
      const piece = text.slice(pos, end);
      const inner: ReactNode = style ? (
        <span key={key++} className={style.className} style={style.style}>
          {piece}
        </span>
      ) : (
        piece
      );
      nodes.push(
        inRange ? (
          <mark key={key++} className={range.current ? "logs__mark logs__mark--current" : "logs__mark"}>
            {inner}
          </mark>
        ) : (
          inner
        ),
      );
      pos = end;
    }
    offset += text.length;
  }
  return nodes.length === 0 ? " " : nodes;
}
