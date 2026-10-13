# ADR-0039: The MCP token is a file with mode 0600 in the settings directory, not a keyring entry

## Context

The server needs a secret that the user copies into the agent's configuration. Two processes must read it: the app and `sextant mcp`, a separate process that starts without Tauri (ADR-0040). The Argo CD login already lives in the OS keyring (ADR-0029).

## Decision

The token is 32 random bytes in base64url, created the first time the server is switched on and kept in the file `mcp-token` in the app's settings directory, with mode 0600 on Unix. The directories are computed without Tauri by the same rule (the OS config directory plus `dev.sextant.app`), and a test compares the result with the path Tauri gives. In Settings the token is hidden; Show, Copy and Regenerate are available, and Regenerate asks for confirmation, invalidates the old token at once and closes active sessions. The token type prints `<hidden>` and is never written to logs, errors or the journal.

## Why

- The OS keyring was rejected: `sextant mcp` is a separate process without Tauri and has to read the token, and on Linux the keyring works through D-Bus and is unavailable without a session. A command that works in a desktop session and fails over SSH would be a poor bridge.
- Keeping only a hash in settings was rejected: the user must be able to see and copy the token into client configuration, so the value itself has to be recoverable.
- A file matches what the app already does: kubeconfigs with credentials already lie in files with the same permissions.

## Consequences

- Any process of the same OS user can read the token, as it can read the kubeconfig. The protection is the file mode and the loopback-only listener, not encryption.
- Mode 0600 is applied on Unix only; on Windows the file relies on the user profile directory.
- The directory rule exists in two places (Tauri and our own); the test is what keeps them from drifting apart.
- Regenerating the token breaks every connected client until its configuration is updated; this is deliberate.
- The Claude Desktop snippet carries no token, because `sextant mcp` reads the file itself; the other snippets contain it and show it only after Show or on copy.
