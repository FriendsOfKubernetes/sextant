# Changes of Operator Lifecycle Manager

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Operator Lifecycle Manager view
(ADR-0121) as an extension.

- **A sidebar section "Operators (OLM)"** after KServe's, with Subscriptions, Cluster Service Versions, Install
  Plans, Catalog Sources, Operator Groups, Operators and OLM v1's Cluster Extensions and Cluster Catalogs in Sextant's
  tables, and the built-in columns and "Only problems".
- **Columns** with the built-in widths and sorting (the Subscription state by state, Approved, OLM v1's conditions by
  status and reason — a Progressing condition without a reason last —, all namespaces first), Replacing and Deleting
  CSVs muted, an InstallPlan's CSVs joined with commas.
- **Details:** a Subscription's state, pending upgrade, CSVs, InstallPlan and catalog health; a CSV's phase,
  requirements, CRDs, install modes and Deployments (at most 50, watched only while their block is open), a copy
  linking its original; an InstallPlan's approval, bundle lookups and steps; a catalog's registry, an OperatorGroup's
  targets, an Operator's components, OLM v1's conditions. Untitled sections, as the built-in one, whose blocks are
  kept in Sextant's own memory of details sections.
- **Problems:** failed operators (originals only), Subscriptions that cannot be resolved, and InstallPlans that failed
  or are stuck (about the plan, the stall's grace starting again when its phase moves), and catalogs not ready,
  counted on the section, with the built-in reason when OLM gives none. Nothing approves an InstallPlan.
- Installing asks for consent to read OLM's kinds and Deployments, and to judge Subscriptions,
  ClusterServiceVersions and CatalogSources in problem rules.
