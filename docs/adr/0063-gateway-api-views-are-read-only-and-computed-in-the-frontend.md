# ADR-0063: Gateway API views are read-only and computed in the frontend

## Context

Gateway API (GatewayClass, Gateway, HTTPRoute, GRPCRoute and the other routes, ReferenceGrant, BackendTLSPolicy) is becoming the way traffic enters a cluster, and a failure there is spread over several objects: a route is not accepted on a listener, a hostname does not intersect, a ReferenceGrant is missing, a Service has no ready endpoints. Reading each object's YAML does not answer "why does my request not arrive" or "where would it go". The sidebar needs a section, readable details, links from a Service or a Secret back to the routes and listeners that use it, a Gateway topology and a way to ask where a request would go. Discovery already tells which kinds a cluster serves (ADR-0031), and the data is plain objects the frontend can watch.

## Decision

- **Read-only.** Sextant shows and explains Gateway API objects; it does not create, patch or reconcile them and sends no traffic.
- **Computed in the frontend.** The section watches the served kinds, a pure model (`src/features/gateway-api/model.ts`) turns objects and their status into listeners, parents, relations and problems, and the views are built on it. No Rust command, event or core code is added.
- **A request check, not a traffic simulator.** The matching engine (`matching.ts`) follows a request described by the user (method, URL, headers) through the listener, route, rule and backends under the Gateway API v1 rules and returns the winner and the reasons the other candidates lost. It reads only watched objects.
- **Ambiguities are resolved in the open.** Where the spec leaves a choice to the implementation, the choice is documented in the header of `matching.ts` and shown as a note in the result, so the answer never claims more than the spec says.
- **Built in, in the section system.** The kinds, pages and counters go through the existing registries; the generic pieces it needed (`ResourceDef.problem` with the "Only problems" filter, `registerSectionBadge`, a details tab `labelKey`, folding of long annotations) are available to any feature. A page of a discovered section is shown only while the cluster serves one of its kinds.
- **Watches are bounded.** Only kinds the cluster serves are watched, nothing before discovery, and namespaced lists only for the involved namespaces.

## Why

- Computing in Rust (`sextant-core`) was rejected: the inputs are objects the frontend already watches, every view needs them live, and a command per view would add a second copy of the data and a type boundary (ts-rs) for results that are only displayed. The agent (MCP) and extensions do not use these views.
- An extension instead of a built-in feature was rejected: extensions are sandboxed frames with their own permissions (ADR-0047 onwards) and could not add a sidebar section with a counter, an "Only problems" filter and reverse links on built-in Service and Secret details; Gateway API is core to a Kubernetes client now, like Flux and Argo CD.
- A full traffic simulator, or sending real requests through the Gateway, was rejected: a real request depends on the controller, its data plane and its network position, and would make Sextant a tool that talks to workloads. A check from the declared objects is safe and explains configuration, not the implementation's behaviour.

## Consequences

- On a large cluster the section holds big watches (all routes, Gateways, Services and EndpointSlices of the involved namespaces) in the window's memory while its pages are open; they end when the component unmounts.
- Spec ambiguities (a regular-expression path ranked between Exact and PathPrefix, the JavaScript regular-expression dialect, the hostname deciding before the route kind, namespace selectors without labels) can differ from a given controller. They are written down and returned as notes; an answer is "what the spec says", not "what this controller does".
- There is no controller-specific knowledge beyond what the objects' `status` says: a controller that reports less shows less.
- Because it is read-only, a problem is explained but fixed elsewhere (the YAML editor, GitOps).
- Tests cover the model and the engine with fixtures (`src/features/gateway-api/fixtures/`) and the test cluster brings up Gateway API objects; there is no e2e of the section.
