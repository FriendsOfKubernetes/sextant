import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { buildResources, languagesOf, namespacesOf } from "./resources";

const modules = import.meta.glob("../locales/*/*.json", { eager: true });

export const resources = buildResources(modules);
/** Languages found in `src/locales/` (directory names), e.g. `["en", "ru", "zh-CN"]`. */
export const availableLanguages = languagesOf(resources);
export const namespaces = namespacesOf(resources);
export const FALLBACK_LANGUAGE = "en";
/**
 * `AppSettings.language` of "follow the operating system": the default of a new install. A stored code (`"en"`,
 * `"de"`) is the user's explicit choice and wins; an empty value reads as "system" too.
 */
export const SYSTEM_LANGUAGE = "system";

/** The languages the platform prefers, most preferred first (the webview reports the OS language). */
export function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/** The directory for a Chinese tag: Traditional for `Hant` and the regions that write it, Simplified otherwise. */
function chineseOf(subtags: readonly string[]): string {
  const traditional = subtags.some((s) => s === "hant" || s === "tw" || s === "hk" || s === "mo");
  return traditional ? "zh-TW" : "zh-CN";
}

/**
 * The first of `tags` (BCP 47, e.g. `de-AT`, `zh-Hant-HK`, `pt_PT`) that one of `available` serves: the exact code,
 * then by the primary language subtag — Chinese by script/region (`zh-Hans`/`zh-CN`/`zh-SG` → `zh-CN`,
 * `zh-Hant`/`zh-TW`/`zh-HK`/`zh-MO` → `zh-TW`, never the other script), any Portuguese → `pt-BR`. `undefined` if
 * none matches.
 */
export function matchLanguage(tags: readonly string[], available: readonly string[] = availableLanguages): string | undefined {
  const byLower = new Map(available.map((code) => [code.toLowerCase(), code]));
  for (const tag of tags) {
    const subtags = tag.trim().toLowerCase().replaceAll("_", "-").split("-").filter(Boolean);
    const primary = subtags[0];
    if (!primary) continue;
    const exact = byLower.get(subtags.join("-"));
    if (exact) return exact;
    const special = primary === "zh" ? chineseOf(subtags) : primary === "pt" ? "pt-BR" : undefined;
    if (special && byLower.has(special.toLowerCase())) return byLower.get(special.toLowerCase());
    // One Chinese script never stands in for the other: without it the next tag (or English) is taken.
    if (primary === "zh") continue;
    const plain = byLower.get(primary);
    if (plain) return plain;
    const sameLanguage = available.find((code) => code.toLowerCase().split("-")[0] === primary);
    if (sameLanguage) return sameLanguage;
  }
  return undefined;
}

/**
 * The UI language for the `AppSettings.language` setting: "system" (or empty) follows the OS when Sextant has
 * that language, otherwise English; a stored code is used when its directory exists (a code from another version is
 * matched like an OS tag, then English).
 */
export function resolveLanguage(setting: string | null | undefined, system: readonly string[] = systemLanguages()): string {
  const value = (setting ?? "").trim();
  if (value === "" || value === SYSTEM_LANGUAGE) return matchLanguage(system) ?? FALLBACK_LANGUAGE;
  if (availableLanguages.includes(value)) return value;
  return matchLanguage([value]) ?? FALLBACK_LANGUAGE;
}

/** `<html lang>` follows the UI language: the font fallback for CJK and line breaking depend on it. */
function markDocument(language: string): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

/**
 * Initializes i18next synchronously. A missing key (or an empty translation) falls back to English, a namespace file
 * a language lacks reads from English too, and a key missing everywhere renders as the key itself.
 */
export function initI18n(setting: string = FALLBACK_LANGUAGE): typeof i18n {
  const language = resolveLanguage(setting);
  if (i18n.isInitialized) {
    if (i18n.language !== language) void i18n.changeLanguage(language);
    markDocument(language);
    return i18n;
  }
  void i18n.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: FALLBACK_LANGUAGE,
    ns: namespaces,
    defaultNS: "common",
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
    initAsync: false,
    react: { useSuspense: false },
  });
  markDocument(language);
  return i18n;
}

/** Browser storage key of the language last applied: only a hint for the next start, never the setting itself. */
export const LANGUAGE_HINT_KEY = "sextant.uiLanguage";

/**
 * The language to start in before the settings load: the one applied last time (so an explicit "en" on a German
 * OS does not flash German), otherwise the system's (a new install). The saved setting then wins (`setLanguage`).
 */
export function startupLanguage(system: readonly string[] = systemLanguages()): string {
  let hint: string | null = null;
  try {
    hint = globalThis.localStorage?.getItem(LANGUAGE_HINT_KEY) ?? null;
  } catch {
    // Storage blocked or unavailable: start in the system language.
  }
  if (hint && availableLanguages.includes(hint)) return hint;
  return resolveLanguage(SYSTEM_LANGUAGE, system);
}

/** Switches the UI language to what `setting` resolves to (see [`resolveLanguage`]); returns that language. */
export function setLanguage(setting: string): string {
  const language = resolveLanguage(setting);
  if (i18n.language !== language) void i18n.changeLanguage(language);
  markDocument(language);
  try {
    globalThis.localStorage?.setItem(LANGUAGE_HINT_KEY, language);
  } catch {
    // Only a hint for the next start.
  }
  return language;
}

export { buildResources, languagesOf, namespacesOf } from "./resources";
export { currentLanguage, formatDateTime, formatList, formatNumber, formatTime, listSeparator } from "./format";
export { i18n };
