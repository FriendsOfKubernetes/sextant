# Changes of CloudNativePG

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in CloudNativePG view (ADR-0100) as an
extension.

- **A sidebar section "CloudNativePG"** after Sealed Secrets', with Clusters, Backups, Scheduled Backups and Poolers in
  Sextant's tables, and the built-in columns: a Cluster's state in words, ready instances, primary and phase; a
  Backup's state, Cluster, method and start; a ScheduledBackup's Cluster, schedule, suspension and last run; a
  Pooler's Cluster, type, instances and pool mode.
- **Details:** a Cluster's state, a switchover or failover in progress, hibernation, its instances with their roles
  and health, its backups and continuous archiving; a Backup's fields and error; a ScheduledBackup's schedule and
  runs; a Pooler's fields.
- **Problems:** Clusters not ready (after five minutes; a hibernated one never), failing continuous archiving or
  backups, Backups failed within a day, counted on the section.
- Installing asks for consent to read the four kinds and to judge Clusters and Backups in problem rules.
