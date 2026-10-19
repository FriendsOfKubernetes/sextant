// Characters a command typed into a shell must not hide (#154): control characters and invisible or text-direction
// characters. No dependencies, so the import of an export file can use it without the terminal.

/** Whether `code` is a control character (C0 including ESC, DEL, C1). */
export function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Whether `code` is invisible or reorders text: zero-width characters and marks (U+200B–U+200F), bidirectional
 * embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069) and the BOM (U+FEFF). Such characters make a
 * command read differently from what runs.
 */
export function isInvisible(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff
  );
}

/** Whether `text` has a control character or an invisible or text-direction character. */
export function hasHiddenChars(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isControl(code) || isInvisible(code)) return true;
  }
  return false;
}

/**
 * `text` with its whitespace and hidden characters shown: a space as `·`, a tab as `→`, a control, invisible or
 * text-direction character as `⟨U+XXXX⟩` (an import preview shows what would really be typed).
 */
export function visibleText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === " ") out += "·";
    else if (ch === "\t") out += "→";
    else if (isControl(code) || isInvisible(code)) out += `⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
    else out += ch;
  }
  return out;
}
