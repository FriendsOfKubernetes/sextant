import { describe, expect, it } from "vitest";

type TextTree = { [key: string]: string | TextTree };

const languages = ["de", "en", "es", "fr", "it", "ja", "ko", "pl", "pt-BR", "ru", "tr", "uk", "zh-CN", "zh-TW"];
const modules = import.meta.glob<{ default: TextTree }>("../../locales/*/filters.json", { eager: true });
const views = import.meta.glob<{ default: TextTree }>("../../locales/*/views.json", { eager: true });
const resources = import.meta.glob<{ default: TextTree }>("../../locales/*/resources.json", { eager: true });

function flatten(tree: TextTree, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [[path, value]] : Object.entries(flatten(value, path));
  }));
}

const texts = (collection: typeof modules, language: string, namespace: string) =>
  flatten(collection[`../../locales/${language}/${namespace}.json`]?.default ?? {});
const english = texts(modules, "en", "filters");
const placeholders = (value: string) => [...value.matchAll(/\{\{[^}]+\}\}/g)].map(([token]) => token).sort();
// Unit symbols and summaries made only of placeholders do not need translation.
const shared = new Set(["conditionSummary", "emptySummary", "units.B", "units.KiB", "units.MiB", "units.GiB", "units.TiB"]);
// These words have the same spelling in English and the indicated language.
const sameWords: Record<string, string[]> = { es: ["no"], fr: ["condition"], it: ["no"] };
const capturedFilters: Record<string, string> = {
  de: "Spaltenfilter", en: "column filters", es: "filtros de columna", fr: "filtres de colonnes",
  it: "filtri di colonna", ja: "列フィルター", ko: "열 필터", pl: "filtry kolumn", "pt-BR": "filtros de coluna",
  ru: "фильтры столбцов", tr: "sütun filtrelerini", uk: "фільтри стовпців", "zh-CN": "列筛选条件", "zh-TW": "欄篩選條件",
};

describe("table filter translations", () => {
  it("provides its namespace in all fourteen UI languages", () => {
    expect(Object.keys(modules).map((path) => path.split("/").at(-2)).sort()).toEqual(languages);
    expect(Object.keys(english).length).toBeGreaterThan(80);
  });

  for (const language of languages) {
    it(`${language} has every filter key and keeps interpolation tokens exactly`, () => {
      const translated = texts(modules, language, "filters");
      expect(Object.keys(translated).sort()).toEqual(Object.keys(english).sort());
      for (const [key, original] of Object.entries(english)) {
        expect(translated[key]?.trim(), key).toBeTruthy();
        expect(placeholders(translated[key] ?? ""), key).toEqual(placeholders(original));
      }
    });

    if (language !== "en") {
      it(`${language} uses translated UI text rather than English fallback copies`, () => {
        const untranslated = Object.entries(texts(modules, language, "filters"))
          .filter(([key, value]) => value === english[key] && !shared.has(key) && !sameWords[language]?.includes(key))
          .map(([key]) => key);
        expect(untranslated).toEqual([]);
        expect(texts(views, language, "views")["transfer.fields.tableFilters"]).not.toBe("table filters");
      });
    }

    it(`${language} names table filters in saved views and transfers`, () => {
      const translated = texts(views, language, "views");
      expect(translated["transfer.fields.tableFilters"]?.trim()).toBeTruthy();
      expect(translated["save.captures"]).toContain(capturedFilters[language]);
    });
  }

  it("uses established Russian column terms and standalone unit labels", () => {
    const ru = texts(modules, "ru", "filters");
    expect(ru.column).toBe("Столбец");
    expect(ru.columnSearch).toContain("столбец");
    expect(texts(views, "ru", "views")["table.columns"]).toBe("Столбцы");
    expect(texts(resources, "ru", "resources")["columns.status"]).toBe("Состояние");
    expect(ru["units.millicores"]).toBe("Миллиядра (mCPU)");
    expect(ru["units.cores"]).toBe("Ядра CPU");
    expect(ru["units.seconds"]).toBe("Секунды");
    expect(ru["units.minutes"]).toBe("Минуты");
    expect(ru["units.hours"]).toBe("Часы");
    expect(ru["units.days"]).toBe("Дни");
  });

  it("keeps Simplified and Traditional Chinese scripts and column terminology distinct", () => {
    const simplified = texts(modules, "zh-CN", "filters");
    const traditional = texts(modules, "zh-TW", "filters");
    expect(simplified.title).toBe("筛选器");
    expect(traditional.title).toBe("篩選器");
    expect(simplified.column).toBe("列");
    expect(traditional.column).toBe("欄");
    expect(simplified.clearAll).toContain("清除所有筛选");
    expect(traditional.clearAll).toContain("清除所有篩選");
    expect(simplified.columnSearch).toContain("查找");
    expect(traditional.columnSearch).toContain("尋找");
  });
});
