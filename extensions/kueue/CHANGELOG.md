# Changes of Kueue

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Kueue view (ADR-0114) as an
extension.

- **A sidebar section "Kueue"** after Dynamic Resource Allocation's, with Cluster Queues, Local Queues, Workloads,
  Resource Flavors, Cohorts, Admission Checks and Workload Priority Classes in Sextant's table, the built-in columns
  (Node labels of the flavors included, joined with ", ") in their widths, sorted and filtered as the built-in ones, and "Only problems".
- **Details** without headings of their own, their blocks remembered in Sextant's memory of details sections: a
  ClusterQueue's quota against what is reserved and in use, its LocalQueues and waiting Workloads (every Workload of the
  cluster read, at most 5000, only while the list is open); why a Workload waits, was evicted or deactivated, its job,
  pod sets, admission checks and evictions; the flavors, cohorts and checks with the ClusterQueues that use them; a
  **Queue** block on every job Kueue queues — labelled, or with a Workload Kueue made for it — with its Workload.
- **Problems:** queues that admit nothing in the category "Kueue queues", on by default; Workloads waiting too long,
  not queueable, deactivated by Kueue or evicted repeatedly in the opt-in category "Kueue Workloads waiting or
  evicted"; counted on the section. Neither category is given to agents, as the built-in ones were not.
- Installing asks for consent to read the Kueue kinds and the jobs Kueue queues, and to judge ClusterQueues,
  LocalQueues and Workloads in problem rules.
