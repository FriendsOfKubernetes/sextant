# ADR-0077: The overview of several clusters connects only on a click and rides on the problem watches

## Context

People who run several clusters want one screen that says which of them is unhealthy, and to find a pod or a Deployment without opening each cluster in turn (#144). Sextant is built around one active cluster; every view watches the open cluster only. A connection is not free: it can start an exec plugin or a cloud CLI that opens a browser sign-in, and every watched kind of every cluster costs memory and API-server load.

## Decision

- **A window-wide page, not a cluster.** "All clusters" at the top of the cluster rail sets `useAppStore().homeView = "fleet"`; the main area draws the `home` slot, the active cluster steps back with its connection kept. Opening a cluster from anywhere clears `homeView`, so the page unmounts and its watches close.
- **Never connects by itself.** The chosen clusters are `AppSettings.fleet.selected` (frontend-written, at most 10, `MAX_SELECTED`). A cluster that is not connected is connected only by its own "Connect" button or "Connect all selected", which runs at most 2 connections at a time (`CONNECT_CONCURRENCY`), with the usual timeouts and the error shown on the card. Opening the page or restoring the selection never starts a connection.
- **One watch per (cluster, kind), shared.** The health cards use the problems store's sources (`useClusterProblems`, every category except the opt-in `security`), the same ones the problems screen and notifications hold. Node, Pod and workload rows are taps on those watches (`acquireRows` in `src/features/problems/store.ts`, `src/features/fleet/rowsStore.ts`): each update is reduced to compact rows at once (at most 5000 per kind and cluster, `MAX_KEPT_ROWS`), objects are not kept, and a tap added to a watch that already listed re-lists once. The Warning events table reads the problems' `events` source. Pods and workloads are tapped only for the open tab. Metrics use the shared pollers.
- **Bounded output.** A table shows at most 200 rows per cluster after the cluster and namespace filters (`MAX_SHOWN_ROWS`) and counts the rest; at most 200 Warning events per cluster. "Find by name" uses the command palette's metadata-only object index (six default kinds per cluster, or the one kind the query names).
- **Read-only.** No action is offered on the page; a link opens the object in its cluster, where the usual actions apply. Agents and extensions get nothing new.

## Why

- Connecting every selected cluster when the page opens was rejected: a page view must not start a browser sign-in, a cloud CLI call or a VPN-dependent timeout for ten clusters at once.
- Separate watches for the overview were rejected: the cards already need pods, nodes and workloads for the problem rules, and a second watch of the same (cluster, kind) doubles memory and API-server load for the same objects.
- Keeping whole objects for the tables was rejected: ten clusters of thousands of pods are hundreds of megabytes; a row needs a few fields.
- More than 10 clusters or unbounded parallel connects were rejected: each selected cluster keeps several watches open, and parallel sign-ins fight over the browser and the terminal.

## Consequences

- A cluster not connected shows only its name and a Connect button; the overview is as fresh as the connections the user made.
- While the page is open, its clusters keep their problem watches open; notifications already do the same for connected clusters (ADR-0067).
- Security findings (ADR-0076) are not on the cards, even when the category is on, so the overview never adds seven workload watches per cluster.
- Tests: `src/features/fleet/fleet.test.tsx`.
