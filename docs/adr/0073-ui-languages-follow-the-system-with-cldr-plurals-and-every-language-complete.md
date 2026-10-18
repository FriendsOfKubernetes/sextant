# ADR-0073: UI languages follow the system, use CLDR plurals, keep Kubernetes terms, and every language is complete

## Context

Every UI string was already an i18next key (`src/locales/en/<namespace>.json`), but English was the only language, the stored `language` setting was always `"en"`, counts were glued as `n + " pods"` in places, dates and numbers followed the OS locale rather than the UI, and the tray menu (native, outside the window) was English from the build (#163). Thirteen languages are being added: Russian, Ukrainian, German, French, Spanish, Portuguese (Brazil), Italian, Polish, Turkish, Chinese (Simplified and Traditional), Japanese, Korean.

## Decision

- **"System" is the default.** `AppSettings.language` is `system` for a new install: the first OS language (`navigator.languages`) that Sextant has, matched by `matchLanguage` (exact code, then the primary subtag; Chinese by script or region and never the other script; any Portuguese → `pt-BR`), otherwise English. A directory name is an explicit choice and wins. Settings → General → Appearance → Language offers "System (<resolved language>)" and every directory found in `src/locales/`; a new directory is a new language.
- **The old default is migrated once.** Before `settingsVersion` 1 every file stored `"en"` because it was the only value, so it said nothing about the user's wish. `settings::migrate` turns a version-0 file's `"en"` into `system` and writes `settingsVersion: 1`; after that `"en"` is a real choice. `settingsVersion` is backend-owned and never goes down (`SettingsStore::update`), so an older window cannot undo the migration.
- **No flash of the wrong language.** Before the settings load, the window starts in the language it applied last time (a browser-storage hint, `sextant.uiLanguage`, never the setting itself) or the system's; the saved setting then wins. `<html lang>` follows the UI language (CJK font fallback and line breaking depend on it).
- **Plurals per CLDR, whole sentences only.** Counts use plural keys picked by `Intl.PluralRules`; English has `_one` and `_other`, and each language has exactly its CLDR categories (`_one/_few/_many/_other` for ru, uk, pl; `_one/_many/_other` for fr, es, it, pt-BR; `_other` only for zh, ja, ko). Every form keeps `{{count}}` — Russian `_one` is also 21 and 101 — and a text for exactly one object without a number is a separate key. Keys are never glued into a sentence; a list goes into one placeholder, joined by `common:list.separator`.
- **Formats in the UI language.** Dates, times, numbers and lists go through `src/i18n/format.ts` with the UI language, not the OS locale.
- **Kubernetes terms stay English.** Kinds and API terms (Pod, Deployment, namespace, ConfigMap, kubeconfig, field names), product names, commands, units of quantities and status reasons are kept as is inside translated sentences; common words (cluster, node, container, log) are translated by a shared glossary. The rules and the glossary are in `src/locales/TRANSLATING.md`.
- **Completeness is enforced by a test.** `src/locales/locales.test.ts` compares every language with English: the same files and keys, no empty text, the same `{{placeholders}}`, `$t(…)` nesting and tag-like text, exactly the language's plural forms, and directory names Sextant can pick. A string added to English without all translations fails `npm run check`. At run time a missing key still falls back to English (`fallbackLng`), but a release does not rely on it.
- **The tray follows the window.** The tray menu starts in English (`tray.json` compiled in) and is relabelled whenever the window's language changes (`tray_set_texts`, `src/features/settings/trayTexts.ts`); desktop notifications use the UI language.
- **Right-to-left languages are deferred.** Arabic, Hebrew and Persian need layout work (mirroring, `dir`, icons with direction) and are a separate step. Documentation (wiki, ADRs, AGENTS.md) stays in English (ADR-0046).

## Why

- Keeping `"en"` as the default was rejected: a user on a German system would never see the German interface unless they found the setting, and the existing files could not tell a choice from the default without the migration.
- `_one`/`_other` everywhere was rejected: it is wrong for Slavic languages (2–4 vs 5+) and pointless for Chinese, Japanese and Korean; CLDR through `Intl.PluralRules` is what i18next already uses.
- Translating Kubernetes kinds was rejected: the user types them in `kubectl`, reads them in YAML and searches for them in documentation; a translated "Pod" would match none of these.
- Allowing incomplete languages (English fallback only) was rejected: mixed-language screens look broken and hide which strings were forgotten; the test makes the gap visible when the string is added.

## Consequences

- **Every new UI string needs all languages in the same change**, or the locales test fails: a feature is not done until its strings exist in every directory of `src/locales/`.
- Texts grow (German and Russian by a third): buttons and tabs must not depend on English lengths.
- Native speakers can correct translations through issues and pull requests; the glossary keeps a word the same across namespaces.

## Amendments

- Amended (v0.10.0): only English is in the main bundle; every other language is a chunk of its own, read when it is chosen and, for the start language, before the first render, so there is still no flash of English. A text with two numbers agrees with one of them only (`count`); the other stands where no noun agrees with it ("limit: {{max}}", "of {{total}}"). A case that changes the wording (all namespaces or some, a redirect's target, a cloud problem with or without its account) is a key of its own rather than a fragment glued into a sentence.
