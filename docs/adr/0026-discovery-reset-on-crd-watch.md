# ADR-0026: Discovery is reset without reconnecting by watching CRDs

## Context

The discovery cache was zeroed only on `connect` and `disconnect` (ADR-0015). A new CRD stayed unknown to both the window and `resolve_kind` until reconnecting. Flux or Argo CD installed while the connection was open would not appear in the sidebar (stories 2 and 15 of the specification). The line from ADR-0015 "a new CRD appears in the sidebar after reconnecting" stopped being true.

## Decision

The core got `ClusterManager::refresh_kinds(&ClusterId)`: it resets the discovery cache and any discovery in progress without reconnecting. The command is `cluster_kinds_refresh(clusterId)`, TS `api.clusters.refreshKinds(clusterId)`. The window watches CRDs: `watchCrdChanges(clusterId)` in `src/resources/useKinds.ts` is a metadata watch (`metadataOnly`) on `apiextensions.k8s.io/CustomResourceDefinition` with a reference counter. A CRD added or removed after the first snapshot calls `api.clusters.refreshKinds` and `refreshClusterKinds` (which also forgets the CRD column cache), with the `CRD_REFRESH_DELAY` = 1 s debounce.

Supersedes ADR-0015 in the part "a new CRD appears in the sidebar after reconnecting".

## Why

- Reconnecting on installing Flux or Argo CD was rejected: the requirement is explicitly that the section appears without it.
- The reset is needed in both places: the core holds its own cache (read by `resolve_kind`), the window holds its own (`useClusterKinds`).
- The reason for the debounce is not named in the materials. The obvious consequence: installing a tool creates many CRDs in a row, and without a pause each would trigger a new discovery.
- Other approaches (periodic discovery polling, watching in the core itself) are not mentioned in the materials, and there is no comparison. Why the watch lives in the window is not stated.

## Consequences

- An open connection gets one more subscription (on CRDs). Permission to list and watch CRDs is needed; behavior without it is not described in the materials.
- The reset fires on adding and removing a CRD. A new version of an existing CRD does not produce an "added/removed" event, and this case is by design not covered.
- Previously `refreshClusterKinds` was called only on the transition to `connected`; now also from the watch. If nothing was loaded for the cluster, it does nothing.
- The Flux and Argo CD sections are hidden until discovery has arrived (ADR-0031), and appear by themselves after the reset.
- The check is the test "create a CRD on kind → the kind in the sidebar".
