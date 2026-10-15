# ADR-0017: Unreadable settings are not overwritten, a kubeconfig source with an error is visible

## Context

If `settings.json` could not be read, `SettingsStore::open` took the defaults without a word; if it could not be parsed, it renamed it to `.bak` (overwriting the previous `.bak`). The next save made the loss permanent: defaults zero out the added kubeconfig sources, cluster settings, the window and `helm_path`. A broken file from `KUBECONFIG` was skipped silently.

## Decision

An unreadable settings file is not silently destroyed. A file that could not be read or parsed is copied to `settings.json.bak-YYYYMMDD-HHMMSS` (UTC; on a name collision `-2`, `-3`, old copies are not overwritten), after which the app starts with defaults. When access is denied, writing is disabled and changes live until the end of the session. The command `settings_status() -> { writable, backupPath, error }` returns the state, and the window shows a banner with the path (a portal from `SettingsButton`, there is no window-wide slot). A kubeconfig source that cannot be read stays in `sources()` with `KubeconfigSource.error`, visible in the rail and in Settings next to the source; the other clusters work.

## Why

- The previous order (one `.bak`, silent defaults) was rejected: a second corruption erased the last good copy, and the user did not learn that their sources and settings were gone.
- When access is denied a copy cannot be made, and writing defaults over an unreadable file would be the same loss — so writing is disabled.
- Showing a source error only on the "no clusters" screen (as it was) was rejected: on partial success the user does not learn that some clusters did not appear because of a broken file.

## Consequences

- In "session only" mode nothing that was changed (added sources, colors, paths) survives closing the window. The banner says so, but the mode itself is unpleasant.
- `.bak-*` copies accumulate, and nobody cleans them up.
  Amended (v0.6.1): a file that stays broken is copied once — an existing `settings.json.bak-*` with the same bytes is reused instead of a new copy on every start; copies of different broken contents still accumulate. Opening does not write over the broken file; the next settings change does.
- The banner lives in `SettingsButton`, so it is visible wherever that button is drawn; there is no general slot for window-level messages yet.
- `KubeconfigSource.error` became a mandatory IPC field, and `KubeconfigRegistry::sources()` now re-reads the files on every call.
- Clusters from a source with an error do not appear in the list until the file is fixed; the message itself shows the cause.
- Migrating Windows settings after the `ClusterId` change in 0.1.0 is not covered by this decision: it was separately placed out of scope of the build.
