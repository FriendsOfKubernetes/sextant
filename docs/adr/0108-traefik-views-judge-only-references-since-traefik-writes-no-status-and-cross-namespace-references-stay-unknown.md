# ADR-0108: Traefik views judge only references, since Traefik writes no status; cross-namespace references stay unknown

## Context

#232 asked for Traefik's CRDs (IngressRoute, IngressRouteTCP/UDP, Middleware, MiddlewareTCP, TLSOption, TLSStore, TraefikService, ServersTransport) in the style of the other CRD projects (ADR-0097, 0100, 0101), with a status column, problems and the traffic diagnosis of #208 following an IngressRoute to its pods. Unlike every project before it, Traefik writes **no status** on any of these kinds (`pkg/provider/kubernetes/crd/traefikio/v1alpha1`: no `Status` field on any type): a route Traefik refuses is only a line in Traefik's log. And whether a reference into another namespace is followed depends on `providers.kubernetesCRD.allowCrossNamespace` (off by default), a flag of Traefik's static configuration that no Kubernetes object shows.

## Decision

- **Read-only, frontend only.** `src/features/traefik/` adds no Rust command; the kinds offer the generic Edit and Delete only. A discovered sidebar section `traefik` lists the kinds of `traefik.io` and, where a cluster still serves it, of `traefik.containo.us` (labelled with the group; Traefik 2.10 reads both groups, so a reference resolves against either). Nothing is watched before discovery or for a kind the cluster does not serve.
- **What is judged is whether references lead anywhere** (`resolve.ts`), read in the shapes of Traefik's types (`model.ts`) and resolved as its provider resolves them (`kubernetes.go` `resolveReference`, `kubernetes_http.go` `nameAndService`): a reference's namespace is its own or its object's; `name@provider` names another provider's object. The state column says "References found", "Broken reference" or "Not all checked" — never ready/progressing, since nothing says so.
  - **Broken:** a Middleware, Service, TraefikService, TLSOption or Secret that does not exist (Traefik skips the route: 404; a missing TLS Secret makes it serve its default certificate), a service `kind` other than Service/TraefikService, a route with an empty match or a kind other than `Rule`.
  - **Unknown, never broken and never fine:** a reference into another namespace whose target exists (depends on `allowCrossNamespace`, said in words); `name@provider` (another provider; `@internal` services are Traefik's own and always exist); a list not read or capped. A missing target in another namespace is broken whatever the flag says.
  - **Not breaking:** a route's TLSStore reference (Traefik's routers do not use it; only the store `default` exists).
- **One store** (`store.ts`) feeds the column, the details, the counter and the problems: one watch per served Traefik kind in all namespaces (≤ 5000 objects each), and metadata-only lists of Services and Secrets in the namespaces the references name (≤ 40 each; beyond, those references stay unknown) — Secret names only, no value ever reaches the window. Shared watches of the resource map, released 5 s after the last user, rebuilt at most every 500 ms.
- **Problems:** a new category `traefik`, on by default (a broken reference is a real outage), through an external provider (`provider.ts`, source held only where `traefik.io` IngressRoutes are served), after a 2-minute grace for objects applied in the wrong order. It is in `NEVER_FOR_AGENTS`.
- **Diagnosis:** the diagnosis engine got a route-kind registry (`src/features/diagnose/routeKinds.ts`) so projects add kinds without touching `ingress.ts`/`route.ts`: a registered kind names the namespaces of its Services, its own lists (`ClusterView.objects`, absent from an agent's view) and its TLS Secrets. `diagnose/traefik.ts` follows an IngressRoute: entry points (with the no-status note), TLS (the Secret's certificate read by the core as for an Ingress, covering the hosts of `Host`/`HostSNI` rules and `tls.domains`; a resolver's certificate is unknown), then per route the rule, each middleware, and each service — a Service on into the Service's own checks, a TraefikService through weighted, mirroring, highest-random-weight and failover children (≤ 4 levels, ≤ 30 services). It lists Traefik objects in at most 4 namespaces. IngressRouteTCP/UDP are not diagnosed.

## Why

- Inventing a readiness from the objects (e.g. "ready when every reference exists") was rejected: the column would claim what Traefik never said; "References found" is exactly what was checked.
- Treating cross-namespace references as broken (Traefik's default) or as fine (a common setting) would each be wrong for half of the installations; Sextant cannot read Traefik's static configuration, so it says so.
- Listing Secrets in full to check TLS references was rejected; metadata-only lists carry names only.

## Consequences

- A route rejected for a reason only Traefik's log shows (a syntax error in a match rule, an entry point Traefik does not have, an ingress class its provider ignores, `allowExternalNameServices` off) is shown as fine or unknown; the details and the diagnosis say Traefik writes no status.
- A cluster serving only `traefik.containo.us` (Traefik before 2.10) gets the section but no problems.
- More than 40 namespaces of referenced Services or Secrets leave those references unknown.
