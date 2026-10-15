import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, BASE_STYLE_ID } from "../src/theme";

const root = document.documentElement;

afterEach(() => {
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
  root.removeAttribute("data-view");
  root.removeAttribute("lang");
  document.getElementById(BASE_STYLE_ID)?.remove();
});

describe("applyTheme", () => {
  it("sets Sextant's tokens as CSS variables, the theme and the language on <html>", () => {
    applyTheme({ theme: "dark", language: "en", tokens: { "--color-text": "#dcddde", "--color-main": "#1e2124" } });
    expect(root.style.getPropertyValue("--color-text")).toBe("#dcddde");
    expect(root.style.getPropertyValue("--color-main")).toBe("#1e2124");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(root.lang).toBe("en");
  });

  it("follows a change: new values, and tokens no longer sent are removed", () => {
    applyTheme({ theme: "dark", language: "en", tokens: { "--color-text": "#dcddde", "--color-warning": "#e2a03f" } });
    applyTheme({ theme: "light", language: "de", tokens: { "--color-text": "#1f2328" } });
    expect(root.style.getPropertyValue("--color-text")).toBe("#1f2328");
    expect(root.style.getPropertyValue("--color-warning")).toBe("");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.getPropertyValue("color-scheme")).toBe("light");
    expect(root.lang).toBe("de");
  });

  it("names the view, whose place gives the body its background", () => {
    applyTheme({ theme: "dark", language: "en", tokens: {}, view: "details" });
    expect(root.dataset.view).toBe("details");
    expect(document.getElementById(BASE_STYLE_ID)!.textContent).toContain('[data-view="details"]');
  });

  it("gives native controls and scrollbars the theme's colour scheme, with or without the base styles", () => {
    applyTheme({ theme: "dark", language: "en", tokens: {} }, { baseStyles: false });
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(getComputedStyle(root).getPropertyValue("color-scheme")).toBe("dark");
  });

  it("ignores what is not a CSS variable", () => {
    applyTheme({ theme: "light", language: "en", tokens: { color: "red", "--ok": "1px" } });
    expect(root.style.getPropertyValue("color")).toBe("");
    expect(root.style.getPropertyValue("--ok")).toBe("1px");
  });

  it("adds the base styles once, unless asked not to", () => {
    applyTheme({ theme: "light", language: "en", tokens: {} });
    applyTheme({ theme: "dark", language: "en", tokens: {} });
    expect(document.querySelectorAll(`#${BASE_STYLE_ID}`)).toHaveLength(1);
    expect(document.getElementById(BASE_STYLE_ID)!.textContent).toContain("var(--color-text");
    document.getElementById(BASE_STYLE_ID)!.remove();
    applyTheme({ theme: "light", language: "en", tokens: {} }, { baseStyles: false });
    expect(document.getElementById(BASE_STYLE_ID)).toBeNull();
  });
});
