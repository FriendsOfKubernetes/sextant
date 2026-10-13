> Partially superseded by ADR-0013 (the first batch does not wait 250 ms) and ADR-0014 (Secret data does not reach the window without a request).

# ADR-0004: Live data — one watcher per subscription, a snapshot and batched deltas to the frontend

## Context

Tables, details and events must update on their own (R18i), and 5,000 rows must not lag: updates no more than four times a second.

## Decision

Each subscription (cluster, kind, namespaces, selectors) gets one `kube::runtime` watcher with its own store. The frontend receives the first snapshot, then deltas, all in batches every 250 ms. `managedFields` are stripped before sending.

## Why

- Forwarding every event as a separate message was rejected: the initial load of thousands of pods would turn into a stream of thousands of messages, and the acceptance criteria cap the rate at four updates a second.
- A "refresh" button was rejected by requirement R18i itself.
- One shared watcher per kind, handed out to subscribers, was not chosen. The materials do not record why exactly one watcher per subscription. The choice is simple and isolates subscriptions from one another.

## Consequences

- The first batch arrives no sooner than 250 ms: this is a delay by construction, not a slow network.
- Identical subscriptions do not share a watcher. The details panel opens its own watch of a single object by name, in addition to the table's watch.
- On a drop the stream emits `Reconnecting`, and reconnection proceeds with pauses of 1, 2, 4, 8, 15 s. `Error` ends the stream only before the first snapshot; after it the data stays on screen.
- Secret data reaches the frontend together with the other objects: it is hidden only when displayed. The rule "secrets do not go to the frontend except for display on click" is met at the interface level only, not at the data level.
- Every subscription is registered in `AppState`, otherwise nobody will close it when the cluster is disconnected (ADR-0011).
