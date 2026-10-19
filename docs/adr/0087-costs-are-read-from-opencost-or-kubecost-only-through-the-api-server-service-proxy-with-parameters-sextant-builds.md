# ADR-0087: Costs are read from OpenCost or Kubecost only through the API server's service proxy, with parameters Sextant builds

## Context

#153 asked what a cluster, a namespace or a workload costs, and what applying a right-sizing recommendation (ADR-0070) would save. Kubernetes has no notion of money; OpenCost (and Kubecost, whose allocation API is compatible) computes it from node prices and usage. Reaching such a service usually means a port-forward or an ingress, and its API takes free-form parameters (filters, aggregation by any property) and can answer with very large bodies for fine groupings over 30 days.

## Decision

- **Found, never installed.** `crates/sextant-core/src/cost.rs` looks for the cost Service in the `opencost` and `kubecost` namespaces and anywhere by `app.kubernetes.io/name` `opencost` / `cost-analyzer` (≤ 50 labelled Services); OpenCost is preferred over Kubecost, then the candidate namespaces; the port is 9003 or 9090 (the API path differs per product and port, `CostSource::api_path`). The result (also "not found") is reused for 60 s per connection. Without a cost service the page says so and the details section is hidden.
- **Only through the service proxy.** Requests go to `/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/…` with the user's own credentials, as Prometheus is reached: no local port is opened, nothing is held between calls, no credential is asked or stored, and RBAC (`services/proxy` `get`) decides; a 403 says so.
- **Sextant builds every parameter.** The window sends a `CostQuery` — `window` (24h, 7d, 30d), `aggregate` (namespace, workload, pod, node, or one label key) and an optional namespace list (≤ 200). `cost::validate` checks it before the cluster is looked up (DNS-1123 namespaces, a label-key shape); `client::request_uri` writes the fixed parameters (`accumulate=true`, `includeIdle=true`, `idle=true`, `shareIdle=false`) and percent-encodes the rest. No path, filter or parameter typed by the user reaches the service.
- **Caps.** 30 s per request, at most 8 MiB of answer (a bigger one asks for a coarser grouping or a shorter period), at most 2000 rows (most expensive first, with the total count and a `truncated` flag), only the fields the views need are kept; non-finite numbers read as missing. The idle cost is kept apart and stays whole-cluster also under a namespace filter.
- **Estimates are labelled.** A workload's monthly estimate is its cost over the covered hours of the last 7 days scaled to 30 days. The savings of a right-sizing recommendation are (current requests − recommended) over all replicas × the unit prices this workload's own allocation implies (CPU cost ÷ core-hours, memory cost ÷ GiB-hours) × 30 days; without a price for a reduced resource no savings are shown. The workload's pods come from one shared watch per (cluster, namespace, selector) that the right-sizing and cost sections both use (`rightsizing/workloadPods.ts`).
- **Read-only, window only.** `cost_allocation` changes nothing; MCP agents and extensions get no cost tool or method (test in `src-tauri/src/commands/cost.rs`). The window polls a report every 10 minutes while it is shown.

## Why

- A port-forward per cluster was rejected: it holds a local port and a connection that must be closed, and it adds nothing over the service proxy for a few small GETs.
- Passing user-written filters through was rejected: the allocation API's filter language is broad, and a fixed parameter set keeps answers bounded and the requests reviewable.
- Computing costs in Sextant from node labels and list prices was rejected: OpenCost already does it with the cluster's real pricing, and two sources would disagree.

## Consequences

- Users whose RBAC lacks `services/proxy` on the cost Service see a permission message, not costs.
- Currency is shown when the answer names one; otherwise amounts are "in the installation's currency".
- Kubecost-only features outside the compatible allocation API (budgets, savings reports) are not used.
