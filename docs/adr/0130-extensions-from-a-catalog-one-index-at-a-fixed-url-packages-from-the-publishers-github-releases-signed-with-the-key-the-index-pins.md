# ADR-0130: Extensions from a catalog: one index at a fixed URL, packages from the publishers' GitHub releases, signed with the key the index pins

## Context

Issue #271. Today an extension is installed from a folder, a file or a GitHub Release link (ADR-0053). That ADR left out a catalog and signing: there was no index to read and no key to check against. A user who wants an extension has to find its repository, copy a release link, and trust that the link is the author's. Nothing tells them that a new version exists.

What the app already has:
- the download rules of `src-tauri/src/download.rs`: HTTPS only, redirects one by one to GitHub's asset hosts, size and time caps, errors without the URL;
- an allow-list of exact URLs built by Sextant, as `gitops_install/download.rs` does for Flux and Argo CD;
- the check of a package before consent, the consent screen, and the rule that an update asking for more needs consent again (ADR-0050, ADR-0053);
- the installed list as a backend-owned field (ADR-0052);
- `minisign-verify` in the lock, through the updater. It verifies minisign signatures (Ed25519).

## Decision

### The catalog repository and its index

- The catalog is the public repository `FriendsOfKubernetes/sextant-extensions`. Each extension is one reviewed file `extensions/<id>.json`, added by a pull request. The entry holds:
  - `id`, `name`, `author` and `description`, capped as in the manifest;
  - up to 3 `categories` from a fixed list: observability, cost, security, gitops, networking, storage, workloads, developer, other;
  - `repository` = `<owner>/<repo>` on GitHub;
  - `publisherKey` = the publisher's minisign public key.
- A workflow of that repository builds `index.json` from the entries. Nobody edits it by hand. It runs on every merge and on a daily schedule. For each entry the workflow:
  - reads the newest non-draft, non-pre-release release of the entry's repository;
  - requires two assets: `<id>-<version>.sextant-ext` and its `.minisig`;
  - verifies the signature with the entry's key;
  - checks the package with the SDK's validator: the manifest's `id` and `version` must match the entry and the asset name;
  - writes into the entry a `latest` block: `version`, `sextantApi`, `tag`, `asset`, `size`, `sha256`, and the manifest's permissions and contributions.

  An entry whose latest release fails these checks keeps its previous `latest` block, and the workflow reports the failure.
- An entry may be marked `withdrawn` with a reason, by a reviewed pull request.
- `index.json` carries `schemaVersion: 1`. A newer major version makes the catalog "needs a newer Sextant". An entry this version cannot read is skipped; the rest of the index still loads.

### What the app fetches, and when

- Sextant fetches `https://raw.githubusercontent.com/FriendsOfKubernetes/sextant-extensions/main/index.json`. The URL is a constant in the Tauri layer, fetched by the rules of `download.rs`: at most 2 MiB, 2000 entries and 30 s.
- The answer is cached in `<app cache>/extension-catalog/` with its fetch time, so the catalog can be browsed offline.
- It is fetched only:
  - when the user opens the catalog, if the copy is more than an hour old;
  - when the user clicks "Refresh";
  - when Settings → Extensions opens, if a catalog extension is installed and the copy is more than an hour old.

  There is no background polling.
- Settings → Extensions → "Use the extension catalog" (`AppSettings.extensionCatalog.enabled`, on by default) turns all of this off. With it off, the backend makes no catalog request, and the tab and update notices are hidden.
- The index is untrusted text:
  - every field is read leniently and capped;
  - text is cleaned as alert texts are (`clean_text`) and rendered as plain text;
  - no image is ever fetched: the catalog shows no icons or screenshots, only text and a link to the repository, opened in the browser;
  - search runs locally, over the cached index.

### Install and update from the catalog

1. "Install" in the catalog, or "Update to X" in the list, calls the backend with the entry's `id` only.
2. The backend takes the entry from its own cached index. It builds two URLs, `https://github.com/<repository>/releases/download/<tag>/<asset>` and the same URL with `.minisig`:
   - `repository`, `tag` and `asset` are checked by character before they are used;
   - `asset` must be `<id>-<version>.sextant-ext`;
   - the URL must pass `is_release_url`.

   It downloads both: the package within the existing 20 MB cap, the signature within 4 KiB.
3. Before anything is unpacked, the backend checks the download:
   - the package matches the index's `size` and `sha256`;
   - the signature verifies with the entry's `publisherKey`;
   - the manifest's `id` and `version` match the entry.
4. Then the existing path continues: the check of the package, the pending token, and the consent screen.
   - The consent screen says "From the catalog", names the repository and the key id, and marks the publisher as verified.
   - The consent is built from the downloaded manifest, never from the index's copy. The details view of the catalog labels the index's permissions as "as published in the catalog".
