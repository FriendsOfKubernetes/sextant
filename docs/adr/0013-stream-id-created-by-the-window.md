# ADR-0013: The window creates the stream id and listens to it before the start

## Context

Subscriptions, logs and the terminal were started by the core, and the window subscribed to events only after the reply. The beginning of the data was insured with pauses: a 300 ms `LISTENER_GRACE` in logs, a first tick of 250 ms in watch, a terminal output accumulator until the first resize or input.

## Decision

The window creates the id (`crypto.randomUUID()`), attaches `listen("<prefix>:<streamId>")` and only then calls `watch_start`, `logs_start`, `exec_start` or `terminal_start`, passing `streamId` as the last field. The id is accepted from the characters `[A-Za-z0-9_-]` up to 128 long; an id that is in use or invalid gives `invalid`. The pauses and the terminal accumulator are removed: the first snapshot goes out immediately, further batches no more often than once per 250 ms. The `streams_reset` command stops all subscriptions, logs and terminals (connections and port forwards are not touched), and the window calls it once when the page loads, before the first stream. A start that survived `streams_reset` is rejected with the code `other` and registers nothing.

Supersedes ADR-0004 in the part "the first batch arrives no sooner than 250 ms".

## Why

- A pause guesses the speed of the window: a short one loses the beginning of the data on a slow window, a long one delays every first table and every logs view. Keeping the id in the core and tuning the pause was rejected: it gives no delivery guarantee.
- An accumulator on the core side (as the terminal had) was rejected: it needs a window-readiness signal for every kind of stream, and the 1 MiB limit drops old data. For logs and the table there was no such signal at all.
- A listener before the start is the only way to deliver everything without pauses: events sent right after the start already have a recipient.

## Consequences

- This is a signature change of four commands in the IPC contract (ADR-0007): all call sites and their tests were rewritten, and the tests take the id from their own `streamId` argument.
- Any new kind of stream must accept `streamId` from the window and attach through `openStream`, where `listen` comes before `start`. Registration in `AppState` is still required (ADR-0011).
- The rare race "start during `streams_reset`" turns into an error for the user rather than a silent loss: the stream will not start.
- `AGENTS.md` and `docs/architecture.md` still describe the stream delays; the final build memory will update them, and until then they diverge from the code.
- The window must not forget `streams_reset` on load: reloading the WebView produces no events, and without the call old sessions keep living in `AppState`.
