import { render, screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { describe, expect, it } from "vitest";
import { availableLanguages, buildResources, languagesOf, namespaces } from "./index";

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
