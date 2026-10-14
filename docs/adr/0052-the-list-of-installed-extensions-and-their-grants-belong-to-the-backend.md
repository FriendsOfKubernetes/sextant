# ADR-0052: The list of installed extensions and their grants belong to the backend

## Context

Installed extensions need a persisted list with the granted permissions, the enabled flag and the source. Settings already split fields: some are written by the frontend (`agentAccess`, `mcp`), and some by the backend (`kubeconfigSources`, window sizes), which `update_settings` restores from the current state when the frontend sends its copy.

## Decision

`AppSettings.extensions` (id, version, name, source, enabled, granted permissions, install time) is owned by the backend. It changes only through the install, consent, enable/disable and remove commands, and `update_settings` restores it from the current state like the other backend fields. The frontend reads it through `extensions_list` and cannot widen a grant. A record that this version cannot read is kept, shown as disabled, and grants nothing.

## Why

- Making it frontend-owned like `agentAccess` was rejected: the frontend host is the place that renders extension content, and a grant that a bug or a hostile frame could influence there is the thing we promise not to have.
- It also has to match the files on disk: the package under the data directory and the list must change together, and a stale copy of settings from the window would erase the list while the files stayed.
- A separate file for extensions was rejected: settings already has atomic writes, backup of an unreadable file and the "keep what you do not understand" rules.

## Consequences

- A new field of the list must be added by hand to the restore list in `update_settings` (as with `kubeconfigSources`); forgetting it silently loses installed extensions on the next settings write.
- Anything that wants to change grants must go through a backend command with its own consent flow.
- Because the list is in `settings.json`, a hand-edited file can grant permissions; the file is as trusted as the user's account.
