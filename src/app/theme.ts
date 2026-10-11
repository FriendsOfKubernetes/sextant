import { useEffect, useState } from "react";
import type { Theme } from "../api";

export type EffectiveTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/** `system` follows the OS; `light`/`dark` are fixed. */
export function resolveTheme(theme: Theme, prefersDark: boolean): EffectiveTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

/** Applies the theme to `<html data-theme>` and keeps following OS changes while the setting is `system`. */
export function useApplyTheme(theme: Theme): EffectiveTheme {
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => setPrefersDark(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const effective = resolveTheme(theme, prefersDark);
  useEffect(() => {
    document.documentElement.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
  }, [effective]);
  return effective;
}
