// ANSI escape sequences in log lines: the colours and styles of SGR sequences (`ESC [ … m`) become segments with a
// style; every other escape sequence (cursor moves, erasing, OSC 8 links, window titles, character sets) and every
// other control character is dropped, so the reader sees the text the program meant, never the codes.
//
// The output is data (text plus a style of known fields), never markup: the view renders it as React text nodes, so
// a line that looks like HTML stays text. Colours of the 16-colour palette are indices, drawn with theme tokens
// (`--logs-ansi-N` in logs.css); 256-colour and truecolor values are checked numbers turned into `rgb(…)`.
//
// Line breaks: `\r\n` and a lone `\r` read as `\n`, so a break inside an entry is one character in the visible text
// (search offsets and the view agree).

/** A colour: 0–15 = the palette (drawn with theme tokens), or an exact RGB colour (256-colour cube and truecolor). */
export type AnsiColour = number | { readonly r: number; readonly g: number; readonly b: number };

export interface AnsiStyle {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
  fg?: AnsiColour;
  bg?: AnsiColour;
}

export interface AnsiSegment {
  text: string;
  /** `null`: the default look. */
  style: AnsiStyle | null;
}

/** Characters that need the slow path: every C0 control but the tab (so also `\n` and `\r`), DEL and C1. */
// eslint-disable-next-line no-control-regex
const SPECIAL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

const isParam = (c: number) => c >= 0x30 && c <= 0x3f;
const isIntermediate = (c: number) => c >= 0x20 && c <= 0x2f;
const isFinal = (c: number) => c >= 0x40 && c <= 0x7e;
const isSpecial = (c: number) => (c < 0x20 && c !== 0x09) || (c >= 0x7f && c <= 0x9f);

/** Whether `raw` has anything `parseAnsi` changes (escape sequences, control characters, `\r`, `\n`). */
export function hasSpecial(raw: string): boolean {
  return SPECIAL.test(raw);
}

/**
 * `raw` cut into segments of one style each, without escape sequences or control characters (tabs and line breaks
 * stay; `\r\n` and `\r` become `\n`). A sequence cut off at the end of the line or broken in the middle is dropped
 * up to where it breaks; what follows stays text, so a stray `ESC ]` never hides the rest of a line.
 */
export function parseAnsi(raw: string): AnsiSegment[] {
  if (!SPECIAL.test(raw)) return [{ text: raw, style: null }];
  const out: AnsiSegment[] = [];
  let style: AnsiStyle | null = null;
  let text = "";
  const flush = () => {
    if (text !== "") out.push({ text, style });
    text = "";
  };
  const n = raw.length;
  // Where a string sequence (OSC, DCS…) was found to have no terminator: none exists from there to the end, so a
  // later one is not searched for again (a line of repeated `ESC ]` stays linear).
  let unterminatedFrom = n;
  let i = 0;
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === 0x1b || c === 0x9b) {
      let start: number; // first parameter character of a CSI
      if (c === 0x9b) {
        start = i + 1;
      } else {
        const next = raw.charCodeAt(i + 1); // NaN past the end: no comparison holds
        if (next === 0x5b) {
          start = i + 2;
        } else if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
          // OSC / DCS / SOS / PM / APC: a string up to BEL or ST (`ESC \` or U+009C), dropped with its text.
          let k = i + 2;
          let after = -1;
          while (k < n && k < unterminatedFrom) {
            const d = raw.charCodeAt(k);
            if (d === 0x07 || d === 0x9c) {
              after = k + 1;
              break;
            }
            if (d === 0x1b && raw.charCodeAt(k + 1) === 0x5c) {
              after = k + 2;
              break;
            }
            k++;
          }
          if (after < 0) unterminatedFrom = Math.min(unterminatedFrom, i + 2);
          i = after >= 0 ? after : i + 2;
          continue;
        } else if (isIntermediate(next)) {
          // `ESC ( B` and the like: intermediates, then one final character.
          let k = i + 1;
          while (k < n && isIntermediate(raw.charCodeAt(k))) k++;
          const fin = raw.charCodeAt(k);
          i = fin >= 0x30 && fin <= 0x7e ? k + 1 : k;
          continue;
        } else if (next >= 0x30 && next <= 0x7e) {
          i += 2; // `ESC 7`, `ESC c`, `ESC M`: two characters
          continue;
        } else {
          i += 1; // a lone ESC
          continue;
        }
      }
      // CSI: parameters, intermediates, one final character.
      let k = start;
      while (k < n && isParam(raw.charCodeAt(k))) k++;
      const paramsEnd = k;
      while (k < n && isIntermediate(raw.charCodeAt(k))) k++;
      const fin = raw.charCodeAt(k);
      if (isFinal(fin)) {
        if (fin === 0x6d && k === paramsEnd) {
          const next = applySgr(style, raw.slice(start, paramsEnd));
          if (next !== style) {
            flush();
            style = next;
          }
        }
        i = k + 1;
      } else {
        i = k; // cut off or broken: drop what was read, keep the rest as text
      }
      continue;
    }
    if (c === 0x0d) {
      text += "\n";
      i += raw.charCodeAt(i + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if (c === 0x0a) {
      text += "\n";
      i++;
      continue;
    }
    if (isSpecial(c)) {
      i++;
      continue;
    }
    let k = i + 1;
    while (k < n && !isSpecial(raw.charCodeAt(k))) k++;
    text += raw.slice(i, k);
    i = k;
  }
  flush();
  return out.length > 0 ? out : [{ text: "", style: null }];
}

