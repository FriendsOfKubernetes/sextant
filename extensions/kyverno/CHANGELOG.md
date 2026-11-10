# Changes of Kyverno

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Kyverno view (ADR-0101) as an
extension.

- **A sidebar section "Kyverno"** in its built-in place, with Cluster Policies, Policies, Policy Reports, Cluster
  Policy Reports, Ephemeral Reports and Cluster Ephemeral Reports in Sextant's table, the built-in columns (Ready,
  Mode, Background, Rules, Message; Object, Pass, Fail, Warn, Error, Skip) with their widths, sort orders and filters,
  and "Only problems".
- **Details:** a policy's readiness, mode, rules and its results over the reports that carry its label, with the
  objects that fail it; a report's object and results; **Policy results** in the details of every other object. Their
  blocks open and close as Sextant remembers them, and a closed block watches nothing; the tables' columns resize, and
  Sextant remembers their widths, as the built-in tables did.
- **Problems:** objects that fail policy rules (notified) and rules Kyverno could not evaluate (listed only), about the
  object a report names, since its earliest such result, in the built-in words and plural forms, in the opt-in category "Kyverno policy failures", counted on the
  section while it is on.
- Installing asks for consent to read Kyverno's policies and reports and to judge PolicyReports and
  ClusterPolicyReports in problem rules.
