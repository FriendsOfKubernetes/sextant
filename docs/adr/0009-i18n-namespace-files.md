# ADR-0009: Translations — a directory per language, a file per namespace

## Context

Multilingual support through translation files is mandatory (G04), although at the start the only language is English; the UI is built by parallel executors.

## Decision

Translations live in `src/locales/<lang>/<namespace>.json`, one namespace per feature (`common`, `errors`, `clusters`, `resources`, `details`, `actions`, `logs`, `terminal`, `metrics`, `portforward`, `helm`, `settings`). A new language is a new directory, and the list of languages in Settings is built from the directories found. Literals in JSX are forbidden by an ESLint rule.

## Why

- One file per language, as G04 says (`locales/<lang>.json`), was rejected: parallel executors would write to the same file. The project rule is that each writes only to their own namespaces.
- A list of languages in settings rather than from directories was rejected: adding a language would then also require a code change.
- A linter rather than an agreement, because a string that lands in markup as a literal is not translated, and that is not visible when looking at the English version.

## Consequences

- The G04 text about `locales/<lang>.json` is out of date, and the criterion "deleting a key from `en.json`" must be read as deleting a key from a namespace file. A missing key is visible as the key itself, not as a crash.
- A new language is a dozen files, not one, and all namespaces must be kept consistent.
- The rule checks only literals inside JSX. Strings can be assembled outside JSX (this is how field values are done), and a column definition accepts both a key and a ready-made title. The protection can be bypassed without violating the linter.
- Error messages come from the backend as English text (ADR-0008), and translation does not affect them.
