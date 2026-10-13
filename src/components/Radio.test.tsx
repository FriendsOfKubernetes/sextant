import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Radio } from "./Radio";

// Read from disk: the test run does not process CSS (`css: false`).
const radioCss = readFileSync(join(process.cwd(), "src/components/radio.css"), "utf8");
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

describe("Radio", () => {
  it("is a radio button drawn by the app, labelled by its <label>, in a group by name", () => {
    const onChange = vi.fn();
    render(
      <div role="radiogroup" aria-label="Theme">
        <label>
          <Radio name="theme" value="light" defaultChecked />
          Light
        </label>
        <label>
          <Radio name="theme" value="dark" className="extra" onChange={onChange} />
          Dark
        </label>
      </div>,
    );
    const light = screen.getByRole("radio", { name: "Light" });
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(light).toBeChecked();
    expect(light).toHaveClass("radio");
    expect(dark).toHaveClass("radio", "extra");
    fireEvent.click(dark);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(dark).toBeChecked();
    expect(light).not.toBeChecked();
    expect(rule(radioCss, ".radio").appearance).toBe("none");
    expect(rule(radioCss, ".radio")["border-radius"]).toBe("50%");
  });

  it("is light in the light theme and dark in the dark theme, the accent color when checked; shows focus and disabled", () => {
    const radio = rule(radioCss, ".radio");
    expect(luminance(resolve(radio["background-color"]!, LIGHT))).toBeGreaterThan(0.8);
    expect(luminance(resolve(radio["background-color"]!, DARK))).toBeLessThan(0.1);
    expect(rule(radioCss, ".radio:checked")["border-color"]).toBe("var(--color-accent)");
    expect(rule(radioCss, ".radio:focus-visible").outline).toContain("var(--color-accent)");
    expect(rule(radioCss, ".radio:disabled").opacity).toBe("0.5");
  });

  it("is the only radio button in the app: Settings, metrics and port-forward use it", () => {
    const sources = import.meta.glob<string>(["/src/**/*.tsx", "!/src/**/*.test.tsx"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const native = Object.entries(sources)
      .filter(([path, text]) => !path.endsWith("/Radio.tsx") && /type=["{']+radio/.test(text))
      .map(([path]) => path);
    expect(native).toEqual([]);
    for (const user of [
      "/src/features/settings/SettingsPage.tsx",
      "/src/features/metrics/SettingsSection.tsx",
      "/src/features/portforward/ForwardDialog.tsx",
    ]) {
      expect(sources[user], user).toMatch(/<Radio\b/);
    }
  });
});
