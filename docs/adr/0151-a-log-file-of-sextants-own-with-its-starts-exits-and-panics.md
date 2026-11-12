# ADR-0151: A log file of Sextant's own, with its starts, exits and panics

## Context

A user on Windows found Sextant 0.29.1 closed by itself after several hours in the background and asked where to
look for the reason (discussion #342). There was nowhere to look:

- a release build on Windows has no console (`windows_subsystem = "windows"`), so everything Sextant printed to
  stderr was lost;
- a panic left no trace;
- nothing told an exit the user chose from a process that died.

The user chose (2026-11-06) to add a log in 0.29.2 (#343).

## Decision

- **One text file of Sextant's own.**
  - `sextant.log` in `logs/` of the app data directory (Tauri's `app_data_dir`, found without Tauri by
    `mcp::paths::data_dir`).
  - Past 2 MiB it becomes `sextant.1.log`, replacing the older one, and a new file starts. The log never takes more
    than 4 MiB.
  - On Unix the files are 0600.
  - The module is `sextant_core::applog` (`init`, `line`, the `applog!` macro, `install_panic_hook`). Every line
    also goes to stderr, as before.
- **What is written.**
  - The start, in `setup`, so a second launch that only reveals the first is not counted: the version, OS and
    architecture. Every line carries the UTC time and the process id.
  - How the run ended: "Quit chosen in the tray", "the main window was closed", and "Sextant exited" on
    `RunEvent::Exit`.
  - The window hidden to the tray.
  - Every panic: thread, source place and message, cut at 4000 characters. It is written before the default
    report, by a hook installed first thing in `run`.
  - The few messages Sextant printed to stderr before: no tray icon, an extension file not served, a cache not
    written, a node-shell pod left unconfirmed.
  - A run that has "started" and no "exited" after it ended without Sextant's own exit: a crash, the OS ending the
    process, or the power.
- **What is never written.** Nothing from a cluster, a kubeconfig, a credential, a Secret, the MCP token or an exec
  plugin's output. Callers pass their own sentences and error kinds only, as the activity logs do. Control
  characters are replaced, so a message cannot fake a line.
- **About → "Open logs folder"** (the window-only command `about_open_logs_folder`) opens the folder in the file
  manager.
  - The window names no path: the backend opens the folder the log was opened in at start, or answers `notFound`
    when there is none.
  - The command is not an MCP tool or an extension method.
- `sextant mcp` (the stdio bridge) does not write the log: it prints only to stderr, which its client sees.

## Consequences

- A report of an app that closed by itself can carry the log's last lines.
- A panic of a background task (a tokio task) does not end the app, but it is in the log too.
- A process killed without unwinding — by the out-of-memory killer, a WebView2 failure, or a native crash — writes
  nothing more. Its run is still told apart by the missing "Sextant exited". Windows' own record of such a crash
  (Reliability Monitor, the Application event log) stays the place to look for its cause.
- Nothing is sent anywhere. The log stays on the machine until the user shares it.

## Amendment (0.30.1, #342): a counters line every 10 minutes

The log also gets one line of counts every 10 minutes (the first a minute after the start): the process's memory (Windows working set and private bytes, Linux `VmRSS`/`VmData`), the open streams by kind and those waiting for the window, the messages and bytes sent to the window and acknowledged, the Kubernetes API requests, the connected clusters and whether the window is shown. Counts only, never a name or content. See ADR-0170.
