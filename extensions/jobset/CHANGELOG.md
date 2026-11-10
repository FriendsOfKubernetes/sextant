# Changes of JobSet

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in JobSet view (ADR-0114) as an
extension.

- **A sidebar section "JobSet"** after Kueue's, with Job Sets in Sextant's table, the built-in columns (Status,
  Succeeded, Active, Failed, Restarts) in their widths, tones and sort orders, Succeeded, Active and Failed added up
  over every replicated job, the Jobs' own counted restarts in Restarts, and "Only problems".
- **Details** without a heading of their own: why a JobSet failed with the first failed Job and its own reason,
  restarts against the limit, the success, failure and startup policies, the replicated jobs, its Jobs and pods; blocks
  in Sextant's own memory of details sections (with "Expand all" and "Collapse all"), the Jobs and pods watched only
  while their block is open (the Jobs also when the JobSet failed), at most 500 of each with a note when a list is cut.
  The tables' columns resize and Sextant remembers their widths, as the built-in tables'.
- **Problems:** JobSets failed within a day, and restarts — the JobSet's own and its Jobs' own — that leave at most one
  before any limit; a new count of restarts counted as first seen again; counted on the section.
- Installing asks for consent to read JobSets, Jobs and Pods, and to judge JobSets in problem rules.
