# ADR-0086: Volume usage is read from kubelet stats or Prometheus, and storage actions only ever create new objects

## Context

#152 asked how full PersistentVolumeClaims are, an alert before a disk fills up, and views and actions for VolumeSnapshots and Velero (back up a namespace, restore a backup, snapshot a claim, restore a snapshot to a new claim). Usage is not in any Kubernetes object: it is in each kubelet's stats summary (reachable through the API server's `nodes/proxy`) or, where `nodes/proxy` is not granted, in Prometheus (`kubelet_volume_stats_*`). Storage actions are high-stakes: restoring over an existing claim, or overwriting an existing Backup or Restore object of the same name, can lose data, and an apply (server-side patch) would modify an object that already exists.

## Decision

- **Usage from the kubelets first, Prometheus second.** `metrics/volumes.rs` lists node names (metadata, ≤ 500), reads `/api/v1/nodes/<node>/proxy/stats/summary` 8 nodes at a time (10 s and 16 MiB per answer, 40 s per round) and deserializes only the claims' volume fields. When `nodes/proxy` or listing nodes is forbidden, or no node answers, it uses the cluster's configured Prometheus with fixed `kubelet_volume_stats_*` queries that name no object (`metrics/prometheus/volumes.rs`) and says so; without either the error names both reasons.
- **One formula.** Used = capacity − available where both are known, so blocks reserved for root count as used (as Prometheus' `KubePersistentVolumeFillingUp` does); inodes likewise total − free. One entry per claim (the fullest reading when a claim is mounted on several nodes), ≤ 10 000 claims.
- **Polled only while shown.** `storage_volume_usage` is read-only; the window polls it once a minute per cluster only while a view (Usage column, a claim's "Usage", a pod's "Volume usage", the problems source) holds it, never two rounds at once.
- **"Disk almost full" is opt-in.** The problems category `disk` is off by default (`OPT_IN_CATEGORIES`); a claim at or over `notifications.volumeWarnPercent` (85) or `volumeCriticalPercent` (95), of bytes or inodes, is a problem of the claim. Its source is `external`: the problems store opens no watch for it and takes the problems from the storage feature's provider.
- **Create-only writes.** Every storage action builds exactly one object from a form (`forms.ts`), shows it with its YAML on a confirmation, and sends it with the new `resource_create` (`resources::create_yaml`): one POST, under `CHANGE_TIMEOUT`, never repeated, refusing the hidden-values marker. An object of that name that exists — also one that appeared after the form was opened — is never touched: the API server answers AlreadyExists, which the dialog shows. A snapshot restore always targets a new claim (same namespace, size at least the snapshot's restore size); a Velero Backup is created in Velero's namespace (found by its BackupStorageLocations).
- **Not for agents or extensions.** `resource_create` and `storage_volume_usage` are window commands only.

## Why

- `resource_apply` was rejected for these actions: an apply of an existing name merges into the existing object; for a Restore or a claim that is a silent change of something the user did not pick.
- Running `velero` or `kubectl` CLIs was rejected, as for GitOps (ADR-0024): the Kubernetes API is enough and keeps one guard and one error path.
- Using `used` from the summary was rejected: it does not count reserved blocks, so a claim could report 90 % while writes already fail.

## Consequences

- Use `resource_create` wherever an existing object must never be modified; it is not a general "apply".
- Without `nodes/proxy` and without Prometheus there is no usage; snapshots and Velero still work.
- Velero itself skips most objects that exist on restore and merges some kinds (ServiceAccounts); the restore dialog says so.
