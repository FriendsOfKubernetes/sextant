import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { buildResources, languagesOf, namespacesOf } from "./resources";

const modules = import.meta.glob("../locales/*/*.json", { eager: true });

export const resources = buildResources(modules);
/** Languages found in `src/locales/` (directory names), e.g. `["en"]`. */
export const availableLanguages = languagesOf(resources);
export const namespaces = namespacesOf(resources);
export const FALLBACK_LANGUAGE = "en";

/** Initializes i18next synchronously. A missing key renders as the key itself. */
export function initI18n(language: string = FALLBACK_LANGUAGE): typeof i18n {
  if (i18n.isInitialized) {
    if (i18n.language !== language) void i18n.changeLanguage(language);
    return i18n;
  }
  void i18n.use(initReactI18next).init({
    resources,
    lng: availableLanguages.includes(language) ? language : FALLBACK_LANGUAGE,
    fallbackLng: FALLBACK_LANGUAGE,
    ns: namespaces,
    defaultNS: "common",
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
    react: { useSuspense: false },
  });
  return i18n;
}

/** Switches the UI language if it is one of `availableLanguages`. */
export function setLanguage(language: string): void {
  if (availableLanguages.includes(language) && i18n.language !== language) {
    void i18n.changeLanguage(language);
  }
}

export { buildResources, languagesOf, namespacesOf } from "./resources";
export { i18n };
