# ADR-0060: Release builds run as a single instance; debug builds do not

## Context

Keeping Sextant in the tray (ADR-0059) makes it easy to start a second copy by mistake: the first one is invisible. Two copies share the settings directory, the MCP port and the token, the node-shell sweep and the temporary kubeconfig cleanup at startup, so the second would clean up and write over the first one's live files (the question left open in ADR-0019). A copy is told apart by the bundle identifier, and a development build shares it with an installed copy.

## Decision

Release builds register `tauri-plugin-single-instance` first. A second launch hands over to the running copy, which reveals its window (ADR-0059), and exits during build, before setup. Builds with `debug_assertions` (`npm run tauri dev`, `target/debug/sextant`, e2e) do not register it and may run beside an installed copy. The stdio bridge `sextant mcp` returns before the app is built and is not affected.

## Why

- No protection (as before) was rejected: with a copy living in the tray, a second launch is now a likely mistake, not a rare one, and it damages the first copy's state.
- A lock file of our own was rejected: stale files after a crash, and a second platform-specific mechanism where the plugin already uses a D-Bus name or a named mutex.
- Single instance in every build was rejected: a developer could not run the app under development while an installed copy is open, and e2e could not run beside it. Both share the identifier, hence the settings directory, so this stays as risky as it was; the price is accepted for debug builds only.

## Consequences

- Without a D-Bus session bus on Linux the plugin cannot look, and Sextant starts as before, possibly twice.
- A development build next to an installed copy still shares its settings directory and MCP port; the old caution (never run a debug binary against real settings) stays.
- The launch arguments of the second copy are ignored.
