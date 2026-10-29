# ADR-0134: Port-forward management uses a shared event snapshot and explicit provenance

## Context

Pod and Service details could start a port forward and open its address, but could not stop it there. The Network page offered a basic list with Stop. Connections created by agents or internal features also needed a truthful source and protection against accidental bulk interruption.

## Decision

- Extend the existing Network → Port Forwarding page, scoped to the selected cluster. Resource, Namespace, local/remote ports, status, source, error details and actions have separate columns. Rows use the standard table height, column resizing and single-line truncation. Search and status filters affect only this list; namespace selection elsewhere does not hide its connections.
- Offer Open, Copy address and Stop in the page, resource details and the successful creation dialog. The form shows existing forwards for its target and remote port. All port forwards opens the current cluster's page. Closing a dialog or navigating does not close listeners; a dialog whose forward ended shows that it stopped.
- Keep one reference-counted frontend snapshot while any of these surfaces is visible: attach the existing `portforwards` listener, then request the initial list. Events supersede in-flight list results and errors. A late start reply cannot restore a connection removed by a newer event. The last consumer releases the listener and idle snapshot. There is no polling or per-row subscription.
- Reconcile successful commands locally when no newer event supersedes their result. Deduplicate pending stop/retry commands by ID across surfaces. Explicit Retry stops the old listener before starting with the same target and ports; if starting fails, keep those parameters and the error in an editable dialog. A failed stop remains visible. The core's existing Service recovery remains unchanged.
- Confirm bulk stop with the target list and ports. Selection is discarded when rows disappear, are filtered out or the cluster changes. Stop checks the latest snapshot between commands, tolerates entries already removed, and continues after an individual failure. Failed entries and their error remain available.
- Add `ForwardSource` (`user`, `agent`, `vcluster`, `argoCd`) to the existing `ForwardInfo` DTO. Missing source defaults to `user`. Trusted creation sites set provenance before the first event; display provenance never selects access policy. `start` keeps its existing contract and delegates to `start_with_source`. MCP forwards still use `PodFilter::NoNodeAccess` and the existing ownership checks.
- Internal forwards are excluded from bulk selection and Retry. Individual stop requires confirmation; a vcluster forward warns that stopping it disconnects the virtual cluster. The page lists `AppState.forwarder`; Argo CD's separately owned session forwarder remains private. No new IPC commands, SDK methods, settings, dependencies or changes to TCP forwarding are required.

## Why

A cluster-scoped page follows the existing navigation and keeps connection ownership clear. Backend provenance avoids guessing from resource names or issuing extra ownership queries. Reusing the current commands, event and dialog limits the change to management rather than introducing another connection lifecycle.

## Validation

Focused tests cover wire compatibility, provenance in the first event and list, unchanged pod access guards, shared subscription cleanup, event/command races, stop/retry failures, bulk partial failures and disappearing targets, cluster isolation and accessible controls. Browser checks cover actual row geometry, search alignment, both themes and enlarged text; Windows builds use the existing Tauri build path. Live-cluster and other-platform results are reported separately from local tests.
