// Translating an extension's own texts into Sextant's UI language (`context.language`), ADR-0140. Catalogs are
// plain JSON objects bundled with the page (`import ru from "./locales/ru.json"`): a frame has no network. A key
// with plural forms has one entry per CLDR category of the language (`_one`, `_few`, `_many`, `_other`, …), as
// Sextant's own catalogs do; `{{name}}` is replaced by a value. English is the fallback for any missing text.
//
//   const i18n = createI18n({ en, ru, de }, sextant.context.language);
//   i18n.t("pods", { count: 3 });          // "3 pods" / "3 пода"
//   i18n.formatNumber(1234.5);             // in the UI language
//
// `catalogProblems` checks catalogs in a test, by the rules of Sextant's own: the same keys as English, the same
// placeholders, exactly the language's plural forms, no empty text.

/** Key → text. */
export type Catalog = Readonly<Record<string, string>>;
/** Language tag → its catalog; `en` is required. */
export type Catalogs = Readonly<Record<string, Catalog>>;

export type TranslationValues = Readonly<Record<string, string | number>>;

export interface I18n {
  /** The catalog's language chosen for the UI language: one of the catalogs' tags. */
  readonly language: string;
  /** The text of `key` with `{{…}}` replaced; with a numeric `count`, its plural form. English, then the key itself. */
  t(key: string, values?: TranslationValues): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDateTime(value: number | Date, options?: Intl.DateTimeFormatOptions): string;
  /** "a, b and c" in the language. */
  formatList(items: readonly string[], type?: "conjunction" | "disjunction"): string;
}

/** The plural suffixes CLDR knows. */
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
const PLURAL_SUFFIX = new RegExp(`_(${PLURAL_CATEGORIES.join("|")})$`);

function chineseOf(subtags: readonly string[]): string {
  const traditional = subtags.some((s) => s === "hant" || s === "tw" || s === "hk" || s === "mo");
  return traditional ? "zh-TW" : "zh-CN";
}

/**
 * The first of `tags` that one of `available` serves, as Sextant matches its own languages: the exact code, then by
 * the primary language subtag — Chinese by script or region (`zh-Hant`/`zh-TW`/`zh-HK`/`zh-MO` → `zh-TW`, else
 * `zh-CN`, never the other script), any Portuguese → `pt-BR`. `undefined` if none matches.
 */
export function matchLanguage(tags: readonly string[], available: readonly string[]): string | undefined {
  const byLower = new Map(available.map((code) => [code.toLowerCase(), code]));
  for (const tag of tags) {
    const subtags = tag.trim().toLowerCase().replaceAll("_", "-").split("-").filter(Boolean);
    const primary = subtags[0];
    if (!primary) continue;
    const exact = byLower.get(subtags.join("-"));
    if (exact) return exact;
    const special = primary === "zh" ? chineseOf(subtags) : primary === "pt" ? "pt-BR" : undefined;
    if (special && byLower.has(special.toLowerCase())) return byLower.get(special.toLowerCase());
    if (primary === "zh") continue;
    const plain = byLower.get(primary);
    if (plain) return plain;
    const sameLanguage = available.find((code) => code.toLowerCase().split("-")[0] === primary);
    if (sameLanguage) return sameLanguage;
  }
  return undefined;
}

/** `{{name}}` replaced by its value (numbers formatted); an unknown name stays as written. */
function fill(text: string, values: TranslationValues | undefined, number: (n: number) => string): string {
  if (!values) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? number(value) : value;
  });
}

/** Translations for `language` (a UI language such as `pt-BR`) from `catalogs`, English for whatever is missing. */
export function createI18n(catalogs: Catalogs, language: string): I18n {
  const english = catalogs.en ?? {};
  const chosen = matchLanguage([language], Object.keys(catalogs)) ?? "en";
  const catalog = catalogs[chosen] ?? english;
  const plurals = new Intl.PluralRules(chosen);
  const englishPlurals = new Intl.PluralRules("en");
  const numbers = new Intl.NumberFormat(chosen);
  const number = (n: number) => numbers.format(n);

  const lookup = (key: string, count: number | undefined): string | undefined => {
    if (count !== undefined) {
      const own = catalog[`${key}_${plurals.select(count)}`];
      if (own !== undefined) return own;
      const fallback = english[`${key}_${englishPlurals.select(count)}`];
      if (fallback !== undefined) return fallback;
    }
    return catalog[key] ?? english[key];
  };

  return {
    language: chosen,
    t(key, values) {
      const count = typeof values?.count === "number" ? values.count : undefined;
      return fill(lookup(key, count) ?? key, values, number);
    },
    formatNumber: (value, options) => new Intl.NumberFormat(chosen, options).format(value),
    formatDateTime: (value, options) => new Intl.DateTimeFormat(chosen, options).format(value),
    formatList: (items, type = "conjunction") => new Intl.ListFormat(chosen, { type }).format(items),
  };
}

const placeholdersOf = (text: string) =>
  [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!).sort();

/**
 * What is wrong with `catalogs` against English (`en`), as one line per problem; empty when nothing is. Every
 * language has the keys English has (a plural key with exactly the language's CLDR forms instead of English's), no
 * other key, no empty text, and the same `{{placeholders}}` as English.
 */
export function catalogProblems(catalogs: Catalogs): string[] {
  const english = catalogs.en;
  if (!english) return ["there is no `en` catalog"];
  const problems: string[] = [];
  // Plain keys, and plural keys by their base.
  const englishPlural = new Map<string, string>();
  const plain = new Set<string>();
  for (const key of Object.keys(english)) {
    const match = PLURAL_SUFFIX.exec(key);
    if (match) englishPlural.set(key.slice(0, -match[0].length), english[key]!);
    else plain.add(key);
  }
  for (const [language, catalog] of Object.entries(catalogs)) {
    const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories as readonly string[];
    const expected = new Map<string, string>();
    for (const key of plain) expected.set(key, english[key]!);
    for (const [base] of englishPlural) {
      const forms = language === "en" ? new Intl.PluralRules("en").resolvedOptions().pluralCategories : categories;
      const englishText = english[`${base}_other`] ?? englishPlural.get(base)!;
      for (const form of forms) expected.set(`${base}_${form}`, englishText);
    }
    for (const [key, source] of expected) {
      const text = catalog[key];
      if (text === undefined) {
        problems.push(`${language}: \`${key}\` is missing`);
        continue;
      }
      if (text.trim() === "") problems.push(`${language}: \`${key}\` is empty`);
      if (placeholdersOf(text).join(",") !== placeholdersOf(source).join(",")) {
        problems.push(`${language}: \`${key}\` has other placeholders than English`);
      }
    }
    for (const key of Object.keys(catalog)) {
      if (!expected.has(key)) problems.push(`${language}: \`${key}\` is not a key of English`);
    }
  }
  return problems;
}
