# ADR-0022: Auto-update through `tauri-plugin-updater`, signed with the project key, `latest.json` in GitHub Releases

## Context

After 0.1.0, new versions were installed only manually. The installers are not signed with OS certificates (there are no Apple and Microsoft accounts, signing was moved to `Later`), and a release for a `v*` tag is built by `release.yml`.

## Decision

The app uses `tauri-plugin-updater` and `tauri-plugin-process` (relaunch). The endpoint is `https://github.com/FriendsOfKubernetes/sextant/releases/latest/download/latest.json`. Updates are signed with the user's key: the public part is written into `tauri.conf.json`, while the private part and the password are in the GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. `createUpdaterArtifacts: true`, and `release.yml` builds the artifacts and `latest.json` (`includeUpdaterJson`). The check runs at startup (a setting, on by default) and on the "Check for updates" button; the version and notes are shown, and "Install and restart" installs the update. On Linux an AppImage updates itself, and for a `.deb` the app suggests updating through the package. The app version is visible in Settings, and CI checks the tag against the version.

## Why

- Tauri's built-in mechanism, the key is free, no Apple and Microsoft accounts are needed.
- Manual reinstallation was rejected: the update was started precisely to get rid of it for the team.
- Signing installers with OS certificates was rejected as paid and moved to `Later`; signing updates does not replace it, but only verifies that the package was built by the owner of the key.

## Consequences

- Losing the private key or the password means installed copies will not accept any update: they will have to be installed manually. A leak of the same key would allow forging an update.
- The installers are still without OS signatures, so the Gatekeeper and SmartScreen warnings remain.
- The scenario is verified in Vitest with a plugin mock and with `actionlint` for `release.yml`. A live installation of an update, especially on macOS and Windows, was not verified.
- `.deb` users update manually, through the package.
- The `latest.json` address is bound to the repository name and to the last published release: a release without update artifacts and `latest.json` will break the check for all installed copies.
- The version in the manifests must match the tag (checked in CI): otherwise the update check will compare the wrong versions.
