# ADR-0051: Extension calls are checked in Rust by one guard, confirmation queue and activity log shared with the MCP server

## Context

An extension frame talks to the host window, and the window can call every backend command; the backend does not know who is calling. The MCP server already has a guard (access decision, confirmation, refusal after a stop), a confirmation queue and an activity log, but they were written around the agent: client and tool names, "AI agent access" texts, and the agent's per-cluster settings.

## Decision

The host forwards an extension's request to the backend with the command `extension_call(extensionId, method, params, streamId?)`. Rust checks that the extension is installed and enabled, that the cluster is in the granted clusters, and decides every object it touches by the granted rules, right before the side effect, as the MCP guard does. A confirmation, when the rule asks for one, and the activity entry (to `extensions-audit.jsonl`, summaries only) go through the same `Guard`, `Confirmations` and `AuditLog` as the agent, generalised with a `source` (agent or extension) and a `principal` ("Extension <name>"). There is one confirmation dialog and one pending map for both. MCP behaviour and tests stay unchanged. The grants and the list of installed extensions are read from backend settings, which the frontend cannot widen (ADR-0052).

The extension API applies the same hard rules as the agent: node-shell pods are never modified or deleted (ADR-0056), Secret patches follow ADR-0043, and `apply` is checked on the parsed documents (ADR-0057). Methods handled in the host only (`ui.*`, context) touch no cluster and are not checked here.

## Why

- Enforcing in the frontend host (iframe, then host, then `api.*`) was rejected: the host would be the only gate, and a bug there would turn into full access, because every command is callable from the window.
- A second copy of the guard, queue and log for extensions was rejected: the two would drift, and the rules about fail-closed behaviour and "check right before the side effect" would be written twice.
- A frontend-only confirmation dialog before calling `resource_patch` was rejected: simpler, but it trusts the host.
- A separate event and dialog for extensions was rejected for the user's sake: one place where "Allow" appears, labelled with who asks.

## Consequences

- The MCP code was touched to be generalised (a shared module for the guard, confirmations and log), so a change to it must be tested for both callers.
- Confirmation requests and activity entries have `source` and `principal`, and the dialog also moved out of the cluster rail into the app shell (a side effect that fixed the dialog being lost when the rail slot changed).
- Extension calls that read settings on every call cost a settings read each; this is what makes a revoked or disabled extension stop at once.
- Permission by context name (ADR-0050) is resolved here; an ambiguous context is `notFound`.

> Amended (v0.6.1): the extensions' log keeps its 2000 entries and file format but no longer drops the oldest entry when full. It drops an entry of the extension with the most entries (on a tie, the one whose entries began earlier): that extension's oldest cheap entry — a read (`clusters.list`, `kinds`, `resources.list/get/watch`, `logs.tail`), a denied call or an unknown method — and only when it has none left, its oldest entry. So one extension flooding the log with cheap calls cannot push out other extensions' entries or its own writes, deletes, answered confirmations and `secret.value` reads (#98). The agents' log still drops the oldest entry. The policy is chosen by the file name `extensions-audit.jsonl` in `AuditLog::open`, and reopening the file replays it, so a restart keeps the same entries.

> Amended (v0.6.1, review of #98): an entry is kept as important only when an access decision allowed the call (so it went on to the cluster) or the user answered it. A call that ends before any access decision — malformed parameters, an unknown method, cluster or kind, a cluster that cannot be reached — is journaled with the decision `notChecked` ("Not checked" in the activity dialogs), never as allowed, and is cheap whatever its method; a granted cluster alone is not journaled as allowed either. So a flood of malformed `secret.value`, apply or delete calls, with or without the grant, cannot pass for real secret reads and writes and evict them. Fair share is still a share, by design: when several extensions fill the log, one that does not flood can be pushed down to about `CAPACITY / N` entries (N extensions with entries), losing its oldest cheap entries first, then its oldest. Extension calls also look up the extension (and so may walk a development folder again after a change) on the blocking pool, never on a runtime worker (#99).
