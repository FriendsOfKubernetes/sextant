import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./Checkbox";

// Read from disk: the test run does not process CSS (`css: false`).
const checkboxCss = readFileSync(join(process.cwd(), "src/components/Table/checkbox.css"), "utf8");
const globalCss = readFileSync(join(process.cwd(), "src/styles/global.css"), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const block = blocks.find(([, sel]) => sel!.split(",").map((s) => s.trim()).join(",") === selector);
  if (!block) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    block[2]!
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  );
}

/** Relative luminance of `#rrggbb` (WCAG). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** `var(--x)` → the value of `--x` in the theme block `selector` of global.css. */
function resolve(value: string, selector: string): string {
  const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  if (!name) throw new Error(`${value} is not a theme token`);
  const token = rule(globalCss, selector)[name];
  if (!token) throw new Error(`${name} is not defined for ${selector}`);
  return token;
}

const LIGHT = ':root,:root[data-theme="light"]';
const DARK = ':root[data-theme="dark"]';

describe("Checkbox", () => {
  it("is a checkbox drawn by the app, not by the toolkit", () => {
    render(<Checkbox aria-label="pick" defaultChecked />);
    const box = screen.getByRole("checkbox", { name: "pick" });
    expect(box).toBeChecked();
    expect(box).toHaveClass("checkbox");
    expect(rule(checkboxCss, ".checkbox").appearance).toBe("none");
  });

  it("is light in the light theme and dark in the dark theme, the accent color when checked", () => {
    const box = rule(checkboxCss, ".checkbox");
    const light = resolve(box["background-color"]!, LIGHT);
    const dark = resolve(box["background-color"]!, DARK);
    expect(luminance(light)).toBeGreaterThan(0.8);
    expect(luminance(dark)).toBeLessThan(0.1);
    expect(box["accent-color"]).toBe("var(--color-accent)");
    expect(rule(checkboxCss, ".checkbox:checked,.checkbox:indeterminate")["background-color"]).toBe(
      "var(--color-accent)",
    );
  });

  it("is the only checkbox in the app: the table, the namespace filter and the logs use it", () => {
    const sources = import.meta.glob<string>(["/src/**/*.tsx", "!/src/**/*.test.tsx"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const native = Object.entries(sources)
      .filter(([path, text]) => !path.endsWith("/Checkbox.tsx") && /type=["{']+checkbox/.test(text))
      .map(([path]) => path);
    expect(native).toEqual([]);
    for (const user of [
      "/src/components/Table/ResourceTable.tsx",
      "/src/features/namespaces/NamespaceFilter.tsx",
      "/src/features/logs/LogsTab.tsx",
    ]) {
      expect(sources[user], user).toMatch(/<Checkbox\b/);
    }
  });
});
