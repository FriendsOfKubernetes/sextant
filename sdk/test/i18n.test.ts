// Translating an extension's texts (ADR-0140): the language chosen as Sextant chooses its own, plural forms by CLDR,
// English for what is missing, and the catalog check.
import { describe, expect, it } from "vitest";
import { matchLanguage as sextantMatch } from "../../src/i18n";
import { catalogProblems, createI18n, matchLanguage } from "../src/i18n";

const en = { title: "Pools", pods_one: "{{count}} pod", pods_other: "{{count}} pods", hello: "Hello, {{name}}" };
const ru = {
  title: "Пулы",
  pods_one: "{{count}} под",
  pods_few: "{{count}} пода",
  pods_many: "{{count}} подов",
  pods_other: "{{count}} пода",
  hello: "Привет, {{name}}",
};

describe("createI18n", () => {
  it("translates into the UI language with its plural forms and numbers", () => {
    const i18n = createI18n({ en, ru }, "ru");
    expect(i18n.language).toBe("ru");
    expect(i18n.t("title")).toBe("Пулы");
    expect([1, 3, 5, 21, 1500].map((count) => i18n.t("pods", { count }))).toEqual([
      "1 под",
      "3 пода",
      "5 подов",
      "21 под",
      "1 500 подов",
    ]);
    expect(i18n.t("hello", { name: "Ceph" })).toBe("Привет, Ceph");
    expect(i18n.formatList(["a", "b", "c"])).toBe("a, b и c");
  });

  it("falls back to English, then to the key", () => {
    const i18n = createI18n({ en, ru: { title: "Пулы" } }, "ru");
    expect(i18n.t("hello", { name: "x" })).toBe("Hello, x");
    expect(i18n.t("pods", { count: 2 })).toBe("2 pods");
    expect(i18n.t("missing")).toBe("missing");
    expect(createI18n({ en, ru }, "ja").language).toBe("en");
    expect(i18n.t("hello")).toBe("Hello, {{name}}");
  });

  it("chooses the catalog as Sextant chooses its own language", () => {
    const available = ["en", "de", "pt-BR", "zh-CN", "zh-TW"];
    for (const tag of ["de-AT", "pt", "pt-PT", "zh-Hant-HK", "zh-SG", "zh", "fr", "DE", "zh_TW"]) {
      expect(matchLanguage([tag], available), tag).toBe(sextantMatch([tag], available));
    }
    expect(createI18n({ en, "zh-TW": { title: "池" } }, "zh-HK").t("title")).toBe("池");
    expect(createI18n({ en, "zh-TW": { title: "池" } }, "zh-CN").language).toBe("en");
  });
});

describe("catalogProblems", () => {
  it("accepts catalogs with the same keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems({ en, ru })).toEqual([]);
    expect(catalogProblems({ en, ja: { title: "プール", pods_other: "{{count}} 個のポッド", hello: "こんにちは、{{name}}" } })).toEqual([]);
  });

  it("names what is missing, extra, empty or has other placeholders", () => {
    expect(
      catalogProblems({
        en,
        de: { title: " ", pods_one: "{{count}} Pod", pods_other: "Pods", hello: "Hallo", extra: "x" },
        ja: { title: "x", pods_one: "{{count}}", pods_other: "{{count}}", hello: "{{name}}" },
      }),
    ).toEqual([
      "de: `title` is empty",
      "de: `hello` has other placeholders than English",
      "de: `pods_other` has other placeholders than English",
      "de: `extra` is not a key of English",
      "ja: `pods_one` is not a key of English",
    ]);
    expect(catalogProblems({ ru: {} })).toEqual(["there is no `en` catalog"]);
  });
});
