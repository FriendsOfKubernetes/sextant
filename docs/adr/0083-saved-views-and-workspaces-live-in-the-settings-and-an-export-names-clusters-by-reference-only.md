# ADR-0083: Saved views and workspaces live in the settings, and an export names clusters by reference only

## Context

Users of many clusters return to the same tables every day ("failing pods in shop", "Ingresses of team-a") and switch between groups of clusters ("prod", "staging"). #149 asks for saved views, pins (favourites), workspaces, and a way to move them to another computer or hand them to a colleague. The settings already hold things that must never leave the machine (the MCP token is a separate file, but the settings carry extension grants, agent access rules, kubeconfig source paths), and a file handed around is an attack surface: an imported file that silently grants an AI agent "Delete" on a cluster, or one that points the app at an arbitrary local file, would be worse than no feature at all.

## Decision

- **Settings, not a store of its own.** `views`, `pins`, `workspaces` and `activeWorkspace` are frontend-written fields of `settings.json` (`crates/sextant-core/src/settings/views.rs`). The core reads each list entry by entry: an entry that does not read or breaks a rule (an id outside `[A-Za-z0-9_-]{1,64}`, an empty or over-long name, a repeated id, beyond the caps `MAX_VIEWS`/`MAX_PINS` = 500, `MAX_WORKSPACES` = 100) is left out, and the rest of the file still loads.
- **A view is table state, not a query language.** It captures the kind, namespaces, search text, "Only problems", label selector (asked from the cluster by the watch), sort and hidden columns, for one cluster or for all. A pin is one object or one view, per cluster. A workspace only filters the cluster rail (the active cluster stays shown) and the views and pins offered; switching never connects or disconnects a cluster.
- **Clusters by reference.** An export (`src/features/views/transfer.ts`, format `sextant-workspace` version 1, written through the save dialog and `file_save`) names each cluster by its kubeconfig source kind and path and its context name. It carries the shareable cluster settings (display name, colour, icon, namespace filter, "Preview changes"), and the agent access rules only when the user ticks "Include agent access rules".
- **Never exported:** kubeconfig contents, credentials, tokens, the MCP token, Secret values, extensions and their grants, MCP settings, notification and window state.
- **Import reads only what the user picked.** `views_import_open` shows the open dialog in the backend and reads only the file picked there (a regular file, at most 1 MiB); the window never names a path to read. The file is parsed strictly (an unknown field is an error that names it), previewed section by section (added / changed / unchanged / skipped / missing on this computer) and applied only on confirmation. A differing entry replaces the local one only when "Replace entries that differ from mine" is ticked; a missing cluster is listed, never created.
- **Agent access only on an exact match and only when ticked.** A cluster matches exactly by the same id or the same source path and context; a match by context name alone (the only local cluster with that name) may be another cluster, so its agent access rules are never applied, whatever is ticked. Rules from the file are applied only when the user ticks "Apply the agent access rules from the file", with a warning.

## Why

- A separate views file was rejected: the settings already have tolerant reading, a backup of an unreadable file and one writer; a second file would need all of that again.
- Exporting whole cluster settings was rejected: agent access decides what AI agents may do, and extensions are code with grants; both must come from the user on this machine, not from a file.
- Reading a path the window sends was rejected: a compromised page could read any file through the command; the dialog in the backend binds the read to the user's click.
- Matching clusters by name and applying everything was rejected: two people's "prod" contexts can be different clusters.

## Consequences

- An export is useful only where the same kubeconfig paths and context names exist; elsewhere its clusters show as missing and their views and pins are skipped.
- A renamed context keeps its views, pins and workspace places (the settings move with it, ADR-0084); a deleted one loses them.
- MCP agents and extensions get nothing new.
- Tests: `views.test.ts`, `table.test.tsx` (frontend), `settings/views.rs` unit tests (tolerant reading), `commands/views.rs` (`read_import` limits).

Amended (v0.14.0, #154): the export is now version 2 and carries the terminal snippets (`AppSettings.snippets`) in a required `snippets` section, previewed and applied like views (added / changed / kept; a changed one replaces the local one only when overwriting is allowed). A version 1 file is still imported, without snippets; each version is read strictly (`snippets` in a version 1 file is an unknown field). "Include terminal snippets" (on by default, with a warning that they are exported as written) can leave them out; the preview shows each added or changed command with whitespace and hidden characters visible, and a snippet with control, invisible or text-direction characters is refused.
