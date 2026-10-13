# ADR-0040: `sextant mcp` is a stdio bridge to the running app, not a second server

## Context

Claude Desktop starts MCP servers as child processes and talks to them over stdin and stdout. Claude Code and Cursor can use the HTTP server directly. The app's own entry point has no argument parsing, and in release builds on Windows it is a GUI-subsystem program without a console.

## Decision

The same binary, started as `sextant mcp`, does not start Tauri: `main` branches on the first argument. It reads the port from `settings.json` and the token from `mcp-token` (the same directories as the app), forwards JSON-RPC lines from stdin to `http://127.0.0.1:<port>/mcp`, and writes the answers (JSON and SSE) to stdout. Nothing but JSON-RPC goes to stdout; diagnostics go to stderr. If the app is not running or the server is off, the answer to `initialize` is a JSON-RPC error saying to open Sextant and enable the server, and the process exits with code 1. It works through the pipes inherited from the client, so the GUI subsystem on Windows does not matter.

## Why

- A stdio server that does the work itself was rejected: it would be a second process with its own cluster connections and its own policy, and it could not show a confirmation window (ADR-0042) or write into the journal the app shows.
- A separate console-subsystem binary for Windows was rejected: it adds a second artifact to every installer and to the updater, while the pipes inherited from the client are enough.
- Asking Claude Desktop users to configure an HTTP URL with a header was rejected as the only route: the client path for stdio is what the client supports, and it keeps the token out of the client's configuration.

## Consequences

- `sextant mcp` is useless without a running Sextant with the server on; the error text says so in the one place the user will see it.
- The proxy is tested at the level of functions against a fake HTTP server. A live run on Windows is not available here; the CI test is the only check there.
- The settings file and the token file are read by two processes; the proxy never creates the token.
- Anything the proxy prints besides JSON-RPC to stdout breaks the client's protocol, so logging there is limited to stderr.
