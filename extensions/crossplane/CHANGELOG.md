# Changes of Crossplane

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Crossplane view (ADR-0101) as an
extension.

- **A sidebar section "Crossplane"** in its built-in place, with Composite Resource Definitions, Compositions,
  Providers, Configurations and Functions in Sextant's table, the built-in columns (Composite kind, Claim kind,
  Established, Offered; Composite type, Mode; Status, Package, Installed, Healthy) with their widths and sort orders,
  "Only problems" on the packages, and the counter of claims and composites that need attention.
- **The page "Composite Resources":** every claim and composite of the kinds the XRDs define, with its state, Synced,
  Ready and the first failing condition, problems first, with "Only problems" (Sextant's own checkbox); it follows the
  cluster's kinds as they change.
- **Details:** an XRD's kinds and versions, a Composition's pipeline, a package's state; for claims, composites and
  managed resources of any kind, their state in plain words and the chain Claim → composite → composed resources, read
  4 at a time and each shown as it comes. Their blocks open and close as Sextant remembers them, and a closed block
  reads nothing.
- **Problems:** the built-in category "Crossplane" as the extension's own, on by default — claims and composites not
  Synced, or not Ready for another reason than being created or deleted, after 2 minutes; one still being created after
  30; a paused one never; a composite with a claim told through the claim (`not-synced`, `not-ready-condition`,
  `not-ready-condition-unnamed`, `not-ready`, `creating-condition`, `creating`), on the kinds the XRDs define
  (`kindsFrom`).
- Installing asks for consent to read every kind (claims, composites and managed resources are of kinds the cluster
  defines) and for the rules on the kinds the XRDs define.
