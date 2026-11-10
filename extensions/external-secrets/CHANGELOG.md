# Changes of External Secrets

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in External Secrets view (ADR-0100) as
an extension.

- **A sidebar section "External Secrets"** after Kyverno's, with External Secrets, Cluster External Secrets, Secret
  Stores, Cluster Secret Stores and Push Secrets in Sextant's tables, and the built-in columns: each one's Ready state
  and reason; an ExternalSecret's store, target Secret, refresh interval and last sync; a store's provider and
  capabilities; a PushSecret's source Secret, stores, refresh interval and last sync.
- **Details:** the Ready state with the last error; an ExternalSecret's store and whether it is ready, its target
  Secret (a link), refresh and the remote keys by name; a ClusterExternalSecret's namespaces; a store's provider and
  capabilities; a PushSecret's source Secret, stores and pushed keys. No Secret is ever read.
- **Columns** as wide as the built-in ones; the Status columns sorted and filtered by the state's name, with the
  reason, the message or both on hover; every store's provider by name; every named store of a PushSecret.
- **Details** without a heading of their own, their blocks remembered in Sextant's memory of details sections.
- **Problems:** failed syncs and stores that do not validate (the Ready condition False), one rule per kind with the
  reason or `NotReady`, counted on the section.
- Installing asks for consent to read the five kinds and to judge them in problem rules.
