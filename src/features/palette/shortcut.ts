// The keyboard shortcut of the command palette: Ctrl+K (Cmd+K on macOS). Where typing goes somewhere — a text field,
// a terminal, the YAML editor — Ctrl+K belongs to it (a terminal's kill-line, an editor's chord), so there the palette
// opens only with Shift added (Ctrl+Shift+K / Cmd+Shift+K). Inside the palette's own field Ctrl+K closes it.

/** Input types that take no typing: the shortcut works there as anywhere else. */
const NON_TEXT_INPUTS = new Set(["button", "checkbox", "radio", "range", "color", "file", "image", "reset", "submit"]);

/** Whether `target` takes typed text: a text field, a select, an editable element, a terminal, a code editor. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // xterm keeps its focus in a hidden textarea, CodeMirror in a contenteditable; both are caught here anyway, the
  // containers also cover their other focusable parts.
  if (target.closest(".xterm, .cm-editor")) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest("[contenteditable]:not([contenteditable='false'])") !== null;
}

/**
 * Whether the key event toggles the palette. `insidePalette`: the event comes from the palette itself (its search
 * field), where plain Ctrl+K closes it.
 */
export function isPaletteShortcut(e: KeyboardEvent, insidePalette = false): boolean {
  if (e.type !== "keydown" || e.altKey || e.repeat) return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  // `code` too: on a non-Latin layout `key` is another letter.
  if (e.key.toLowerCase() !== "k" && e.code !== "KeyK") return false;
  if (e.shiftKey || insidePalette) return true;
  return !isTypingTarget(e.target);
}
