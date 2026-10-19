// WCAG AA contrast of the theme tokens (src/styles/global.css), computed from their values: axe cannot judge colours
// in jsdom. Text needs 4.5:1, focus rings and chart lines 3:1 (non-text contrast).
import { describe, expect, it } from "vitest";
import { cssRule } from "../test/css";

type Rgb = [number, number, number];
type Tokens = Record<string, string>;

const LIGHT = cssRule("src/styles/global.css", ':root,\n:root[data-theme="light"]');
const DARK = { ...LIGHT, ...cssRule("src/styles/global.css", ':root[data-theme="dark"]') };

/** A token's colour as RGB; an `rgba()` is laid over `under` (the surface it is drawn on). */
function color(tokens: Tokens, name: string, under?: Rgb): Rgb {
  const value = tokens[`--color-${name}`];
  if (!value) throw new Error(`no --color-${name}`);
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb;
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (!rgba || !under) throw new Error(`cannot read --color-${name}: ${value}`);
  const alpha = Number(rgba[4]);
  return [1, 2, 3].map((i, k) => Number(rgba[i]) * alpha + under[k]! * (1 - alpha)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr! + 0.7152 * lg! + 0.0722 * lb!;
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SURFACES = ["bg", "main", "sidebar", "panel", "dock"];
// Where muted text also sits: the rail, the dock header, a hovered or selected row.
const CHROME = ["rail", "dock-header"];

function failures(tokens: Tokens): string[] {
  const out: string[] = [];
  const check = (fg: Rgb, bg: Rgb, min: number, what: string) => {
    const r = ratio(fg, bg);
    if (r < min) out.push(`${what}: ${r.toFixed(2)} < ${min}`);
  };
  const c = (name: string, under?: Rgb) => color(tokens, name, under);
  for (const surface of [...SURFACES, ...CHROME]) {
    check(c("text"), c(surface), 4.5, `text on ${surface}`);
    check(c("text-muted"), c(surface), 4.5, `muted text on ${surface}`);
    check(c("focus"), c(surface), 3, `focus ring on ${surface}`);
  }
  for (const surface of ["main", "sidebar"]) {
    for (const overlay of ["hover", "selected"]) {
      const under = c(overlay, c(surface));
      check(c("text"), under, 4.5, `text on ${overlay} ${surface}`);
      check(c("text-muted"), under, 4.5, `muted text on ${overlay} ${surface}`);
    }
  }
  for (const surface of SURFACES) {
    for (const status of ["accent", "danger", "warning", "success"]) check(c(status), c(surface), 4.5, `${status} text on ${surface}`);
    for (const chart of ["cpu", "memory", "pods", "disk"]) check(c(`chart-${chart}`), c(surface), 3, `${chart} chart on ${surface}`);
  }
  check(c("accent-text"), c("accent"), 4.5, "text on an accent fill (primary button, info badge)");
  for (const status of ["danger", "warning", "success"]) check(c("on-status"), c(status), 4.5, `text on a ${status} fill`);
  return out;
}

describe("theme contrast (WCAG AA)", () => {
  it("the light theme", () => {
    expect(failures(LIGHT)).toEqual([]);
  });

  it("the dark theme", () => {
    expect(failures(DARK)).toEqual([]);
  });

  it("draws the checkbox mark in the accent text colour of each theme", () => {
    const stroke = (selector: string) =>
      /stroke='%23([0-9a-f]{6})'/i.exec(cssRule("src/components/checkbox.css", selector)["background-image"] ?? "")?.[1];
    for (const state of ["checked", "indeterminate"]) {
      expect(`#${stroke(`.checkbox:${state}`)}`).toBe(LIGHT["--color-accent-text"]);
      expect(`#${stroke(`:root[data-theme="dark"] .checkbox:${state}`)}`).toBe(DARK["--color-accent-text"]);
    }
  });

  it("measures what it claims: black on white is 21:1, the old light accent under white text failed", () => {
    expect(ratio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(ratio([255, 255, 255], [0x3d, 0x90, 0xce])).toBeLessThan(4.5);
  });
});
