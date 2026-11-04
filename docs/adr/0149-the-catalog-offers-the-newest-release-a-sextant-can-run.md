# ADR-0149: The catalog offers the newest release a Sextant can run

## Context

Each catalog entry listed one release, `latest` (ADR-0130). Once an extension published a release for a newer
extension API, a Sextant that had not been updated showed only "needs a newer Sextant". It could install nothing
and update to nothing, though the release it could run was still published and signed. ADR-0142 promises that older
extensions keep working on newer Sextants; this is the other direction: a newer extension must not leave an older
Sextant without the extension (#337).

Sextant 0.26–0.28 read an entry strictly: an entry with a field they do not know is dropped from their catalog. A
top-level key of the index they do not know, they ignore.

## Decision

- **Earlier releases in a top-level key.** The index gets `earlier`, a top-level object from an entry's id to its
  earlier releases. It is never a field of the entry, so Sextant 0.26–0.28 read their catalog exactly as before.
  - For each entry it holds the newest release for each extension API older than `latest`'s, newest first, at most
    5 (`MAX_EARLIER`).
  - Each release is older than, and of a lower `sextantApi` than, the one before it (`latest` first).
  - Each is a release block like `latest`, checked by the catalog's workflow the same way before it is listed: one
    signed package of the id, its size, SHA-256 and signature by the entry's key, and the manifest's id and version.
- **The SDK and the workflow.** The SDK (`sdk/scripts/catalog.mjs`) gives the rules:
  - `pickReleases` gives every candidate release, newest first;
  - `pickEarlier` chooses the earlier ones from the checked releases;
  - `buildIndex` writes `earlier` from the results' `earlier`, keeps the previous index's while `latest` is kept, and
    drops them when the key or repository changes.

  The catalog repository's `build-index.mjs` checks the earlier candidates when `latest`'s API is above 1
  (`needsEarlier`). A builder that gives no `earlier` writes none, so an older builder keeps working with this SDK.
- **Sextant reads and chooses.**
  - `parse_index` reads `earlier` by the same rules (`read_earlier`). It stops at the first release that does not
    read, is not older, or is not of a lower API.
  - `CatalogEntry::installable` is `latest` when this Sextant supports its API, else the newest earlier release it
    supports.
  - `extension_inspect_catalog` installs that release. The backend chooses it; the window still names no version.
  - `status_of` offers an update to it when it is newer than the installed one, with `newer` naming `latest`. When
    the installed one is already it, the status says `latest` needs a newer Sextant.
  - The rules of ADR-0130 are unchanged: never a lower version than installed, only from the pinned repository and
    key, consent from the downloaded manifest's own permissions.
- **What the window shows.** A card shows the version this Sextant would install and "This Sextant installs version
  X. Version Y needs a newer Sextant." An installed extension's row says "Version X is available in the catalog.
  Version Y needs a newer Sextant."

## Consequences

- A user who does not update Sextant can still install, and update to, the newest release it can run, and learns
  that a newer one needs a newer Sextant.
- Sextant 0.26–0.28 never read `earlier`: for them an extension whose `latest` needs a newer API still shows only
  "needs a newer Sextant". Sextant 0.29 is the first that benefits.
- The workflow downloads and checks up to 20 releases of an entry whose `latest` is of API 2 or later, not one.
