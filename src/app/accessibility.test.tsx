// The accessibility choices of Settings -> Appearance (ADR-0092, #186): reduced motion on <html> and in the CSS, the
// interface text size as the root font size with every text size in rem, and lengths measured from their tokens.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAccessibility,
  cssLengthPx,
  currentAccessibility,
  onAccessibilityChange,
  parseAccessibility,
  reducedMotion,
  scaledPx,
  useCssLength,
} from "./accessibility";
import { cssRule } from "../test/css";

function stubReducedMotion(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? matches : false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(() => {
  applyAccessibility(null);
  vi.restoreAllMocks();
});

describe("the accessibility settings", () => {
  it("read leniently: anything unknown is the default", () => {
    expect(parseAccessibility(null)).toEqual({ reduceMotion: "system", textSize: 100, terminalScreenReader: false });
    expect(
      parseAccessibility({ reduceMotion: "sometimes" as never, textSize: 130, terminalScreenReader: "yes" as never }),
    ).toEqual({ reduceMotion: "system", textSize: 100, terminalScreenReader: false });
    expect(parseAccessibility({ reduceMotion: "off", textSize: 150, terminalScreenReader: true })).toEqual({
      reduceMotion: "off",
      textSize: 150,
      terminalScreenReader: true,
    });
  });

  it("reduced motion is an attribute of <html>; System leaves it to the operating system", () => {
    const root = document.documentElement;
    stubReducedMotion(true);
    applyAccessibility({ reduceMotion: "system" });
    expect(root.dataset.motion).toBeUndefined();
    expect(reducedMotion()).toBe(true);

    applyAccessibility({ reduceMotion: "off" });
    expect(root.dataset.motion).toBe("full");
    expect(reducedMotion()).toBe(false);

    stubReducedMotion(false);
    applyAccessibility({ reduceMotion: "on" });
    expect(root.dataset.motion).toBe("reduce");
    expect(reducedMotion()).toBe(true);
    applyAccessibility({ reduceMotion: "system" });
    expect(reducedMotion()).toBe(false);
  });

  it("the text size is the font size of <html>; listeners hear of a change once, and views are told to lay out", () => {
    const root = document.documentElement;
    const heard = vi.fn();
    const resized = vi.fn();
    window.addEventListener("resize", resized);
    const off = onAccessibilityChange(heard);
    applyAccessibility({ textSize: 125 });
    expect(root.style.fontSize).toBe("125%");
    expect(scaledPx(13)).toBe(16);
    applyAccessibility({ textSize: 125 });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(resized).toHaveBeenCalledTimes(1);

    applyAccessibility({ textSize: 100 });
    expect(root.style.fontSize).toBe("");
    expect(currentAccessibility().textSize).toBe(100);
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    window.removeEventListener("resize", resized);
  });

  it("a length token is measured in pixels, again after the text size changes", () => {
    // jsdom lays nothing out: the fallback.
    expect(cssLengthPx("--table-row-height", 33)).toBe(33);
    let rootPx = 16;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ height: 2 * rootPx + 1 }) as DOMRect,
    );
    const { result } = renderHook(() => useCssLength("--table-row-height", 33));
    expect(result.current).toBe(33);
    rootPx = 24;
    act(() => applyAccessibility({ textSize: 150 }));
    expect(result.current).toBe(49);
    // No probe is left behind.
    expect(document.body.children).toHaveLength(1);
  });
});

describe("the stylesheets", () => {
  const sheets = Object.keys(import.meta.glob("/src/**/*.css"));
  const read = (sheet: string) => readFileSync(join(process.cwd(), sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("size text in rem, so it follows the interface text size and the web view's default font size", () => {
    const offenders: string[] = [];
    for (const sheet of sheets) {
      for (const m of read(sheet).matchAll(/(?<![\w-])(font-size|line-height)\s*:\s*([^;}]*\dpx[^;}]*)/g)) {
        offenders.push(`${sheet}: ${m[1]}: ${m[2]!.trim()}`);
      }
    }
    expect(sheets.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("controls, table rows and log lines grow with the text: their tokens are in rem", () => {
    const tokens = cssRule("src/styles/global.css", ":root");
    expect(tokens["--control-height"]).toBe("2rem");
    expect(tokens["--control-height-compact"]).toBe("1.75rem");
    expect(tokens["--control-font-size"]).toBe("0.8125rem");
    expect(tokens["--table-row-height"]).toBe("calc(2rem + 1px)");
    expect(tokens["--log-line-height"]).toBe("1.125rem");
    expect(cssRule("src/components/Table/table.css", ".rt__row").height).toBe("var(--table-row-height)");
    expect(cssRule("src/components/Table/table.css", ".rt__resizer").height).toBe("var(--table-row-height)");
    expect(cssRule("src/features/logs/logs.css", ".logs__line")["line-height"]).toBe("var(--log-line-height)");
    expect(cssRule("src/styles/global.css", "body")["font-size"]).toBe("0.8125rem");
  });

  it("turn motion off for the OS preference unless the setting says Off, and always when it says On", () => {
    const css = read("src/styles/global.css");
    const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(media).toContain(':root:not([data-motion="full"]) *');
    expect(media).toMatch(/animation-duration: 0\.01ms !important/);
    const forced = cssRule("src/styles/global.css", ':root[data-motion="reduce"] *,\n:root[data-motion="reduce"] *::before,\n:root[data-motion="reduce"] *::after');
    expect(forced).toMatchObject({
      "transition-duration": "0.01ms !important",
      "animation-duration": "0.01ms !important",
      "scroll-behavior": "auto !important",
    });
    expect(cssRule("src/components/loading.css", ':root[data-motion="reduce"] .loading-indicator__spinner').animation).toBe("none");
  });
});
