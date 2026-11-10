# ADR-0089: Service mesh views are read-only models of Istio and Linkerd objects that answer "unknown" rather than "allowed"

## Context

#155 asked for Istio and Linkerd: list their objects, explain where a request goes, who may call a workload, which mTLS mode applies, whether a pod is in the mesh, and what is misconfigured. The authoritative answers live in the proxies (istiod's pushed configuration, Envoy's config dump, linkerd-viz's Prometheus). Reaching them needs port-forwards into the control plane or exec into proxies, and differs per version and install.

## Decision

- **Read-only and frontend only** (`src/features/mesh/`). No Rust command was added; nothing is written to the cluster and nothing talks to istiod, a proxy or linkerd-viz. The generic edit and delete actions of the resource tables apply as for any kind.
- **Discovered sections.** "Istio" (VirtualService, DestinationRule, Gateway, ServiceEntry, Sidecar, WorkloadEntry, PeerAuthentication, RequestAuthentication, AuthorizationPolicy, Telemetry) and "Linkerd" (ServiceProfile, Server, HTTPRoute, AuthorizationPolicy, ServerAuthorization, MeshTLSAuthentication, NetworkAuthentication) show only the kinds the cluster serves, at the version discovery serves. Details explain each object in plain words.
- **One shared configuration per cluster.** `store.ts` holds one shared watch (`acquireWatch`) per served Istio kind the engines need, in all namespaces, plus a metadata-only Service list of at most 40 namespaces those objects name (beyond it no host is judged missing); nothing before discovery, released 5 s after the last user, taken anew on reconnect. The "Request routing" page watches Services and pods only in the destinations' namespaces and only while a result shows them.
- **Pure engines, three-valued answers.**
  - `routing.ts` ("Request routing"): VirtualServices bound to the chosen gateway or `mesh` and exported to the caller, the most specific host, the first matching HTTP route, weights, delegates, DestinationRule subsets and the pods behind them; the implementation-specific choices are listed in its header and shown as notes (RE2 read as JavaScript regular expressions; Sidecar scoping and TCP/TLS routes not evaluated).
  - `authz.ts` ("Who may call this workload?"): CUSTOM → DENY → ALLOW with Istio's empty-rule semantics. Every condition the engine cannot evaluate (JWT principals, path templates, unknown `when` keys, an action Istio does not accept, a DENY or CUSTOM policy attached by `targetRef`) makes the answer "unknown", never "allowed". A policy annotated `istio.io/dry-run: "true"` is shown with what it would do but is not enforced.
  - `mtls.ts`: PeerAuthentication precedence workload > namespace > mesh-wide, UNSET inherits, port-level modes.
  - `membership.ts`: sidecar, native sidecar, ambient, revision and injection for Istio; proxy and `linkerd.io/inject` for Linkerd; "restart needed" when injection is on and a pod has no proxy.
  - `problems.ts`: unknown hosts, missing DestinationRules, subsets or Gateways, TLS modes against STRICT, conflicting VirtualServices, host `*` bound to `mesh`. They feed the problems category `mesh`, the "Only problems" filter and the Istio section counter.
- **Fixed assumptions.** The cluster domain is `cluster.local` and Istio's root namespace is `istio-system`; the mesh configuration (`meshConfig`) is not read. Linkerd authorization is listed per Server, not evaluated.

## Why

- Reading the proxies was rejected: it needs privileged access (exec, port-forward to istiod), is version-specific, and would make a read-only view depend on the control plane's health. The objects are what users write and review.
- Answering "allowed" when unsure was rejected for the same reason as in ADR-0082: a wrong "allowed" invites a false sense of safety, while "unknown" sends the user to check.
- Linkerd golden metrics were left out: they would need a new backend command with fixed queries against linkerd-viz's own Prometheus; the pod section only says whether linkerd-viz is installed. Amended (v0.17.0): #212 added them — the "Requests" details section reads Linkerd's success rate, request rate and latency from the cluster's Prometheus or linkerd-viz's own (ADR-0095); the Linkerd block points there when linkerd-viz is installed.

## Consequences

- A cluster with a custom domain or root namespace gets answers computed for the defaults; the assumptions are stated in the views.
- The answer is what the objects say, not what the proxies currently enforce (a rejected or not yet pushed object still counts).
- Istio objects are watched without a cap; they are few and small on the clusters this was built for.

## Amendment (0.30.0): the views and engines are an extension

The views moved into Sextant's own extension `extensions/mesh` (`sextant.mesh`, one extension for Istio and Linkerd,
ADR-0162 amendment), on the public extension API: the sections `istio` and `linkerd` in their places, the details, the
"Service mesh" block of Pods and workloads, the "Request routing" page and the Istio section counter; the engines
(`istio.ts`, `routing.ts`, `authz.ts`, `mtls.ts`, `membership.ts`, `problems.ts`) are ported into its frame code
unchanged, and the problem checks run in its backend as problem judges (ADR-0168), the category `mesh` becoming the
extension's main category `ext:sextant.mesh`. Every rule above holds there: read-only, from objects only, "unknown" over
"allowed", the same fixed assumptions. The core keeps no view, engine, text or category of the mesh. Agents'
`get_problems` takes the mesh problems from the extension's rules and judges, only where the user lets agents have them
(ADR-0146), and an agent whose Read is restricted to some namespaces gets a judged problem only when it may read every
kind the judge read (ADR-0168) — where ADR-0094's `useAgentMesh` judged each finding on what the agent could read, which
left the core with the category. `diagnose_service` and `check_connectivity` never used the mesh engines.
