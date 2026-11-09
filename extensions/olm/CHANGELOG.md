# Changes of Operator Lifecycle Manager

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Operator Lifecycle Manager view
(ADR-0121) as an extension.

- **A sidebar section "Operators (OLM)"** after KServe's, with Subscriptions, Cluster Service Versions, Install
  Plans, Catalog Sources, Operator Groups, Operators and OLM v1's Cluster Extensions and Cluster Catalogs in Sextant's
  tables, and the built-in columns and "Only problems".
- **Details:** a Subscription's state, pending upgrade, CSVs, InstallPlan and catalog health; a CSV's phase,
  requirements, CRDs, install modes and Deployments, a copy linking its original; an InstallPlan's approval, bundle
  lookups and steps; a catalog's registry, an OperatorGroup's targets, an Operator's components, OLM v1's conditions.
- **Problems:** failed operators (originals only), Subscriptions that cannot be resolved, whose InstallPlan failed or
  is stuck, and catalogs not ready, counted on the section. Nothing approves an InstallPlan.
- Installing asks for consent to read OLM's kinds and Deployments, and to judge Subscriptions,
  ClusterServiceVersions and CatalogSources in problem rules.
