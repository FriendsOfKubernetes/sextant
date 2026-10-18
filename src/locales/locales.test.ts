// Every translation is checked against English (`src/locales/en/`), the source: the same files and keys, nothing
// missing or empty, the same {{placeholders}} and $t(…) nesting, the plural forms the language has in CLDR
// (`Intl.PluralRules`), and no markup English does not have. With only `en/` present the per-language checks are
// simply absent. How to translate: TRANSLATING.md next to this file.
import { describe, expect, it } from "vitest";
import { matchLanguage } from "../i18n";

type Tree = { [key: string]: string | Tree };

const modules = import.meta.glob<{ default: Tree }>("./*/*.json", { eager: true });

/** language → namespace → flattened keys (`a.b.c`) → text. */
const locales = new Map<string, Map<string, Map<string, string>>>();
/** Keys whose value is not a string or an object (a number, an array, null): reported per file. */
const malformed: string[] = [];

function flatten(tree: Tree, prefix: string, out: Map<string, string>, file: string): void {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path, out, file);
    else malformed.push(`${file}: ${path}`);
  }
}

for (const [path, mod] of Object.entries(modules)) {
  const match = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (!match) continue;
  const [, lang, ns] = match as unknown as [string, string, string];
  const keys = new Map<string, string>();
  flatten(mod.default, "", keys, path);
  let byNs = locales.get(lang);
  if (!byNs) locales.set(lang, (byNs = new Map()));
  byNs.set(ns, keys);
}

const SOURCE = "en";
const english = locales.get(SOURCE) ?? new Map<string, Map<string, string>>();
const translations = [...locales.keys()].filter((lang) => lang !== SOURCE).sort();

const PLURAL = /_(zero|one|two|few|many|other)$/;
/** `{{name}}`, `{{name, format}}` → `name`. */
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*([^,}\s]+)[^}]*\}\}/g)].map((m) => m[1]).sort();
/** `$t(ns:key)`, `$t(key, {…})` → the key. */
const nestings = (text: string) => [...text.matchAll(/\$t\(\s*([^,)\s]+)/g)].map((m) => m[1]).sort();
/** Anything that reads as an HTML/XML tag (`<b>`, `</a>`, `<br/>`, also `<owner>` in a URL pattern). */
const tags = (text: string) => [...text.matchAll(/<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>/g)].map((m) => m[0]).sort();

/** The base of a plural key (`added_one` → `added`), or `undefined`. */
const pluralBase = (key: string) => (PLURAL.test(key) ? key.replace(PLURAL, "") : undefined);

/** Plural bases of English: base → its English `_other` text. */
function pluralBases(keys: Map<string, string>): Map<string, string> {
  const bases = new Map<string, string>();
  for (const [key, text] of keys) {
    const base = pluralBase(key);
    if (base !== undefined && key.endsWith("_other")) bases.set(base, text);
  }
  return bases;
}

