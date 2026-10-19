// The interface and monospace fonts (ADR-0093). The built-in Fira Sans / Fira Mono are bundled (src/styles/fonts.css)
// and are the defaults of `--font-latin` / `--font-mono` in global.css; Settings -> Appearance can pick the system's
// stacks instead (the look before the bundled fonts) or a font family installed on this computer. A choice is applied
// as an inline value of those variables on <html>, so the CJK stacks of global.css (built on `--font-latin`) still
// follow. A custom family that is not installed here (a settings file from another computer) falls back silently: the
// built-in font comes right after it in the stack.
import { useEffect } from "react";
import type { AppearanceSettings, FontChoice } from "../api";

/** The system's interface stack, the look before the bundled fonts. */
export const SYSTEM_UI_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue"';
/** The system's monospace stack. */
export const SYSTEM_MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
/** The stacks of global.css (`--font-latin`, `--font-mono`): the bundled font, then the system's. */
export const BUILTIN_UI_STACK = `"Fira Sans", ${SYSTEM_UI_STACK}`;
export const BUILTIN_MONO_STACK = `"Fira Mono", ${SYSTEM_MONO_STACK}`;

/** Longest family name kept (the same cap as the backend, `MAX_FONT_FAMILY_CHARS`). */
export const MAX_FONT_FAMILY_CHARS = 100;

export type FontRole = "ui" | "mono";

const BUILTIN: FontChoice = { kind: "builtin" };

/**
 * `name` fit for a quoted CSS font-family value, or null when nothing usable is left: quotes, backslashes, semicolons,
 * braces and angle brackets are dropped, control characters and runs of white space become one space, and the name is
 * capped. The same rule as `sanitize_family` in the core.
 */
export function sanitizeFamily(name: string): string | null {
  let kept = "";
  for (const ch of name) {
    if (`"'\\;{}<>`.includes(ch)) continue;
    const code = ch.codePointAt(0) ?? 0;
    kept += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  const capped = Array.from(kept.split(/\s+/).filter(Boolean).join(" ")).slice(0, MAX_FONT_FAMILY_CHARS).join("");
  const trimmed = capped.trimEnd();
  return trimmed ? trimmed : null;
}

/** A stored choice read leniently: anything unknown, or a custom choice without a usable name, is the built-in font. */
export function parseFontChoice(value: unknown): FontChoice {
  if (!value || typeof value !== "object") return BUILTIN;
  const { kind, family } = value as { kind?: unknown; family?: unknown };
  if (kind === "system") return { kind: "system" };
  if (kind === "custom" && typeof family === "string") {
    const clean = sanitizeFamily(family);
    if (clean) return { kind: "custom", family: clean };
  }
  return BUILTIN;
}

/** The CSS font stack of `choice` for `role`. */
export function fontStack(choice: FontChoice, role: FontRole): string {
  const builtin = role === "ui" ? BUILTIN_UI_STACK : BUILTIN_MONO_STACK;
  const parsed = parseFontChoice(choice);
  if (parsed.kind === "system") return role === "ui" ? SYSTEM_UI_STACK : SYSTEM_MONO_STACK;
  if (parsed.kind === "custom" && parsed.family) return `"${parsed.family}", ${builtin}`;
  return builtin;
}

const VARIABLES: Record<FontRole, string> = { ui: "--font-latin", mono: "--font-mono" };

let monoStack = BUILTIN_MONO_STACK;
const monoListeners = new Set<(stack: string) => void>();

/** The monospace stack in effect (what `--font-mono` holds). */
export function currentMonoStack(): string {
  return monoStack;
}

/** Calls `listener` with the new monospace stack whenever it changes; returns the unsubscribe. */
export function onMonoFontChange(listener: (stack: string) => void): () => void {
  monoListeners.add(listener);
  return () => monoListeners.delete(listener);
}

/**
 * Sets `--font-latin` / `--font-mono` on <html> for `appearance` (the built-in choice removes the inline value, so the
 * stacks of global.css apply) and tells the monospace listeners (terminals) about a changed stack.
 */
export function applyFonts(appearance: Partial<AppearanceSettings> | null | undefined): void {
  const root = document.documentElement;
  for (const role of ["ui", "mono"] as const) {
    const choice = parseFontChoice(role === "ui" ? appearance?.uiFont : appearance?.monoFont);
    if (choice.kind === "builtin") root.style.removeProperty(VARIABLES[role]);
    else root.style.setProperty(VARIABLES[role], fontStack(choice, role));
  }
  const mono = fontStack(parseFontChoice(appearance?.monoFont), "mono");
  if (mono !== monoStack) {
    monoStack = mono;
    for (const listener of [...monoListeners]) listener(mono);
  }
}

/** Applies the font settings while mounted (App). */
export function useApplyFonts(appearance: AppearanceSettings | undefined): void {
  const ui = JSON.stringify(appearance?.uiFont ?? null);
  const mono = JSON.stringify(appearance?.monoFont ?? null);
  useEffect(() => {
    applyFonts({ uiFont: JSON.parse(ui) as FontChoice, monoFont: JSON.parse(mono) as FontChoice });
  }, [ui, mono]);
}

const loaded = new Set<string>();

/** Whether `stack` was already loaded at `size` (no wait needed). */
export function fontLoaded(stack: string, size: number): boolean {
  return loaded.has(`${size}px ${stack}`) || typeof document === "undefined" || !document.fonts?.load;
}

/** Resolves once the faces of `stack` at `size` (regular and bold) are loaded, however long that takes; never rejects. */
export function whenFontLoaded(stack: string, size: number): Promise<void> {
  const key = `${size}px ${stack}`;
  if (fontLoaded(stack, size)) return Promise.resolve();
  return Promise.all([document.fonts.load(key), document.fonts.load(`bold ${key}`)])
    .catch(() => undefined)
    .then(() => {
      loaded.add(key);
    });
}

/**
 * True once `stack` is loaded (see [`whenFontLoaded`]), false when that takes longer than `timeoutMs`. Without the Font
 * Loading API it is true at once: there is nothing to wait for. A font that fails to load counts as loaded (the
 * fallback is what there is).
 */
export function loadFont(stack: string, size: number, timeoutMs: number): Promise<boolean> {
  if (fontLoaded(stack, size)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void whenFontLoaded(stack, size).then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
