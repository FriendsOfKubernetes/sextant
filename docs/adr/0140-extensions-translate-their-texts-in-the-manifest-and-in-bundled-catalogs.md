# ADR-0140: Extensions translate their texts in the manifest and in bundled catalogs

## Context

Sextant's interface is in 14 languages (ADR-0073), but an extension could speak only one (#323). Its texts reach the
user two ways:

- **Manifest texts** are shown by Sextant itself: the name and description, page, section, tab, column, action, dock
  and settings titles, problem rule titles and messages, metric query titles and backend credential labels. They
  appear in the sidebar, the details panel, tables, the Problems page, notifications and the consent screen.
- **Page texts** are drawn by the extension's own frames. The context gives `language`, but the SDK offered no
  catalogs, plural rules or formatting.

#320 makes "every language" the bar for any feature that moves from the core into an extension, and Rook Ceph (#319)
is the first.

## Decision

- **Manifest texts are translated in the manifest.** The optional `translations` field (sextantApi 2) maps a language
  tag to text keys and their texts:

  ```json
  "translations": { "ru": { "name": "…", "pages.overview.title": "…", "problems.health-error.message": "…" } }
  ```

  - **Keys** name the texts: `name`, `description`, `pages.<id>.title`, `pages.<id>.sectionTitle`,
    `detailsSections.<id>.title`, `actions.<id>.title`, `columns.<id>.title`, `dockActions.<id>.title`,
    `settings.title`, `problems.<id>.title`, `problems.<id>.message`, `metricQueries.<id>.title` and
    `backend.credentials.<id>.label`.
  - **English is the manifest itself.** `en` is not a translation, and a text not translated is shown in English.
  - **What is never translated**: ids, kinds, paths, permissions, metric queries and every other non-text field.
  - **Why in the manifest**: the translations travel wherever the manifest goes (the package, its signature, the
    consent, the installed copy). They need no other file to be read, checked or kept.
- **Checked when the manifest is read, the same way in Rust and the SDK.** `check_translations` and
  `checkTranslations` share the cases in `manifest-cases.json`. They check:
  - the language tag (`de`, `pt-BR`, `zh-CN`, `sr-Latn`, `es-419`);
  - that every key names a text this manifest has;
  - that each translation keeps the limits of its text: titles and labels 80 characters, the description 500, a
    message 300;
  - that a problem message keeps exactly the English message's `{{…}}` placeholders, so a translation never reads a
    field the English one did not;
  - that rule titles stay unique in every language.

  At most 30 languages of 300 texts each. Translations need sextantApi 2, like the other additions of 0.28. To make
  the schema able to say this, the manifest's schema validator learned `additionalProperties` as a schema (a map) and
  `maxProperties`, in both copies.
- **The window shows the UI language's translation.** `localizeManifest` (`src/extensions/localize.ts`) picks the
  translation as Sextant picks its own language (`matchLanguage`: exact, then by language; Chinese by script; any
  Portuguese to `pt-BR`). It applies only to texts.
  - `useExtensions`/`useExtension` return localized extensions, so the registrations, the extension list and the
    problem category follow a change of language: their signature changes with the texts.
  - The consent screen shows the localized texts. The metric queries and permissions it lists are never translated.
- **Pages translate with the SDK's `createI18n`.** `sdk/src/i18n.ts` takes catalogs the page bundles (`import ru from
  "./locales/ru.json"`, since a frame has no network) and gives:
  - `t(key, values)`, with CLDR plural forms chosen by `Intl.PluralRules` (`_one`, `_few`, `_many`, `_other`, …),
    `{{name}}` replaced and numbers formatted, English then the key as the fallback;
  - number, date and list formatting in the chosen language;
  - `matchLanguage`, kept equal to Sextant's by a test.

  `catalogProblems` checks catalogs by Sextant's own rules: English's keys, the same placeholders, exactly each
  language's plural forms, no empty text. An extension's test runs it.
- **The index of the catalog stays English.** Its names and descriptions come from the reviewed entries; a
  translated catalog listing can come later.

## Consequences

- An extension written for 0.28 can speak every language Sextant does. Rook Ceph does: its manifest and its 210 page
  texts are in all 14 languages, and its tests keep them complete.
- A language added to Sextant shows existing extensions in English until they add it; nothing breaks.
- Manifest text keys follow the contribution ids, so renaming an id renames its translation keys. A translation of
  a text the manifest no longer has refuses the manifest, rather than being kept silently.
