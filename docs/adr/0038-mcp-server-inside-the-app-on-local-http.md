# ADR-0038: The MCP server lives inside the app, on Streamable HTTP at 127.0.0.1 behind a Bearer token

## Context

The user wants to connect AI agents (Claude Code, Claude Desktop, Cursor) to their clusters through Sextant and to decide, per cluster, what the agent may do. The app already holds everything such a server needs: connected clusters, port forwards, settings, and a window in which the user can be asked a question. The core crate has no HTTP server and must not pull in `tauri` (ADR-0002).

## Decision

The MCP server runs inside the Sextant process, in the Tauri layer, as an optional server that is off by default. It uses the official Rust SDK `rmcp` with the Streamable HTTP transport on top of `axum`. It listens on `127.0.0.1` only (port 47391 by default, changeable), at `/mcp`. It lives and dies with the app: closing the window stops the server and everything it started (port forwards, exec). Every request needs `Authorization: Bearer <token>` (constant-time comparison; 401 without details). A request that carries an `Origin` header, or a `Host` other than `127.0.0.1:<port>` / `localhost:<port>`, gets 403. The request body is limited to 4 MB and tool results are truncated. The access policy and the new cluster operations stay in the core, without `tauri`.

## Why

- A separate long-lived process (daemon) was rejected: it would need its own connections to clusters, its own copy of the settings, and, above all, a window in which to ask the user to confirm a dangerous action (ADR-0042). All of this already exists in `AppState`.
- A stdio-only server was rejected: every client would start its own process with its own state, there would be no single journal, and no place to show a confirmation. Clients that speak only stdio are served by a thin bridge instead (ADR-0040).
- Remote access (any interface, OAuth) was rejected at the briefing: only this machine. A loopback port is still reachable by any local program and by web pages, hence the token and the refusal of browser requests (`Origin`, `Host`), which also covers DNS rebinding.
- Writing the protocol by hand was rejected in favour of `rmcp`, the official SDK, which brings sessions and SSE and has `allowed_hosts` / `allowed_origins` in its configuration.

## Consequences

- The agent works only while Sextant is open and the server is switched on in Settings; there is no headless use.
- `rmcp`, `axum` and a few small crates (`schemars`, `tokio-util`, `getrandom`, `dirs`) become dependencies of the `sextant` crate; the core stays free of them (`scripts/check-core-deps.mjs`).
- A busy port is a status in Settings ("Port <n> is in use"), not a crash. The app has no single-instance guard, so a second instance fights for the same port and settings file.
- The Origin/Host check also rejects any MCP client that sends `Origin`; a client that cannot omit it cannot be used.
- Tool results are cut at about 256 KB and `list_resources` at 100 objects by default (500 at most), so an agent sees a truncated answer with a `truncated` mark rather than a full dump.
