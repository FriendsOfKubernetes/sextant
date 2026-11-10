# Changes of CloudNativePG

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in CloudNativePG view (ADR-0100) as an
extension.

- **A sidebar section "CloudNativePG"** after Sealed Secrets', with Clusters, Backups, Scheduled Backups and Poolers in
  Sextant's tables, and the built-in columns with their widths: a Cluster's state in words (sorted and filtered by
  the state's name, hibernation greyed), ready instances (of `spec.instances`, else `status.instances`), primary and
  phase; a Backup's state (sorted and filtered by the state's name, Pending greyed), Cluster, method and start; a
  ScheduledBackup's Cluster, schedule, suspension and last run; a Pooler's Cluster, type, instances and pool mode.
- **Details** (without a heading, as the built-in section): a Cluster's state, a switchover or failover in progress,
  hibernation, its instances with their roles and health, its backups and continuous archiving; a Backup's fields and
  error; a ScheduledBackup's schedule and runs; a Pooler's fields. The blocks open and close in Sextant's own memory
  of details sections, with "Expand all" and "Collapse all"; the Instances table's columns resize, and Sextant
  remembers their widths, as the built-in table did.
- **Problems:** Clusters not ready (after five minutes; a hibernated one never), failing continuous archiving or
  backups, Backups failed within a day (a phase in any case), counted on the section, with the built-in reasons, over
  up to 20 000 Clusters and Backups; "Only problems" as the built-in tables.
- Installing asks for consent to read the four kinds and to judge Clusters and Backups in problem rules.
