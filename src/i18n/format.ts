// Dates, numbers and lists in the UI language (not the OS locale, which `toLocaleString()` without a locale uses):
// a German UI shows "18.10.2026, 15:04:05" and "1,5" even on an English system.
import i18n from "i18next";

/** The language i18next renders now (`en` before it starts). */
export function currentLanguage(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? "en";
}

type Instant = number | string | Date;

const toDate = (value: Instant) => (value instanceof Date ? value : new Date(value));

/** Date and time, the language's default style ("10/18/2026, 3:04:05 PM" in English). */
export function formatDateTime(value: Instant): string {
  return toDate(value).toLocaleString(currentLanguage());
}

/** Time of day, the language's default style ("3:04:05 PM" in English). */
export function formatTime(value: Instant): string {
  return toDate(value).toLocaleTimeString(currentLanguage());
}

/**
 * A number with exactly `digits` fraction digits (like `toFixed`) and the language's decimal sign; no grouping, so
 * "1250" stays one token next to a unit ("1.50" in English, "1,50" in German).
 */
export function formatNumber(value: number, digits = 0): string {
  // Building a formatter is far dearer than using one: they are kept per language and digits.
  const key = `${currentLanguage()}|${digits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(currentLanguage(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    });
    numberFormats.set(key, format);
  }
  return format.format(value);
}
const numberFormats = new Map<string, Intl.NumberFormat>();

/** The language's separator of list items (`common:list.separator`: ", " in English, "、" in Japanese). */
export function listSeparator(): string {
  return i18n.t("common:list.separator", { defaultValue: ", " });
}

/**
 * Items joined with the language's list separator (`common:list.separator`: ", " in English, "、" in Japanese). For
 * names and values, not for a sentence: a sentence takes the whole list as one placeholder.
 */
export function formatList(items: readonly string[]): string {
  return items.join(listSeparator());
}

/** The language's separator of parts of one line (`common:list.dot`: " · "): "eu-west-1 · 1.31 · ACTIVE". */
export function dotSeparator(): string {
  return i18n.t("common:list.dot", { defaultValue: " · " });
}

/** Parts of one line (values, labels) joined with `common:list.dot`; for parts that are not one list of names. */
export function formatParts(items: readonly string[]): string {
  return items.join(dotSeparator());
}
