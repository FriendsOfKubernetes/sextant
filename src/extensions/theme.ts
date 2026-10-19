// What a frame gets of Sextant's look: the effective theme (`<html data-theme>`, set by `useApplyTheme`) and the
// values of the CSS variables in `THEME_TOKENS`, read again whenever the theme changes.
import { useEffect, useMemo, useState } from "react";
import { BUILTIN_MONO_STACK, BUILTIN_UI_STACK } from "../app/fonts";
import { THEME_TOKENS } from "./protocol";

export type FrameTheme = "light" | "dark";

/**
 * The fonts of global.css, for when the computed style has none (tests). They name the bundled Fira Sans / Fira Mono
 * (or the font the user chose, ADR-0093), but a frame cannot load the host's font files (its origin is opaque), so the
 * system fallbacks after them are what an extension draws with unless the font is installed.
 */
const FONT_FAMILY = `${BUILTIN_UI_STACK}, sans-serif`;
const FONT_MONO = BUILTIN_MONO_STACK;

function currentTheme(): FrameTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** The current values of the theme tokens. */
export function readThemeTokens(): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const value = root.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  tokens["--font-family"] ??= getComputedStyle(document.body).fontFamily || FONT_FAMILY;
  tokens["--font-mono"] ??= FONT_MONO;
  return tokens;
}

/** The effective theme and its tokens, updated when `<html data-theme>` or its inline style (the fonts) changes. */
export function useFrameTheme(): { theme: FrameTheme; tokens: Record<string, string> } {
  const [theme, setTheme] = useState(currentTheme);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(currentTheme());
      setRevision((n) => n + 1);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    setTheme(currentTheme());
    return () => observer.disconnect();
  }, []);
  // `theme` and `revision` are the cause: the tokens are re-read when they change.
  const tokens = useMemo(() => (void theme, void revision, readThemeTokens()), [theme, revision]);
  return { theme, tokens };
}