/** The text a reader sees: `raw` without escape sequences and control characters, line breaks as `\n`. */
export function visibleText(raw: string): string {
  if (!SPECIAL.test(raw)) return raw;
  const segments = parseAnsi(raw);
  return segments.length === 1 ? segments[0]!.text : segments.map((s) => s.text).join("");
}

/** A whole number written with 1–3 digits; `""` is `empty` (an omitted parameter). */
function numberOf(text: string | undefined, empty?: number): number | undefined {
  if (text === undefined) return undefined;
  if (text === "") return empty;
  return /^\d{1,3}$/.test(text) ? Number(text) : undefined;
}

const byte = (v: number | undefined): v is number => v !== undefined && v <= 255;
const CUBE = [0, 95, 135, 175, 215, 255];

/** Colour `n` of the 256-colour palette: 0–15 the palette, then the 6×6×6 cube and 24 greys. */
function colour256(n: number | undefined): AnsiColour | undefined {
  if (!byte(n)) return undefined;
  if (n < 16) return n;
  if (n < 232) {
    const i = n - 16;
    return { r: CUBE[Math.floor(i / 36)]!, g: CUBE[Math.floor(i / 6) % 6]!, b: CUBE[i % 6]! };
  }
  const grey = 8 + (n - 232) * 10;
  return { r: grey, g: grey, b: grey };
}

function rgb(r: number | undefined, g: number | undefined, b: number | undefined): AnsiColour | undefined {
  return byte(r) && byte(g) && byte(b) ? { r, g, b } : undefined;
}

/** The colour of an extended colour parameter (38/48/58) written with colons: `5:n`, `2:r:g:b` or `2::r:g:b`. */
function colonColour(sub: string[]): AnsiColour | undefined {
  const kind = numberOf(sub[0]);
  if (kind === 5 && sub.length === 2) return colour256(numberOf(sub[1]));
  if (kind === 2 && sub.length === 4) return rgb(numberOf(sub[1]), numberOf(sub[2]), numberOf(sub[3]));
  if (kind === 2 && sub.length >= 5) return rgb(numberOf(sub[2]), numberOf(sub[3]), numberOf(sub[4]));
  return undefined;
}

function isEmptyStyle(s: AnsiStyle): boolean {
  for (const key in s) if (s[key as keyof AnsiStyle] !== undefined) return false;
  return true;
}

/** `prev` changed by the SGR parameters `params` (`1;36`, `38;5;208`, `38:2::255:0:0`, `` = reset). Returns `prev`
 * itself when nothing changed. Parameters it does not know are skipped; a private sequence (`?`, `<`…) is ignored. */
function applySgr(prev: AnsiStyle | null, params: string): AnsiStyle | null {
  if (params === "" || params === "0") return null;
  if (/[^0-9;:]/.test(params)) return prev;
  const s: AnsiStyle = { ...prev };
  const list = params.split(";");
  for (let p = 0; p < list.length; p++) {
    const sub = list[p]!.split(":");
    const code = numberOf(sub[0], 0);
    if (code === undefined) continue;
    if (code === 38 || code === 48 || code === 58) {
      let colour: AnsiColour | undefined;
      if (sub.length > 1) {
        colour = colonColour(sub.slice(1));
      } else {
        const kind = numberOf(list[p + 1]);
        if (kind === 5) {
          colour = colour256(numberOf(list[p + 2]));
          p += 2;
        } else if (kind === 2) {
          colour = rgb(numberOf(list[p + 2]), numberOf(list[p + 3]), numberOf(list[p + 4]));
          p += 4;
        } else {
          break; // the rest cannot be told apart from the colour's values
        }
      }
      if (colour !== undefined && code === 38) s.fg = colour;
      if (colour !== undefined && code === 48) s.bg = colour;
      continue; // 58 (underline colour) is read and not drawn
    }
    if (code === 0) {
      for (const key of Object.keys(s)) delete s[key as keyof AnsiStyle];
    } else if (code === 1) s.bold = true;
    else if (code === 2) s.dim = true;
    else if (code === 3) s.italic = true;
    else if (code === 4) s.underline = sub[1] !== "0";
    else if (code === 7) s.inverse = true;
    else if (code === 9) s.strike = true;
    else if (code === 22) {
      delete s.bold;
      delete s.dim;
    } else if (code === 23) delete s.italic;
    else if (code === 24) delete s.underline;
    else if (code === 27) delete s.inverse;
    else if (code === 29) delete s.strike;
    else if (code >= 30 && code <= 37) s.fg = code - 30;
    else if (code === 39) delete s.fg;
    else if (code >= 40 && code <= 47) s.bg = code - 40;
    else if (code === 49) delete s.bg;
    else if (code >= 90 && code <= 97) s.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) s.bg = code - 100 + 8;
  }
  if (s.underline === false) delete s.underline;
  return isEmptyStyle(s) ? null : s;
}
