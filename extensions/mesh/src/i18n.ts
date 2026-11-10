// The extension's texts in Sextant's UI language (ADR-0140): one catalog per language Sextant has, bundled with the
// page, made of the built-in mesh views' own texts (`mesh`, the `mesh*` problem messages, the request-health and
// list-separator words they used) word for word. `setLanguage` follows `context.language`; `t` and the formatters use
// the chosen catalog, English for what is missing. `locales.test.ts` keeps every catalog equal to English in keys,
// placeholders and plural forms.
import { createI18n, type I18n, type TranslationValues } from "@sextant/extension-sdk";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import pl from "./locales/pl.json";
import ptBR from "./locales/pt-BR.json";
import ru from "./locales/ru.json";
import tr from "./locales/tr.json";
import uk from "./locales/uk.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";

export const CATALOGS: Record<string, Record<string, string>> = {
  en,
  de,
  es,
  fr,
  it,
  ja,
  ko,
  pl,
  "pt-BR": ptBR,
  ru,
  tr,
  uk,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

let current: I18n = createI18n(CATALOGS, "en");

/** Chooses the catalog for Sextant's UI language. */
export function setLanguage(language: string): void {
  if (language !== current.language) current = createI18n(CATALOGS, language);
}

export function t(key: string, values?: TranslationValues): string {
  return current.t(key, values);
}

/** Whether the chosen catalog (or English) has `key`: the built-in's `defaultValue` fallbacks. */
export function has(key: string): boolean {
  return Object.hasOwn(CATALOGS[current.language] ?? {}, key) || Object.hasOwn(CATALOGS.en!, key);
}

/** `t(key)`, or `fallback` where no catalog has it (i18next's `defaultValue`). */
export function tOr(key: string, fallback: string, values?: TranslationValues): string {
  return has(key) ? t(key, values) : fallback;
}

/** The formatters of the chosen language. */
export function i18n(): I18n {
  return current;
}

/** The language's list separator (", " in English, "、" in Japanese), as Sextant's `listSeparator`. */
export function listSeparator(): string {
  return tOr("list.separator", ", ");
}

/** Items joined with the language's list separator, as Sextant's `formatList` (names and values, not a sentence). */
export function formatList(items: readonly string[]): string {
  return items.join(listSeparator());
}