describe("English, the source", () => {
  it("has files, and every value is a string or a group of them", () => {
    expect(english.size).toBeGreaterThan(0);
    expect(malformed).toEqual([]);
  });

  it("has no empty text", () => {
    const empty = [...english].flatMap(([ns, keys]) => [...keys].filter(([, v]) => v.trim() === "").map(([k]) => `${ns}:${k}`));
    expect(empty).toEqual([]);
  });

  it("has `_one` and `_other` for every plural, with the same placeholders", () => {
    const problems: string[] = [];
    for (const [ns, keys] of english) {
      for (const key of keys.keys()) {
        const base = pluralBase(key);
        if (base === undefined) continue;
        for (const form of ["one", "other"]) {
          if (!keys.has(`${base}_${form}`)) problems.push(`${ns}:${base}_${form} is missing`);
        }
        const other = keys.get(`${base}_other`);
        if (other !== undefined && placeholders(keys.get(key) ?? "").join() !== placeholders(other).join()) {
          problems.push(`${ns}:${key} has other placeholders than ${base}_other`);
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it("every directory name is a language tag Sextant picks for itself", () => {
    for (const lang of locales.keys()) {
      expect(Intl.getCanonicalLocales(lang), lang).toEqual([lang]);
      expect(matchLanguage([lang], [...locales.keys()]), lang).toBe(lang);
    }
  });
});

type Locale = Map<string, Map<string, string>>;

/** What is wrong with `lang`'s `translated` files against English `source`; every list empty when all is well. */
export function compare(lang: string, source: Locale, translated: Locale) {
  const categories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories as string[];
  const files = { missing: [...source.keys()].filter((ns) => !translated.has(ns)), extra: [...translated.keys()].filter((ns) => !source.has(ns)) };
  const missing: string[] = [];
  const extra: string[] = [];
  const empty: string[] = [];
  const mismatched: string[] = [];
  for (const [ns, en] of source) {
    const keys = translated.get(ns);
    if (!keys) continue;
    const bases = pluralBases(en);
    for (const key of en.keys()) if (pluralBase(key) === undefined && !keys.has(key)) missing.push(`${ns}:${key}`);
    for (const base of bases.keys()) for (const form of categories) if (!keys.has(`${base}_${form}`)) missing.push(`${ns}:${base}_${form}`);
    for (const [key, text] of keys) {
      const id = `${ns}:${key}`;
      const base = pluralBase(key);
      const plural = base !== undefined && bases.has(base);
      if (plural ? !categories.includes(key.slice(base.length + 1)) : !en.has(key)) {
        extra.push(id);
        continue;
      }
      if (text.trim() === "") empty.push(id);
      // Every plural form is compared with English `_other`.
      const original = (plural ? en.get(`${base}_other`) : en.get(key)) ?? "";
      if (placeholders(text).join() !== placeholders(original).join()) {
        mismatched.push(`${id}: placeholders ${placeholders(text).join(" ")} ≠ ${placeholders(original).join(" ")}`);
      }
      if (nestings(text).join() !== nestings(original).join()) {
        mismatched.push(`${id}: $t(…) ${nestings(text).join(" ")} ≠ ${nestings(original).join(" ")}`);
      }
      if (tags(text).join() !== tags(original).join()) mismatched.push(`${id}: markup ${tags(text).join(" ")} ≠ ${tags(original).join(" ")}`);
    }
  }
  return { files, missing, extra, empty, mismatched };
}

const CLEAN = { files: { missing: [], extra: [] }, missing: [], extra: [], empty: [], mismatched: [] };

for (const lang of translations) {
  describe(`${lang} against English`, () => {
    const result = compare(lang, english, locales.get(lang) ?? new Map());
    it("has the same files", () => expect(result.files).toEqual(CLEAN.files));
    it("has every key of English (with the language's plural forms) and no other", () => {
      expect({ missing: result.missing, extra: result.extra }).toEqual({ missing: [], extra: [] });
    });
    it("has no empty text", () => expect(result.empty).toEqual([]));
    it("keeps every {{placeholder}}, $t(…) and tag of English", () => expect(result.mismatched).toEqual([]));
  });
}

describe("the comparison", () => {
  const locale = (files: Record<string, Record<string, string>>): Locale =>
    new Map(Object.entries(files).map(([ns, keys]) => [ns, new Map(Object.entries(keys))]));
  const source = locale({
    common: { close: "Close", added_one: "Added {{count}} cluster", added_other: "Added {{count}} clusters", hint: "See <b>{{name}}</b>" },
    tray: { quit: "Quit $t(common:close)" },
  });

  it("passes a complete translation with the language's plural forms", () => {
    const ru = locale({
      common: {
        close: "Закрыть",
        added_one: "Добавлен {{count}} кластер",
        added_few: "Добавлено {{count}} кластера",
        added_many: "Добавлено {{count}} кластеров",
        added_other: "Добавлено {{count}} кластера",
        hint: "См. <b>{{name}}</b>",
      },
      tray: { quit: "Выйти $t(common:close)" },
    });
    expect(compare("ru", source, ru)).toEqual(CLEAN);
    const ja = locale({ common: { close: "閉じる", added_other: "{{count}} 個追加", hint: "<b>{{name}}</b> を参照" }, tray: { quit: "終了 $t(common:close)" } });
    expect(compare("ja", source, ja)).toEqual(CLEAN);
  });

  it("reports a missing file, missing and foreign keys, plural forms, empty texts, placeholders, nesting and markup", () => {
    const broken = locale({
      common: { close: "", added_one: "{{n}} Cluster", added_other: "{{count}} Cluster", added_few: "x {{count}}", hint: "Siehe {{name}}", extra: "?" },
    });
    expect(compare("de", source, broken)).toEqual({
      files: { missing: ["tray"], extra: [] },
      missing: [],
      extra: ["common:added_few", "common:extra"],
      empty: ["common:close"],
      mismatched: ["common:added_one: placeholders n ≠ count", "common:hint: markup  ≠ </b> <b>"],
    });
    const pl = locale({ common: { close: "Zamknij", added_one: "{{count}}", added_other: "{{count}}", hint: "<b>{{name}}</b>" }, tray: { quit: "Zakończ" } });
    expect(compare("pl", source, pl)).toMatchObject({
      missing: ["common:added_few", "common:added_many"],
      mismatched: ["tray:quit: $t(…)  ≠ common:close"],
    });
  });
});
