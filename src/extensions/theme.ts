// What a frame gets of Sextant's look: the effective theme (`<html data-theme>`, set by `useApplyTheme`) and the
// values of the CSS variables in `THEME_TOKENS`, read again whenever the theme changes.
import { useEffect, useMemo, useState } from "react";
import { THEME_TOKENS } from "./protocol";

export type FrameTheme = "light" | "dark";

/** The body font of global.css, for when the computed style has none (tests). */
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", sans-serif';
const FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

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

/** The effective theme and its tokens, updated when `<html data-theme>` changes. */
export function useFrameTheme(): { theme: FrameTheme; tokens: Record<string, string> } {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setTheme(currentTheme());
    return () => observer.disconnect();
  }, []);
  // `theme` is the cause: the tokens are re-read when it changes.
  const tokens = useMemo(() => (void theme, readThemeTokens()), [theme]);
  return { theme, tokens };
}
