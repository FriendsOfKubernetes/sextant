// WCAG AA contrast of the theme tokens (src/styles/global.css), computed from their values: axe cannot judge colours
// in jsdom. Text needs 4.5:1, focus rings and chart lines 3:1 (non-text contrast).
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  // The edge of a text field or select identifies the control (non-text contrast); dividers are decorative.
  for (const surface of SURFACES) check(c("control-border"), c(surface), 3, `control border on ${surface}`);
  for (const surface of ["main", "sidebar"]) {
    for (const overlay of ["hover", "selected"]) {
      const under = c(overlay, c(surface));
      check(c("text"), under, 4.5, `text on ${overlay} ${surface}`);
      check(c("text-muted"), under, 4.5, `muted text on ${overlay} ${surface}`);
    }
  }
  // Accent text that may sit on a hovered or selected background (the active sidebar item, links in table rows).
  for (const surface of SURFACES) {
    check(c("accent-strong"), c(surface), 4.5, `strong accent text on ${surface}`);
    for (const overlay of ["hover", "selected"]) {
      check(c("accent-strong"), c(overlay, c(surface)), 4.5, `strong accent text on ${overlay} ${surface}`);
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

/** The rules of a sheet (path from the repository root, with a leading slash): selector and declarations. */
function rulesOf(sheet: string): Array<[string, string]> {
  const css = readFileSync(join(process.cwd(), sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, body]) => [selector!, body!]);
}

/** Classes that components put on <input>, <select> and <textarea> elements (src/**\/*.tsx, tests aside). */
function fieldClassNames(): string[] {
  const sources = import.meta.glob<string>(["/src/**/*.tsx", "!/src/**/*.test.tsx"], { query: "?raw", import: "default", eager: true });
  const classes = new Set<string>();
  for (const source of Object.values(sources)) {
    for (const m of source.matchAll(/<(?:input|select|textarea)\b[^<]*?className=\{?\s*["'`]([^"'`]+)["'`]/g)) {
      for (const name of m[1]!.split(/\s+/)) if (/^[a-z][\w-]*$/i.test(name)) classes.add(name);
    }
  }
  return [...classes].sort();
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

  it("borders text fields and selects with the control border token, not the divider token", () => {
    const sheets = Object.keys(import.meta.glob("/src/**/*.css"));
    // A field is recognised by its selector's wording, or by a class that a component puts on an <input>, <select> or
    // <textarea> (`.clusters-paste` names neither).
    const fieldClasses = fieldClassNames();
    const offenders: string[] = [];
    for (const sheet of sheets) {
      for (const [selector, body] of rulesOf(sheet)) {
        const control =
          /\b(input|select|textarea)\b|-input\b|__input\b|__search\b/.test(selector) ||
          selector.split(",").some((part) => fieldClasses.some((c) => new RegExp(`\\.${c}(?![\\w-])[^\\s>+~]*$`).test(part.trim())));
        if (control && /(^|;)\s*border(-color)?\s*:[^;]*var\(--color-border\)/.test(body)) {
          offenders.push(`${sheet}: ${selector.trim()}`);
        }
      }
    }
    expect(sheets.length).toBeGreaterThan(10);
    expect(fieldClasses).toEqual(expect.arrayContaining(["settings__input", "clusters-paste", "logs__search", "st-input", "rs-select"]));
    expect(offenders).toEqual([]);
  });

  it("gives every text field, select and text area without a border rule of its own the control border", () => {
    const base = rulesOf("/src/styles/global.css").find(([selector]) => selector.trim().startsWith(":where("));
    expect(base, "the base rule of fields in global.css").toBeDefined();
    const [selector, body] = base!;
    for (const field of ["input:not(", "select", "textarea"]) expect(selector).toContain(field);
    // Checkboxes and radio buttons draw their own box (src/components).
    expect(selector).toContain('[type="checkbox"]');
    expect(selector).toContain('[type="radio"]');
    expect(body).toMatch(/(^|;)\s*border\s*:\s*1px solid var\(--color-control-border\)/);
  });

  it("draws accent text on hovered and selected backgrounds with the strong accent (axe on WebKit, #186)", () => {
    // The active sidebar entry sits on --color-selected; --color-accent there is below 4.5:1 in both themes.
    expect(cssRule("src/layout/layout.css", ".sidebar__item--active").color).toBe("var(--color-accent-strong)");
    for (const [sheet, selector] of [
      ["src/components/Table/table.css", ".rt-link"],
      ["src/features/helm/helm.css", ".helm-link"],
      ["src/features/fleet/fleet.css", ".fleet-link"],
      ["src/features/metrics/metrics.css", ".mx-link"],
      ["src/features/netpol/netpol.css", ".np-linkbutton"],
      ["src/features/compare/compare.css", ".compare-link"],
      ["src/features/rightsizing/rightsizing.css", ".rs-amounts__recommended"],
    ] as const) {
      expect(cssRule(sheet, selector).color, `${sheet} ${selector}`).toBe("var(--color-accent-strong)");
    }
    const under = (tokens: Tokens) => color(tokens, "selected", color(tokens, "sidebar"));
    expect(ratio(color(LIGHT, "accent"), under(LIGHT))).toBeLessThan(4.5);
    expect(ratio(color(DARK, "accent"), under(DARK))).toBeLessThan(4.5);
  });

  it("measures what it claims: black on white is 21:1, the old light accent under white text failed", () => {
    expect(ratio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(ratio([255, 255, 255], [0x3d, 0x90, 0xce])).toBeLessThan(4.5);
  });
});
