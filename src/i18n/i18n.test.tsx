import { render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../api";
import {
  availableLanguages,
  buildResources,
  currentLanguage,
  FALLBACK_LANGUAGE,
  formatDateTime,
  formatList,
  formatNumber,
  i18n,
  LANGUAGE_HINT_KEY,
  languagesOf,
  matchLanguage,
  namespaces,
  resolveLanguage,
  setLanguage,
  startupLanguage,
  SYSTEM_LANGUAGE,
} from "./index";

function Label({ k }: { k: string }) {
  const { t } = useTranslation();
  return <span data-testid="label">{t(k)}</span>;
}

describe("i18n", () => {
  it("renders strings from src/locales/en", () => {
    render(<Label k="common:app.name" />);
    expect(screen.getByTestId("label")).toHaveTextContent("Sextant");
  });

  it("renders a missing key as the key instead of failing", () => {
    render(<Label k="common:no.such.key" />);
    expect(screen.getByTestId("label")).toHaveTextContent("no.such.key");
  });

  it("finds languages and namespaces from the locale directories", () => {
    expect(availableLanguages).toContain("en");
    expect(namespaces).toEqual(expect.arrayContaining(["common", "errors"]));
  });

  it("a new directory is a new language", () => {
    const resources = buildResources({
      "../locales/en/common.json": { default: { a: "A" } },
      "../locales/de/common.json": { default: { a: "Ä" } },
      "../locales/de/errors.json": { default: { other: "Fehler" } },
    });
    expect(languagesOf(resources)).toEqual(["de", "en"]);
    expect(resources.de?.errors).toEqual({ other: "Fehler" });
  });

  it("has a text for every error code", async () => {
    const { ERROR_CODES } = await import("../api");
    const errors = (await import("../locales/en/errors.json")).default as Record<string, string>;
    for (const code of ERROR_CODES) expect(errors[code], code).toBeTruthy();
  });
});

describe("language choice", () => {
  const ALL = ["de", "en", "es", "fr", "it", "ja", "ko", "pl", "pt-BR", "ru", "tr", "uk", "zh-CN", "zh-TW"];

  it("maps OS tags to the language directories", () => {
    const cases: [string[], string | undefined][] = [
      [["de-AT"], "de"],
      [["ru_RU.UTF-8".split(".")[0] ?? ""], "ru"],
      [["zh-Hans-CN"], "zh-CN"],
      [["zh-SG"], "zh-CN"],
      [["zh"], "zh-CN"],
      [["zh-Hant"], "zh-TW"],
      [["zh-HK"], "zh-TW"],
      [["zh-TW"], "zh-TW"],
      [["pt"], "pt-BR"],
      [["pt-PT"], "pt-BR"],
      [["PT-br"], "pt-BR"],
      [["en-GB"], "en"],
      [["sv-SE", "fr-CA"], "fr"],
      [["sv-SE", "nb"], undefined],
      [[], undefined],
    ];
    for (const [tags, expected] of cases) expect(matchLanguage(tags, ALL), tags.join()).toBe(expected);
    expect(matchLanguage(["zh-TW"], ["en", "zh-CN"]), "no Traditional directory").toBe(undefined);
  });

  it("follows the system on a new install, keeps a stored choice, and falls back to English", () => {
    expect(SYSTEM_LANGUAGE).toBe(defaultAppSettings().language);
    expect(resolveLanguage("system", ["en-US"])).toBe("en");
    expect(resolveLanguage("", ["sv-SE"])).toBe(FALLBACK_LANGUAGE);
    expect(resolveLanguage("system", ["xx-YY"])).toBe("en");
    expect(resolveLanguage("en", ["de-DE"])).toBe("en");
    expect(resolveLanguage("no-such-language", ["de-DE"])).toBe("en");
  });

  it("a key or a whole file a language lacks reads in English, and so does an empty text", async () => {
    i18n.addResourceBundle("xx", "common", { actions: { close: "Schließen", cancel: "" } });
    await i18n.changeLanguage("xx");
    try {
      expect(i18n.t("common:actions.close")).toBe("Schließen");
      expect(i18n.t("common:actions.retry")).toBe("Retry");
      expect(i18n.t("common:actions.cancel")).toBe("Cancel");
      expect(i18n.t("settings:appearance.language")).toBe("Language");
    } finally {
      await i18n.changeLanguage("en");
      i18n.removeResourceBundle("xx", "common");
    }
  });

  it("formats dates, numbers and lists in the UI language", async () => {
    expect(formatNumber(1.5, 2)).toBe("1.50");
    expect(formatNumber(1250)).toBe("1250");
    expect(formatList(["a", "b"])).toBe("a, b");
    i18n.addResourceBundle("de", "common", { list: { separator: "; " } });
    await i18n.changeLanguage("de");
    try {
      expect(currentLanguage()).toBe("de");
      expect(formatNumber(1.5, 2)).toBe("1,50");
      expect(formatList(["a", "b"])).toBe("a; b");
      expect(formatDateTime(Date.UTC(2026, 9, 18, 12))).toMatch(/18\.10\.2026/);
    } finally {
      await i18n.changeLanguage("en");
      i18n.removeResourceBundle("de", "common");
    }
  });
});

describe("start-up language", () => {
  afterEach(() => {
    localStorage.removeItem(LANGUAGE_HINT_KEY);
    setLanguage("en");
    localStorage.removeItem(LANGUAGE_HINT_KEY);
  });

  it("is the system's on a new install, then the language applied last", () => {
    localStorage.removeItem(LANGUAGE_HINT_KEY);
    expect(startupLanguage(["en-US"])).toBe("en");
    expect(startupLanguage(["sv-SE"])).toBe(FALLBACK_LANGUAGE);
    // An explicit English on a non-English OS starts in English next time (no flash of the OS language).
    setLanguage("en");
    expect(localStorage.getItem(LANGUAGE_HINT_KEY)).toBe("en");
    expect(startupLanguage(["de-DE"])).toBe("en");
  });

  it("ignores a hint of a language that is gone, and works without storage", () => {
    localStorage.setItem(LANGUAGE_HINT_KEY, "xx-removed");
    expect(startupLanguage(["en-GB"])).toBe("en");
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(startupLanguage(["en-US"])).toBe("en");
    } finally {
      spy.mockRestore();
    }
  });
});
