# Changes of Velero

## 1.0.0 — 2026-11-09

Needs Sextant 0.30 (`sextantApi` 4) with `resources.create` (#412). The first release: the Velero part of Sextant's
former built-in storage insights (ADR-0086) as an extension.

- **A sidebar section "Velero"** after Volume Snapshots, with Backups, Schedules, Restores, Backup Storage Locations
  and Volume Snapshot Locations in Sextant's tables, the built-in columns (phases coloured, errors and warnings,
  namespaces, schedule, last backup, provider, bucket, default location, last validation), each as wide as the
  built-in one, error and warning counts sorted and filtered as numbers, and "Only problems" (failed, refused,
  unavailable, or a phase ending in `PartiallyFailed`).
- **Details:** each object's state in plain words — why it was refused or failed, its errors and warnings and where
  their log is, its progress, a paused schedule, an unreachable location — and its fields, with the backup, schedule
  and storage location linked, in one block that opens and closes as the built-in one did, remembered by Sextant.
- **Actions:** "Back up namespace…" on a Namespace where the cluster serves Velero's Backups and "Restore from this
  backup…" on a Backup, each a form (the name focused) and a confirmation listing the one object and its YAML,
  created once and never over an existing one.
- Installing asks for consent to read the five Velero kinds and to create Backups and Restores without a second
  question.
