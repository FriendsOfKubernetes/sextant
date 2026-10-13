# ADR-0016: The client's own retries (up to 3 times, up to 5 s) and a 30 s timeout on changes

## Context

By default the kube client retried 429/503/504 responses up to 15 times with backoff up to 1000 s, honoring `Retry-After`; reads had no timeout. On an overloaded API an action hung for up to ~5 minutes, and the only outer limit was the connection check (20 s).

## Decision

In the connection client `default_retry = false`; instead there is a kube stack with `BufferLayer` and `RetryLayer` with the policy `cluster::RetryPolicy`: no more than 3 retries and no more than 5 s of total waiting, and only requests with a cloneable body are retried. `tower` and `http` are direct dependencies of `sextant-core` (they were already in `Cargo.lock` through kube-client). Changes (scale, restart, cordon, trigger, suspend, `resource_replace`, `resource_delete`) are wrapped in the commands by `error::with_timeout` for 30 s (`commands::actions::CHANGE_TIMEOUT`); an expiry yields the new code `timeout`. The eviction client is built separately, without retries and with the same `CONNECT_TIMEOUT`. Multi-step operations (drain, multi-doc apply) are limited differently — ADR-0023.

## Why

- The built-in `server_retry` cannot be kept: 15 retries with backoff and `Retry-After` are exactly the minutes of waiting. A limit on total time is needed, and whether `server_retry`'s own settings can set it was not checked in the materials.
- No retries at all was rejected: short 429/503/504 responses on a live cluster remain, and the user should not see an error on every such one-second overload.
- The timeout is placed at the level of the action commands rather than in the client, as the decision records; the reason is not named directly. The obvious consequence: a general client timeout would cut off long-lived watches, logs and exec as well.

## Consequences

- `timeout` is one more code in the closed set from ADR-0008; the UI picks its wording from `errors:timeout`.
- The timeout does not cancel the request on the server: by the time of the error the change may already have been applied.
- Requests with a non-cloneable body go without retries altogether. A watch drop is still handled by its own reconnection (ADR-0004).
- Old subscriptions keep the previous client when the cluster reconnects, so the retry policy changes for them only with a new subscription.
- The third client builder — Prometheus by URL (`core/metrics/prometheus.rs`) — has its own timeouts and is not affected by this decision.
