# Changes of Contour

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Contour view (ADR-0107) as an
extension.

- **A sidebar section "Contour"** after Traefik's, with HTTPProxies, TLSCertificateDelegations and ExtensionServices
  in Sextant's table, the built-in columns in their widths (a proxy's state as Contour writes it, sorted and filtered
  by its name, its host, TLS Secret, includes (HTTP and a TCP proxy's), routes and first error's reason; a
  delegation's Secrets and every delegation's target namespaces, each once; an ExtensionService's state, Services, protocol and reason), and "Only problems" on HTTPProxies.
- **Details** without a heading of their own, their blocks remembered in Sextant's memory of details sections: a
  proxy's state in plain words with Contour's errors and warnings, its virtual host and TLS (a delegated Secret with
  the TLSCertificateDelegation that allows it), routes with each service's share or mirror percent, a TCP proxy's
  services, includes with their states and the delegation tree; a delegation's Secrets and the namespaces that may use
  them; an ExtensionService's state, settings and Services.
- **Problems** in the category "Contour", on by default and given to agents only where Settings → AI agents (MCP)
  lets them: invalid and orphaned HTTPProxies, after 2 minutes, notified and counted on the section; an orphan
  under an invalid proxy (through its includes or its TCP proxy's) is told through that proxy, as the built-in
  told it.
- Installing asks for consent to read HTTPProxies, TLSCertificateDelegations and ExtensionServices, and to judge
  HTTPProxies in problem rules.
