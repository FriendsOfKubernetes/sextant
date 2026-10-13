# ADR-0011 (D01): Cluster hooks live in features/clusters, AppState closes subscriptions

## Context

The plan assumed that the hooks `useClusters` and `useClusterState` would go into `src/api`, and that a hook inside `ClusterManager` would close subscriptions when a cluster is disconnected.

## Decision

The cluster hooks live in `src/features/clusters` and are exported from its `index.ts`. Subscriptions, streams and local terminals are closed on disconnect by `AppState::close_cluster` in the disconnect command, not by a hook in `ClusterManager`. Every new kind of subscription or session is registered in `AppState` so that it is closed there too.

## Why

- `ClusterManager` is in the core and does not see the app's `AppState`. To close subscriptions from the core, it would have to know about them, and that inverts the dependency fixed in ADR-0002.
- The hooks are not in `src/api` because that zone was outside the scope of task 02, and a feature directory, which is picked up automatically, did not require editing other people's files. No technical reason to keep them out of `src/api` was found, so this decision is rather about the boundaries of executors' zones.

## Consequences

- Closing subscriptions relies on discipline: a missed registration in `AppState` leaves a subscription alive after the cluster is disconnected. This is exactly what happened with port forwards in task 09 (ADR-0012).
- A port forward is closed in two ways: by itself on the `Disconnected` event from `ClusterManager`, and through `close_cluster`. Two mechanisms for the same thing.
- Section 3 of `interfaces.md` still lists `useClusters` and `useClusterState` among the exports of `src/api`, while in fact they are in `features/clusters`. The truth is the paragraph of task 02.
- The rule "the frontend talks to the backend only through `src/api`" got a visible exception in the import structure (ADR-0007).
