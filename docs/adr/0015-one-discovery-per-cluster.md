> Partially superseded by ADR-0026 (a new CRD appears in the sidebar after reconnecting).

# ADR-0015: One discovery per cluster, CRD columns are read lazily

## Context

Discovery on a cold cache was started for every watch and downloaded all CRDs with their schemas for the sake of printer columns: about 9 MB per subscription, in parallel and without gzip. The first table waited 20–40 s, while kubectl takes about a second. Only the preferred version of a group was used.

## Decision

`ClusterManager::kinds` performs one discovery per cluster: parallel calls of `kinds()` and `resolve_kind` wait for the shared result, and the work is aborted when the last waiter leaves. Aggregated discovery is requested first, otherwise group versions; all served versions are requested, and one entry remains per (group, kind) pair. Built-in kinds (`get::BUILT_IN_KINDS`) do not need discovery to start a watch. `printerColumns` from discovery are always empty: the window reads CRD columns lazily, one CRD `<plural>.<group>` for the opened kind (`useCrdPrinterColumns`). The sidebar takes CRDs from discovery, without schemas. The kube client has gzip compression enabled. A subscription is registered before the watch is opened, so cancelling before the `watch_start` reply aborts the work already begun.

Supersedes ADR-0003 in the part "discovery takes only the preferred version of a group".

## Why

- Caching the result did not help: on a cold cache, N parallel `watch_start` calls launched N identical discoveries. A shared result removes exactly that.
- Downloading all CRDs on connect for the sake of columns was rejected: those are the very 9 MB, and columns are needed only by the opened kind.
- The preferred version was rejected: a kind served only by another version of the group was invisible in Custom Resources.
- A measurement on the user's cluster (read only): Nodes 17–24 s → 0.65 s, Pods (472) 32 s → 1.6 s, discovery 20 s → 0.6 s.

## Consequences

- A new CRD appears in the sidebar after reconnecting: discovery is not repeated before that.
- CRD columns arrive in a separate request after the kind is opened, and this requires permission to read that CRD. Without it there will be no columns.
- Which exact version remains when (group, kind) coincide is not recorded in the materials; choosing a version on access still goes through `resolve_kind`, and the versions of built-in kinds are hard-wired into the window's registry.
- The fate of a failed group (earlier it was silently skipped) is not described in this build's materials; it was not re-checked.
- The list of built-in kinds is a constant in the code; it has to be maintained together with the window's kind registry.
