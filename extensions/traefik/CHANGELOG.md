# Changes of Traefik

## 1.1.0 — 2026-11-11

Needs Sextant 0.30.1 (`sextantApi` 5); Sextant 0.30.0 keeps 1.0.0. What the built-in view did that extension API 4
could not say (ADR-0169):

- **The References column** on every kind but Middlewares TCP, first, as the built-in tables had it: "Broken reference",
  "Checking…", "Not all checked" or "References found", from what the problem rules say of the row (`problem` cases).
- **Every reference is judged**: a route service's own middlewares (`ir-sm`, lists three deep), and in
  `traefik.containo.us` the TraefikServices and transports of mirrors and failover services, the middlewares of every
  load balancer and a TCP route's ServersTransportTCP (`l-ir-sm`, `l-it-x`, `l-tr-t`, `l-tr-x`, `l-tf-t`, `l-tf-x`,
  `l-th-m`, `l-tm-m`, `l-tr-m`, `l-tf-m`, `l-me-m`): 72 rules.
- **Looked up where Traefik looks**: a load balancer's middlewares naming no namespace in the load balancer's;
  another provider's service's transport in the object's namespace; a Traefik target in either group (one only in
  `traefik.containo.us` is no longer a problem of a `traefik.io` object, one only in `traefik.io` none of an old one),
  and a target kind neither group serves missing.
- **Messages as the built-in wrote them**: the skipped routes numbered ("Traefik skips its routes 1, 3: …"), a route of
  blanks only skipped, a missing TLS option of another namespace named with it.

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Traefik view (ADR-0108) as an
extension.

- **A sidebar section "Traefik"** in its built-in place, with IngressRoutes (HTTP, TCP, UDP), Middlewares (HTTP, TCP),
  TraefikServices, TLSOptions, TLSStores and ServersTransports (HTTP, TCP) of `traefik.io` and of `traefik.containo.us`
  in Sextant's table, the built-in columns (entry points, hosts, services, TLS, type, strategy, TLS settings, Secrets, server
  name, verification) with their widths, and "Only problems".
- **Details:** what can be judged without a status — every reference with what it finds and, in plain words, why one
  breaks its object or cannot be judged (another namespace, another provider, a list not read, the other group) — and
  per kind the routes with their match rules, middlewares and services, a TraefikService's children, a Middleware's
  chain, and the TLS and transport settings, each reference a link; a route's TLS Secret's certificate in Sextant's own
  view (`detailsSections[].certificate`), as the built-in "Certificate" block. Their blocks open and close as Sextant remembers
  them, and a closed block watches nothing. The tables' columns resize and Sextant remembers their widths, as the
  built-in view's.
- **Problems:** routes' missing Services, TraefikServices, servers transports (HTTP and TCP) and middlewares (HTTP and
  TCP), parent routes, TLS options; a TraefikService's weighted, highest-random-weight, mirroring, mirror, failover and
  fallback services with their TraefikServices, servers transports and own middlewares; chained middlewares and the
  error pages' service with its transport and middlewares — each looked up in the namespace it names — and routes
  Traefik skips: after 2 minutes, notified once per object, naming what is missing, in the opt-in category "Traefik
  references", counted on the section while it is on. A few references are left to the details, more of them in
  `traefik.containo.us` (see the README).
- Installing asks for consent to read the Traefik kinds, Services and Secrets (watched as metadata only), to judge
  routes, TraefikServices and Middlewares in problem rules and to list Services, IngressRoutes, Middlewares,
  TraefikServices, TLSOptions, ServersTransports and MiddlewareTCPs by name for them.