5. The installed record gets a new source, `ExtensionSource::Catalog { repository, keyId, publicKey }`. It pins the publisher's key and the repository at install. It stays inside `AppSettings.extensions`, which is backend-owned, so there is no new restore field.
6. An update must come from the pinned repository and be signed by the pinned key. If the index now names another key or repository, the update is refused with "The publisher's key changed in the catalog. Remove the extension and install it again to trust the new key." The extension keeps running.
7. A catalog version lower than the installed one is never offered or installed. A `latest` whose `sextantApi` this Sextant does not support is shown as "needs a newer Sextant".
8. An update always goes through the consent screen, as an install from a file does. There are no automatic updates.
9. A withdrawn entry cannot be installed. An installed copy shows the reason with "Disable" and "Remove"; Sextant itself never disables or removes it.

### Installs that are not from the catalog

- File, link and folder installs stay as in ADR-0053: unsigned, with no signature check.
- When their `id` is a catalog `id`, the consent screen says "This id belongs to <name> by <author> in the catalog; this package is not from the catalog." The rule that one id has one source still holds: a catalog extension is not replaced by a file of the same id, and the reverse, until the user removes it.

### Who may use it

- The catalog commands are window-only. A test keeps them out of the MCP tools and the extension methods.

### Tools for publishers

- The SDK gains `sdk:keygen` and `sdk:sign`, which write files in minisign's format. Any minisign tool works as well.
- The wiki explains how to publish:
  1. tag a release;
  2. attach the `.sextant-ext` and its `.minisig`;
  3. open a pull request to the catalog repository with the entry and the public key.

## Why

- **One index at a fixed URL.** This keeps the app's network surface what it is: Sextant builds every URL, the hosts are github.com, raw.githubusercontent.com and GitHub's asset hosts, and no URL is taken from what anyone typed. The rejected alternatives:
  - Asking the GitHub API from the app was rejected: unauthenticated it allows 60 requests an hour, it is one call per extension, and it is a second host.
  - A catalog server of our own was rejected: someone would have to host it, and the same files on GitHub give the review history for free.
- **Signatures by the publisher's key, pinned by the index and again at install.**
  - A checksum in the index alone proves only what the workflow saw. A signature proves the package came from whoever holds the key the review accepted, and the app checks it itself instead of trusting the workflow.
  - Pinning the key at install means a later change to the index, by mistake or by a taken-over account, cannot push a new key to people who already installed the extension. Only a fresh install trusts a new key, and the user sees it as one.
  - A signature on the index itself was rejected: the index is written by a workflow, so its key would sit in the same CI secrets that a compromise reaches. HTTPS and the repository's review give the same protection for less.
- **minisign.** It is the updater's format and is already verified by a crate in the lock. Its keys are short enough to read in a pull request, and tools exist on every platform. X.509 and Sigstore were rejected: they bring a chain or an online log that the app would have to reach.
- **Versions from the publishers' releases, not from catalog pull requests.** A pull request for every version would make the reviewers a bottleneck, and the signature would add little to a reviewed checksum. Reviewing the publisher once and their permissions on every change keeps the catalog maintainable. The sandbox and the consent stay the control on what the code may do (ADR-0047, ADR-0050).
- **Withdrawal does not act remotely.** A switch that disables code on users' machines from a file in a repository is power we do not want the index to have. The user is told and decides.
- **Text only.** Icons or screenshots would mean fetching images from places the index names, or hosting them. Neither is worth it for a list of names and descriptions.

## Consequences

- The catalog says who publishes an extension and that the package is theirs. It does not say the code is safe, and the catalog page says so. The review covers the entry, the repository, the license and the permissions asked for, not every release's code. Whether a package was built from its repository's source is not checked.
- A publisher who loses their key needs a reviewed pull request with a new key. Their users must reinstall to trust it.
- The catalog repository, its workflow, its contribution rules and the first entries have to exist before the feature is useful. The SDK's examples, signed with a Sextant key, can be the first entries.
- The index is English only. Category names are translated in the app from the fixed list.
- New pieces:
  - window-only commands: the catalog (cached and refreshed), and inspect-from-catalog, which returns the existing `PendingInstall`;
  - an `ExtensionSource::Catalog` variant;
  - the setting `AppSettings.extensionCatalog.enabled`, frontend-written and read leniently;
  - the catalog tab and update notices in Settings → Extensions;
  - `sdk:keygen` and `sdk:sign`;
  - a test that keeps the catalog out of the MCP tools and the extension methods.
- ADR-0053's "no catalog and no signing" now holds only for file, link and folder installs. That ADR gets an amendment.
