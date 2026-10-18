# ADR-0042: Dangerous agent calls are confirmed in the Sextant window, and every call goes to an activity log without values

## Context

Modify, delete, exec and port forward by an agent should ask the user (a switch in the rule), and the user should see afterwards what the agent did. The backend had no way to ask the window a question and wait for the answer: every existing event is fire-and-forget, and the only prompt flows were driven by the frontend.

## Decision

For a call that needs confirmation the server emits the event `mcp-confirm` with a request id (client name from `initialize`, cluster, action, target, details). The window shows a dialog on top of everything and asks the OS for attention; the answer returns by the command `mcp_confirm_answer(id, approved)`. Requests are queued and shown one at a time. No answer in 120 s is a refusal; stopping the server or closing the app refuses all pending requests, and the guard checks again after the answer, so a call does not run after a stop. Without a window a request that needs confirmation is declined.

Every call is recorded in the agent activity log: time, client, cluster, tool, target, decision (allowed, denied, approved, declined, timed out), result (ok or error code) and duration. The log is a ring of 2000 records in memory plus a JSONL file in the app data directory, new records reach an open log through the event `mcp-audit`, and the file survives restarts. A record holds a summary only: no Secret values, no YAML, no command output, and text is clipped.

## Why

- Confirming in the agent's own client was rejected: the client is the party being restricted, and the user asked for the question to appear in Sextant.
- A native OS dialog was rejected in favour of an application dialog because the dialog must show the target, up to 200 lines of YAML, the command or the port, and be queued, counted down and stopped with the server. (This is our reasoning; the materials name only the event-and-command mechanism.)
- Waiting forever was rejected: an unattended prompt would hang the agent's call; 120 s ends it with a clear refusal text.
- An in-memory log only was rejected: the user wants to see what happened after a restart. A database was not considered necessary for 2000 flat records.
- Storing the YAML, output or Secret values in the log was rejected: the log would become a second copy of what the access rules protect.

## Consequences

- The user has to be at the machine for dangerous calls to go through; a long-running agent task stalls on each question and fails after 120 s.
- The frontend gained a global dialog and a log view, plus a button in the cluster rail that is shown while the server is on and shows a dot for 10 s after a call.
- Overflowing the ring overwrites the oldest records; the log is not an archive.
- The log records that a call happened but not what it returned, so it cannot answer "what exactly did the agent see".
- A new code `denied` joined the shared error codes so that the log and the interface can name a refusal.

Amended (v0.11.0): `apply_yaml` and `patch_resource` with `dryRun: true` (#141) are checked against the same rules as the change (`Guard::check_dry_run`) but never ask in the window, since the API server only checks them (`dryRun=All`) and nothing changes; the activity log records them as `<tool> (dry run)`.
