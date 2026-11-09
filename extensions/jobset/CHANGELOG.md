# Changes of JobSet

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in JobSet view (ADR-0114) as an
extension.

- **A sidebar section "JobSet"** after Kueue's, with Job Sets in Sextant's table, the built-in columns (Status,
  Succeeded, Active, Failed, Restarts) and "Only problems".
- **Details:** why a JobSet failed with the first failed Job and its own reason, restarts against the limit, the
  success, failure and startup policies, the replicated jobs, its Jobs and pods.
- **Problems:** JobSets failed within a day and restarts that leave at most one before the limit, counted on the
  section.
- Installing asks for consent to read JobSets, Jobs and Pods, and to judge JobSets in problem rules.
