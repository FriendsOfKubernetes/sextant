# Changes of Traefik

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Traefik view (ADR-0108) as an
extension.

- **A sidebar section "Traefik"** in its built-in place, with IngressRoutes (HTTP, TCP, UDP), Middlewares (HTTP, TCP),
  TraefikServices, TLSOptions, TLSStores and ServersTransports (HTTP, TCP) of `traefik.io` and of `traefik.containo.us`
  in Sextant's table, the built-in columns (entry points, services, TLS, type, strategy, TLS settings, Secrets, server
  name, verification) with their widths, and "Only problems".
- **Details:** what can be judged without a status — every reference with what it finds and, in plain words, why one
  breaks its object or cannot be judged (another namespace, another provider, a list not read, the other group) — and
  per kind the routes with their match rules, middlewares and services, a TraefikService's children, a Middleware's
  chain, and the TLS and transport settings, each reference a link. Their blocks open and close as Sextant remembers
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
