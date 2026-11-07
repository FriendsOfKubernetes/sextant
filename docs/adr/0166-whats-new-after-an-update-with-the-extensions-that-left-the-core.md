# ADR-0166: "What's new" after an update, with the extensions that left the core

## Context

0.30.0 moves Flux, Argo CD, Argo Rollouts and Argo Workflows out of Sextant into its own extensions (ADR-0162). A user
who updates sees their sections gone until the extensions are installed; the sidebar offers each one only in a
connected cluster that runs the tool. An update needs to say what changed once, at start, and offer the four
extensions in one place.

## Decision

- **When.** `AppSettings.whatsNew.seenVersion` (frontend-written, read leniently: only `major.minor.patch`) is the
  newest notes the user has seen. The settings migration to version 3 writes `0.29.0` there for a file of an earlier
  Sextant, so an update shows the 0.30.0 notes; a fresh install has none, and the window writes the newest version at
  once without opening. Notes newer than the seen version open the window once at start; closing it (or "Install")
  remembers the newer of the app's version and the newest notes. About → "What's new" opens the latest notes again.
- **What.** The notes are per version in `src/features/whats-new/notes.ts`, each item a title and a sentence in
  `whatsnew:<v0_30_0>.<item>` in every language. A version lists the extensions of Sextant's own that replaced built-in
  views in it; each shows "Installed" or "Install", which closes the window and opens the catalog's own install in
  Settings → Extensions (`requestCatalogInstall`: the package checked, then the consent window). With the catalog off
  the window says to turn it on (the request waits for it, ADR-0162).
- **Tests and demos** write `whatsNew.seenVersion` high in their profiles so the window does not cover a scenario.

## Consequences

- A release that changes something a user must act on adds an entry to `NOTES` and its texts in every language.
- The four extensions must be in the catalog before 0.30.0 is released, or "Install" answers that the catalog does
  not list them.
