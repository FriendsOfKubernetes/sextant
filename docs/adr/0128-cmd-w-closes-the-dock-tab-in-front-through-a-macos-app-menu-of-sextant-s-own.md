# ADR-0128: Cmd+W closes the dock tab in front, through a macOS app menu of Sextant's own

## Context

Without a menu of its own a Tauri app on macOS gets Tauri's default menu, whose "Close Window" holds Cmd+W. In Sextant Cmd+W therefore closed the whole window — and, without "keep in the tray" (ADR-0059), quit with every terminal, log stream and port forward — when the user meant the terminal or log tab in front, as in every tabbed macOS app. The default menu's "About" also opened the system panel rather than Sextant's About dialog (ADR-0061), and there was no Cmd+, for Settings. Linux and Windows show no menu bar; there Ctrl+W did nothing.

## Decision

- **macOS gets Sextant's app menu** (`src-tauri/src/app_menu.rs`, set by `Builder::menu` on macOS only): Tauri's default with File → "Close Tab" (Cmd+W) and "Close Window" (Shift+Cmd+W, as in Safari), the Window menu without its predefined "Close Window" (whose Cmd+W is fixed), "About Sextant" emitting `open-about`, and "Settings…" (Cmd+,) emitting `open-settings`. The items' texts are English, as the rest of the menu macOS and Tauri provide.
- **The window decides what Cmd+W closes.** "Close Tab" emits `close-tab`; the dock (`src/layout/dock/closeShortcut.ts`) closes the active tab when the dock is open and shows one, does nothing while a modal (dialog, popup) is open, and otherwise asks the backend to close the window (`window_close`, which goes through `Window::close`, so `CloseRequested` and "keep in the tray" decide exactly as for the close button). A collapsed dock shows no tab in front, so there Cmd+W closes the window and the hidden tabs are left alone.
- **Ctrl+W closes the active tab on every platform**, never the window, and not inside a terminal, where it stays the shell's "delete the word before the cursor".
- **A tab with unsaved changes asks first** ("Discard your changes?"), whichever way it is closed — its close button, Delete, Cmd+W or Ctrl+W. An editor tab marks itself with `useUnsavedChanges` (`src/layout/dock/registry.ts`): Edit while the text differs from the stored object, Create while it holds text not applied yet.

## Why

- Cmd+W meaning "close the thing in front, then the window" is the macOS convention users bring; closing a hidden tab instead would end a session the user cannot see.
- Leaving the window close to `CloseRequested` keeps one place that decides between hiding and quitting.
- An easy shortcut makes losing editor text easy; the question costs one click and only when there is something to lose.

## Consequences

- The macOS-only lines (`Builder::menu`) are compiled only on macOS CI; the menu itself is built and tested on Linux with the mock runtime.
- `window_close` is a window command only; agents and extensions never reach it.
- Cmd+Q still quits at once, as in every macOS app.
