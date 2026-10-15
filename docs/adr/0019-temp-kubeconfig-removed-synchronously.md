# ADR-0019: The terminal's temporary kubeconfig is removed synchronously, leftovers are cleaned at startup

## Context

The temporary kubeconfig lived as a `TempPath` inside the `forward_term` task and disappeared when the task finished; stopping sessions only did `AbortHandle::abort()`, which is asynchronous. `close_all` was called only on `WindowEvent::Destroyed`, so Cmd+Q on macOS and a window reload did not call it, and after a crash the file stayed forever.

## Decision

The guard of the session's temporary files (`kubeconfig` and the shell launch files) is stored in `TermSession`; `Sessions::stop`, `stop_cluster` and `stop_all` drop it synchronously, and by the time the call returns the file is deleted. `RunEvent::Exit` and `ExitRequested` call `AppState::close_all`. On page load the window calls `streams_reset` (ADR-0013), and old sessions are closed. At app startup `remove_stale_temp_kubeconfigs` deletes the leftover `sextant-kubeconfig-*` files in the system temp directory that belong to the current user.

Supersedes ADR-0010 in the part "the file must disappear after the session, but may be left behind if the app crashes".

## Why

- A guard in a task with `abort()` was rejected: aborting waits for nothing, and if the shell exited before the first resize or input, the loop itself also held the guard. A file with the cluster's credentials stayed on disk.
- Cleanup at startup alone is not enough: between the exit and the next launch, a file with certificates and tokens would sit on disk.
- Synchronous deletion alone is not enough either: on a process crash or `SIGKILL` it will not run, so cleanup at startup was added.

## Consequences

- A crash or killing the process still leaves the file (mode 0600, which works differently on Windows) until the next launch.
- Cleanup at startup goes by prefix and owner; whether it protects the files of a second live copy of Sextant by the same user is not described in the materials.
- The `sextant-shell-*` directories (shell wrappers, ADR-0018) are not cleaned at startup: the cleanup deletes only files.
- A start that survived `streams_reset` must remove its own guard itself: `AppState::undo_if_reset` does this.
- Besides the terminal, the temporary kubeconfigs for `helm` get the same prefix; how the startup cleanup relates to them is not described in the materials.

> Amended (v0.7.0): one Sextant runs per user (release builds only). The single-instance plugin (`tauri-plugin-single-instance`, registered first in `lib.rs` `with_single_instance`, only without `debug_assertions`) makes a second launch hand over to the running copy, which reveals its window (also from the tray), and exit during `build`, before `setup`: the second process never cleans temp kubeconfigs, creates `AppState`, writes `settings.json`, takes the MCP port or sweeps node-shell pods, so the question above of protecting a second live copy's files no longer arises for launches of the app. The copy is told apart by the bundle identifier, which a development build (`npm run tauri dev`, `target/debug/sextant`, e2e) shares with an installed copy, so dev/debug builds do not register the plugin and may run beside an installed copy (sharing its settings directory, as before). Without a D-Bus session bus (Linux) the plugin cannot look and Sextant starts as before. `sextant mcp` returns before the app is built and is not affected.
