# Changes of Service mesh

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in service mesh views (ADR-0089) as an
extension.

- **Two sidebar sections, "Istio" and "Linkerd"**, in their built-in places, with the Istio kinds (VirtualServices,
  DestinationRules, Gateways, ServiceEntries, Sidecars, WorkloadEntries, PeerAuthentications, RequestAuthentications,
  AuthorizationPolicies, Telemetry) and the Linkerd kinds (ServiceProfiles, Servers, HTTPRoutes, AuthorizationPolicies,
  ServerAuthorizations, MeshTLSAuthentications, NetworkAuthentications) in Sextant's table, the built-in columns with
  their widths, and "Only problems" on VirtualServices.
- **Details in plain words** of every kind: a VirtualService's routes as "when … then …" cards with weights, retries,
  timeouts and faults, and "Check a request…"; a DestinationRule's subsets and TLS modes; a Gateway's servers and bound
  VirtualServices; what a PeerAuthentication, RequestAuthentication or AuthorizationPolicy means and each rule in
  words; a Linkerd Server with the authorizations that target it, and Linkerd's policies as who is let in. A
  VirtualService's and DestinationRule's every Istio configuration mistake is shown on them.
- **"Service mesh" on Pods and workloads**: Istio and Linkerd membership, the Istio mTLS mode by PeerAuthentication
  precedence, and "Who may call this workload?" from AuthorizationPolicies, "Cannot tell" where a condition cannot be
  evaluated.
- **Request routing**: where a request from a workload in the mesh or into an Istio Gateway goes — the VirtualService,
  the route, the weighted destinations with their DestinationRule, subset, TLS mode and ready pods, or what the proxy
  answers — with the routes skipped and the VirtualServices that did not apply.
  "Check a request…" on a VirtualService closes the details and opens it prefilled; the form, headers included, is kept
  per cluster for the run only.
- **Tables** of the details, the "Service mesh" block and Request routing with columns that resize, their widths
  remembered by Sextant, as the built-in view's (the widths set there carry over).
- **Problems**, in the category "Service mesh" (on by default, counted on the Istio section, given to agents only where
  you allow it), every one the built-in view found: unknown hosts, subsets without a destination rule or missing from
  it, gateways that do not exist, the host `*` on the sidecars, VirtualServices shadowed by an older one, and TLS modes
  that STRICT mTLS refuses — the built-in checks, run by the extension's WebAssembly backend as problem judges
  (ADR-0168), with the built-in messages, every finding its own problem; "Only problems" on VirtualServices and
  DestinationRules, and the section's counter counting the problems, as the built-in did. A namespace whose lists could not be read
  is unknown, a finding is told only when everything it rests on was read, and agents get one where they may read
  that.
- Installing asks for consent to read the Istio and Linkerd kinds, Services, Pods, Namespaces, Deployments,
  StatefulSets, DaemonSets and ReplicaSets, to judge VirtualServices and DestinationRules in problem rules, and to give
  its backend, for them, the `spec` of VirtualServices, DestinationRules, ServiceEntries and PeerAuthentications and
  the names of Gateways and Services.
