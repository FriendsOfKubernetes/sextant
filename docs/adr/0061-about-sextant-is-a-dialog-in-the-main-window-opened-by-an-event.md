# ADR-0061: "About Sextant" is a dialog in the main window, opened by an event

## Context

v0.7.0 adds an About screen: version, kind of build, licence, links, a check for updates and "Copy version info". It must open from the tray menu (ADR-0059) and from Settings, including Settings shown as a dialog when no cluster is selected. Tauri's native About menu exists only on macOS and cannot hold an update check.

## Decision

About is a dialog of the main window, mounted once by the window shell. A module store opens it (`openAbout`), so the Settings button works in both layouts. The tray menu reveals the window and then sends a payload-less `open-about` event; the shell opens the dialog on it. The dialog reuses the update store and the update details of Settings → Updates, and the details the window cannot know (OS, architecture, WebView and Tauri versions) come from one command, `about_info`, which returns no paths and no user names.

## Why

- A separate window was rejected: it would need its own label, capability, page, and a second copy of the update state, and an update install would have to reach back into the main window.
- Only the native macOS About was rejected: it does not exist on the other systems and has no update check or copyable details.
- Building the dialog in Rust and the tray was rejected: strings, links and the update flow already live in the web layer, and `@tauri-apps/*` is not used outside the API layer.
- A command that returns the dialog's state to the tray was rejected: the tray only has to bring the window back and say "open About".

## Consequences

- About exists only inside the main window; a native macOS menu entry "About Sextant" is not provided.
- The event is lost if the page has not subscribed yet. It is sent only after a reveal of an already loaded page (the tray exists only after the window was created), so this does not happen in practice.
- The text copied for a bug report is fixed: version, build kind, OS and architecture, WebView and Tauri versions.
