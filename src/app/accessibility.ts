// The accessibility choices of Settings -> Appearance (ADR-0092): reduced motion, the interface text size and screen
// reader support in the terminal. Stored in `AppSettings.appearance` (frontend-written, read leniently by the core).
//
// - Reduced motion is `data-motion` on <html>: `reduce` (On) or `full` (Off); without it (System) the CSS follows
//   `prefers-reduced-motion`. global.css and loading.css turn transitions and animations off for `reduce`, and for
//   the media query unless `full`. JavaScript motion (the blinking terminal cursor) asks `reducedMotion()`.
// - The interface text size is the font size of <html> in percent: every font size, control height and table row of
//   the stylesheets is in rem, so all of them grow with it. Code that needs a length in pixels (virtualised rows)
//   measures its token (`cssLengthPx`), and the terminal scales its own font size (`scaledPx`).
// - The terminal's screen reader mode is xterm's `screenReaderMode`, read by terminals when they are created and
//   followed live through `onAccessibilityChange`.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AppearanceSettings, ReduceMotion } from "../api";

/** The interface text sizes offered, in percent (the same list as the core, `TEXT_SIZES`). */
export const TEXT_SIZES = [90, 100, 110, 125, 150] as const;
export const DEFAULT_TEXT_SIZE = 100;
const MOTION_CHOICES: ReduceMotion[] = ["system", "on", "off"];
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

export interface Accessibility {
  reduceMotion: ReduceMotion;
  /** Percent of the default text size, one of `TEXT_SIZES`. */
  textSize: number;
  terminalScreenReader: boolean;
}

/** The choices of `appearance`, read leniently: anything unknown is the default. */
export function parseAccessibility(appearance: Partial<AppearanceSettings> | null | undefined): Accessibility {
  const motion = appearance?.reduceMotion;
  const size = appearance?.textSize;
  return {
    reduceMotion: MOTION_CHOICES.includes(motion as ReduceMotion) ? (motion as ReduceMotion) : "system",
    textSize: (TEXT_SIZES as readonly number[]).includes(size as number) ? (size as number) : DEFAULT_TEXT_SIZE,
    terminalScreenReader: appearance?.terminalScreenReader === true,
  };
}

let current: Accessibility = parseAccessibility(null);
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function systemPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCE_QUERY).matches;
}

/** Whether motion is reduced now: the setting, or with System the operating system's preference. */
export function reducedMotion(): boolean {
  if (current.reduceMotion === "on") return true;
  if (current.reduceMotion === "off") return false;
  return systemPrefersReducedMotion();
}

/** The choices in effect. */
export function currentAccessibility(): Accessibility {
  return current;
}

/** The text size as a factor (1 at 100%). */
export function textScale(): number {
  return current.textSize / 100;
}

/** `px` (a size meant at 100%) at the current text size, rounded to a whole pixel. */
export function scaledPx(px: number): number {
  return Math.round(px * textScale());
}

/**
 * Calls `listener` whenever a choice changes, or with System the operating system's reduced-motion preference does;
 * returns the unsubscribe.
 */
export function onAccessibilityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Sets `data-motion` and the font size of <html> for `appearance` and tells the listeners about a change. */
export function applyAccessibility(appearance: Partial<AppearanceSettings> | null | undefined): void {
  const next = parseAccessibility(appearance);
  const root = document.documentElement;
  if (next.reduceMotion === "on") root.dataset.motion = "reduce";
  else if (next.reduceMotion === "off") root.dataset.motion = "full";
  else delete root.dataset.motion;
  if (next.textSize === DEFAULT_TEXT_SIZE) root.style.removeProperty("font-size");
  else root.style.setProperty("font-size", `${next.textSize}%`);
  const resized = next.textSize !== current.textSize;
  const changed =
    resized || next.reduceMotion !== current.reduceMotion || next.terminalScreenReader !== current.terminalScreenReader;
  current = next;
  if (changed) notify();
  // Views that measure themselves on a window resize (charts, the diff editors) lay out again at the new size.
  if (resized) window.dispatchEvent(new Event("resize"));
}

/** Applies the choices while mounted (App), and follows the operating system's reduced-motion preference. */
export function useApplyAccessibility(appearance: AppearanceSettings | undefined): void {
  const motion = appearance?.reduceMotion;
  const size = appearance?.textSize;
  const reader = appearance?.terminalScreenReader;
  useEffect(() => {
    applyAccessibility({ reduceMotion: motion, textSize: size, terminalScreenReader: reader });
  }, [motion, size, reader]);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCE_QUERY);
    const changed = () => {
      if (current.reduceMotion === "system") notify();
    };
    query.addEventListener?.("change", changed);
    return () => query.removeEventListener?.("change", changed);
  }, []);
}

/** Re-renders on every change of the choices (or the system's motion preference); returns a change counter. */
export function useAccessibilityVersion(): number {
  return useSyncExternalStore(onAccessibilityChange, () => version);
}

/**
 * The length of the CSS custom property `token` in pixels, measured on a hidden probe (a custom property holds its
 * text, `2rem + 1px`, not pixels); `fallback` where nothing is laid out (tests, before the stylesheet).
 */
export function cssLengthPx(token: string, fallback: number): number {
  if (typeof document === "undefined" || !document.body) return fallback;
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(${token})`;
  document.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(height) && height > 0 ? height : fallback;
}

/** [`cssLengthPx`], measured again when the text size changes. */
export function useCssLength(token: string, fallback: number): number {
  const changes = useAccessibilityVersion();
  // `changes` is the reason to measure again.
  return useMemo(() => cssLengthPx(token, fallback), [token, fallback, changes]);
}
