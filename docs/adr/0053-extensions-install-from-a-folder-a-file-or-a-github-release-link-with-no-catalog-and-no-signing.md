# ADR-0053: Extensions install from a folder, a file or a GitHub Release link, checked before consent; there is no catalog and no package signing

## Context

The brief asked for installation from a folder with reload for development, from a `.zip`/`.sextant-ext` file and from a GitHub Release link, and said there is no catalog. The app had no HTTP client for public sites, no `zip` reader with deflate and no file watcher; the frontend CSP forbids `fetch` to GitHub.

## Decision

A package is a folder or an archive with `sextant-extension.json` and web files. The package is parsed and checked in the core before the consent screen: no zip-slip, symlinks, absolute paths or device names, at most 2000 files and 50 MB unpacked. The checked package waits in a temporary directory for 10 minutes under a token; "Install" is the consent and moves it to `extensions/<id>/<version>/` atomically (temp directory, then rename). A link must be `https://github.com/<owner>/<repo>/releases/download/...` (redirects to GitHub's asset hosts allowed), at most 20 MB, and the download happens in the Tauri layer. "Load unpacked folder" runs the extension straight from the folder, marks it Development, polls the folder's modification times once a second (no new crate) and reloads frames and contributions on change. Installing a new version of the same `id` replaces the old one, with consent when permissions grow; an `id` from a different source is an error.

Packages are not signed and there is no catalog or store.

## Why

- A file watcher crate was rejected: polling once a second is enough for a development loop and adds no dependency or platform behaviour to test.
- Any HTTPS link was rejected: limiting to GitHub Release assets keeps the downloader small and the source recognisable on the consent screen; a free URL would also turn the downloader into a general fetch tool.
- Unpacking directly into the extensions directory before consent was rejected: a package that fails the checks, or that the user declines, must leave nothing behind.
- Signing was left out: there is no key infrastructure; the shown permissions and the consent are the control (ADR-0050).
- A catalog or store was left out by the brief.

## Consequences

- A user can install any third-party package; safety rests on the sandbox (ADR-0047) and the permissions, not on trust in the author.
- A dev folder is not a copy: changing files changes what runs, and widened permissions suspend the extension until a new consent.
- Only GitHub Releases can host downloadable packages; other hosts need the file route.
- Download and unzip add `reqwest` (rustls) to the app and `zip` with deflate to the core.

Amended (v0.6.1): the token is spent only by a successful install. A failed install keeps the checked package, so the same consent window can retry it; a package that can no longer be read or changed since its check is dropped, and only that (like an expired or used token) answers `notFound`. Cancelling the consent window drops the package and deletes its copy at once (`extension_install_cancel`). "Review permissions" is offered only for a dev folder, which can be read again in place; a paused extension installed from a file or a link is reviewed by installing it again, and the list and the notice name its source.

Amended (0.26.0, ADR-0130): extensions can also be installed from the catalog (`FriendsOfKubernetes/sextant-extensions`). A catalog package is signed by its publisher's minisign key, which the index pins and the install pins again. Installs from a folder, a file or a link are unchanged: unsigned and not checked against the catalog. The one exception: a package whose id is a catalog id is named as not from the catalog.
