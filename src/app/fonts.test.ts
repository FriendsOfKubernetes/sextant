import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFonts,
  BUILTIN_MONO_STACK,
  BUILTIN_UI_STACK,
  fontStack,
  MAX_FONT_FAMILY_CHARS,
  onMonoFontChange,
  parseFontChoice,
  sanitizeFamily,
  SYSTEM_MONO_STACK,
  SYSTEM_UI_STACK,
} from "./fonts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = document.documentElement;

afterEach(() => applyFonts(null));

describe("font family names", () => {
  it("lose what could end a CSS string or declaration, and are capped", () => {
    expect(sanitizeFamily('  Fira\t"Code"; } body{x:y}  ')).toBe("Fira Code bodyx:y");
    expect(sanitizeFamily("Noto\\ Sans\u0007\nCJK")).toBe("Noto Sans CJK");
    expect(sanitizeFamily("<script>")).toBe("script");
    expect(sanitizeFamily(" '\"; ")).toBeNull();
    expect(sanitizeFamily("x".repeat(MAX_FONT_FAMILY_CHARS + 20))).toHaveLength(MAX_FONT_FAMILY_CHARS);
  });

  it("are read leniently: anything unknown is the built-in font", () => {
    expect(parseFontChoice(undefined)).toEqual({ kind: "builtin" });
    expect(parseFontChoice({ kind: "from-a-newer-version" })).toEqual({ kind: "builtin" });
    expect(parseFontChoice({ kind: "custom" })).toEqual({ kind: "builtin" });
    expect(parseFontChoice({ kind: "custom", family: "';" })).toEqual({ kind: "builtin" });
    expect(parseFontChoice({ kind: "system", family: "x" })).toEqual({ kind: "system" });
    expect(parseFontChoice({ kind: "custom", family: 'Inter"; color: red' })).toEqual({
      kind: "custom",
      family: "Inter color: red",
    });
  });
});

describe("font stacks", () => {
  it("put a custom family first, then the built-in font and the system's", () => {
    expect(fontStack({ kind: "builtin" }, "ui")).toBe(BUILTIN_UI_STACK);
    expect(fontStack({ kind: "system" }, "ui")).toBe(SYSTEM_UI_STACK);
    expect(fontStack({ kind: "system" }, "mono")).toBe(SYSTEM_MONO_STACK);
    expect(fontStack({ kind: "custom", family: "Inter" }, "ui")).toBe(`"Inter", ${BUILTIN_UI_STACK}`);
    expect(fontStack({ kind: "custom", family: 'Evil"; x' }, "mono")).toBe(`"Evil x", ${BUILTIN_MONO_STACK}`);
  });

  it("match the tokens of global.css", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/global.css"), "utf8").replace(/\s+/g, " ");
    expect(css).toContain(`--font-latin: ${BUILTIN_UI_STACK};`);
    expect(css).toContain(`--font-mono: ${BUILTIN_MONO_STACK};`);
  });
});

describe("applying the fonts", () => {
  it("sets the CSS variables on <html>, and the built-in choice leaves the stylesheet's", () => {
    applyFonts({ uiFont: { kind: "custom", family: "Inter" }, monoFont: { kind: "system" } });
    expect(root.style.getPropertyValue("--font-latin")).toBe(`"Inter", ${BUILTIN_UI_STACK}`);
    expect(root.style.getPropertyValue("--font-mono")).toBe(SYSTEM_MONO_STACK);

    applyFonts({ uiFont: { kind: "builtin" }, monoFont: { kind: "builtin" } });
    expect(root.style.getPropertyValue("--font-latin")).toBe("");
    expect(root.style.getPropertyValue("--font-mono")).toBe("");
  });

  it("tells the terminals about a new monospace stack, once per change", () => {
    const listener = vi.fn();
    const off = onMonoFontChange(listener);
    applyFonts({ uiFont: { kind: "system" } });
    expect(listener).not.toHaveBeenCalled();
    applyFonts({ monoFont: { kind: "custom", family: "Iosevka" } });
    applyFonts({ monoFont: { kind: "custom", family: "Iosevka" } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(`"Iosevka", ${BUILTIN_MONO_STACK}`);
    off();
    applyFonts(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
