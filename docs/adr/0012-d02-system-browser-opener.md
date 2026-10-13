# ADR-0012 (D02): External links are opened by `tauri-plugin-opener`, AppState closes port forwards

## Context

The plan assumed that "Open in browser" for a port-forward would be done by `window.open`, and that the port forward lifecycle would fit within the files of task 09 without touching `AppState`.

## Decision

External links (Open in browser for a port forward, the link to installing Helm) are opened through `tauri-plugin-opener`, available to the UI as `api.shell.openUrl`. `AppState::close_cluster` and `close_all` stop the port forwards, and this was done in task 11, not in task 09.

## Why

- `window.open` was rejected based on the code: in a Tauri window it does not open the system browser.
- A custom browser launch mechanism was not considered; the plugin is part of the Tauri 2 ecosystem.
- Stopping port forwards was not finished in task 09, because `state.rs` was outside its zone. A port forward closed itself on `Disconnected`, but not on `close_all` and window close, and the gap was closed later.

## Consequences

- The plugin was added to the dependencies, and outbound links go only through `api.shell.openUrl`. In Vitest they are recorded by `MockBackend.openedUrls`.
- Until task 11 closed the gap, port forwards could outlive the window being closed or a cluster being disconnected. New kinds of long-lived sessions must be registered in `AppState` right away (ADR-0011).
- A port forward listens only on 127.0.0.1, so "Open in browser" always leads to a local address.
- A new use of `window.open` for external links would break opening again, and the linter will not catch it.
