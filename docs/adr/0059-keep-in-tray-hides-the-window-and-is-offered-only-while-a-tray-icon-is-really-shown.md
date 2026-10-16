# ADR-0059: Keep-in-tray hides the window, and is offered only while a tray icon is really shown

Amended (v0.8.0): on Linux the tray also counts as available without a StatusNotifier host when GTK draws through X11 and a tray owns `_NET_SYSTEM_TRAY_S<screen>` (libayatana's XEmbed fallback: i3bar, older XFCE); a Wayland session without a host stays unavailable. On Linux the menu says "Hide Sextant" only while the window is visible and focused, and any other click reveals it, since GTK on Wayland never reports a minimized window; Windows and macOS keep "visible and not minimized" (#115).

## Context

Sextant holds connections, port forwards, terminals and the MCP server, but they live only as long as the window: closing it ends the app and an agent loses the server. v0.7.0 adds a tray icon with Show/Hide, About and Quit, and an option "Closing the window keeps Sextant in the tray". On Linux an icon needs a StatusNotifier host, which some desktops (GNOME without an extension) do not have, and then a hidden window would be lost for good. The exit path closes everything on every exit request (`close_all`, even if the exit is later prevented), and an agent's confirmation waits 120 s for an answer (ADR-0042).

## Decision

- **Built in Rust.** The tray (icon, menu, menu events) is created in Rust with Tauri's `tray-icon` feature, after the app state exists, on desktop only. The window never calls tray APIs, so no capability is added. A failure to create it is logged once and does not stop the start.
- **The option is a setting, off by default** (`closeToTray`, written by the frontend). It is honoured only while the tray is available: the icon was created and, on Linux, a StatusNotifier host is registered. The window asks the backend (`tray_status`) and disables the option with an explanation when the answer is no.
- **Closing hides, it does not destroy.** With the option on and the tray available, a close request is stopped and the window is hidden; nothing is closed (no `close_all`), so sessions, forwards, streams and the MCP server keep running. Only "Quit Sextant" in the tray menu (and Cmd+Q on macOS) leaves, through the ordinary exit path, so node-shell pods and temporary kubeconfigs are cleaned as before.
- **Availability is asked again at the moment of closing**, because the host can disappear after the start. On Linux that is a D-Bus round trip, so the decision is made on the blocking pool, never on the event loop. If the answer is no, the window is destroyed, which ends the app as a plain close does.
- **Anything that needs the user brings the window back.** One function reveals the window (show, unminimize, focus). The tray, a second launch (ADR-0060), a macOS Dock click and both confirmation paths (agents and extensions) use it; a confirmation reveals the window before its dialog is sent, and is declined only when there is no window at all.

## Why

- Relying on cancelling the exit (`prevent_exit`) was rejected: `close_all` already ran on the exit request, so sessions and the MCP server would be gone while the process stayed.
- Offering the option whenever the icon "was created" was rejected: on Linux without a host the build can succeed and show nothing, and the user would have no way back to the window.
- Hiding by default was rejected: a change of what the close button does should be chosen by the user.
- Leaving a confirmation to time out while the window is hidden was rejected: the agent would be refused after 120 s for a question nobody saw.
- Checking the host once at start was rejected: a later loss of the host would trap a hidden window.

## Consequences

- With the option on, the app can run with no visible window; the only signs are the tray icon and the hint under the option. Quitting is deliberate.
- Closing with the option on costs one round trip to the session bus on Linux before the window goes away; a stuck bus delays that close, not the interface.
- On Linux desktops without a StatusNotifier host the option is unavailable and the app behaves as before.
- The tray menu is small by design (Show/Hide, About, Quit); clusters and MCP state in the tray are not offered.
- Tray behaviour is not covered by end-to-end tests (a real tray cannot be driven there); only the decision functions are unit-tested.
