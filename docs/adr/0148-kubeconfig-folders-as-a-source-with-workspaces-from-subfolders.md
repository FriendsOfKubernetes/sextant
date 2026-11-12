# ADR-0148: Kubeconfig folders as a source, with workspaces from subfolders

## Context

Adding kubeconfig files one at a time does not scale to dozens of clusters (discussion #328, #329). Many people
keep one file per cluster in a folder, sometimes in subfolders per team or customer. Sextant had sources for
`KUBECONFIG`, `~/.kube/config`, added files, pasted text and its own files, but none for a folder, and nothing
noticed a kubeconfig file changing while it ran.

## Decision

- **A folder is a source.** `SourceKind::Folder` is the source the settings keep (`kubeconfigSources`); the user adds
  it with "Add kubeconfig folder" (`kubeconfig_add_folder`, a folder dialog). Each kubeconfig file in it, and in its
  subfolders one level down, is a source of its own, `SourceKind::FolderFile`, with `folder` naming the folder
  source and the subfolder. These are found again whenever the sources are read (`kubeconfig::folders::scan`) and
  are never stored.
- **Which files count.**
  - **Taken:** regular files with no extension or one of `yaml`, `yml`, `conf`, `config`, `kubeconfig`, `json`, of at
    most 1 MiB, at most 500 per folder, by path.
  - **Left out:**
    - hidden files;
    - backups and editors' files (`~`, `.bak-…`, any other extension);
    - deeper subfolders;
    - a subfolder that is a link;
    - a link that leads out of the folder.
  - A file that does not parse is listed under the folder with its error and hides nothing else. A missing folder,
    or one with more than 500 files, says so on the folder source.
- **Ids.** A file's clusters have the ids of its path (`ClusterId::for_context`), as an added file's do.
  - The user chose (2026-11-04) that a cluster whose file moved to another subfolder of the same folder keeps its
    settings ("Переносить"). A cluster counts as moved when one context of a file of one name left one place and
    came in another. When two such files moved at once, which went where cannot be told, and nothing moves
    (`folders::moved_clusters`).
  - The moves are applied with `move_cluster_settings`, as a context rename's are (ADR-0084).
- **Following the folders.**
  - Every 3 s the backend looks at the folders: the names, sizes and modification times of their files, with no
    file-watching crate (`src-tauri/src/kubeconfig_folders.rs`).
  - A change sends `kubeconfig-folders-changed`, and the window reads the clusters again.
  - Moves found are kept in the backend. The window applies them with `kubeconfig_folder_moves_apply` inside
    `withBackendSettingsChange`, so a stale copy of the settings in the window never undoes them, and the backend
    never applies moves the window names.
- **Workspaces from subfolders.** One workspace per subfolder of each folder whose `workspaces` is not `false` (the
  folder's checkbox "Show its subfolders as workspaces", `kubeconfig_folder_workspaces`). It holds the clusters of
  that subfolder's files.
  - They are computed from the cluster list each time (`src/features/views/folderWorkspaces.ts`) and never stored,
    so they always match the folder.
  - The user chose (2026-11-04) that they are read-only ("Только чтение"). The manager lists them apart, marked with
    the folder, with "Use" only.
  - A user's own workspace of the same name stands beside them, never changed.
  - Their ids (`folder-<source>-<hash>`) are valid workspace ids, so one can be the active workspace. When the folder
    or its workspaces go, the id names nothing, and the rail shows every cluster.
  - They are never exported (ADR-0083): only the settings' workspaces are.
- **Writes.** A folder's files are the user's own files. They may be edited only when the folder, or the file
  itself, is allowed in `kubeconfig.writableSources` (`ensure_writable`, ADR-0084).
- **Removal.** Removing the folder removes its clusters (disconnected, as for a file). A file of a folder cannot be
  removed on its own.
- Exec plugins of a folder's contexts still never run interactively (ADR-0136): they connect as every context does.

## Consequences

- Dozens of clusters come from one folder, and team folders become workspaces with no setup.
- Sextant now notices a kubeconfig change on its own, for folders only. Files added one by one are still read again
  on "Refresh".
- Each look reads at most 500 small files' metadata every 3 s, and the files themselves only when that changed.

## Amendment: a folder's own files, and editing a copy (#328)

The idea's author adds several folders one by one, with no subfolders, as they did in Lens. Such folders made no
workspace, since only subfolders did. A folder's own files (those not in a subfolder) now make a workspace too,
named after the folder (the last part of its path), listed before its subfolders' and only when there are such files.
Its id hashes `/`, which no subfolder name is.

They also wanted to edit such a workspace. Folder workspaces stay computed and never stored: the folder decides
what they hold. The manager copies one into a workspace of the user's own, opening the editor on its name and
clusters. The copy is an ordinary workspace: stored, exported, and edited freely. The folder's workspace stays beside
it, and the folder's switch "Show it and its subfolders as workspaces" turns the folder's ones off.
