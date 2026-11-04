# Changes of Rook Ceph

## 1.2.0 — unreleased

Needs Sextant 0.29 (`sextantApi` 3). Older Sextants keep 1.1.1. The update asks for consent again: it adds commands
and reads two more kinds.

- **`ceph` commands in Rook's toolbox**, fixed in the manifest and listed word for word at install (ADR-0150):
  - a new **Ceph commands** tab on CephClusters runs `ceph status`, `health detail`, `osd tree`, `osd df tree`,
    `df`, `pg stat`, `versions` and `crash ls-new`;
  - the same tab sets and unsets the cluster's OSD flags (`noout`, `norebalance`, `nobackfill`, `norecover`,
    `noscrub`, `nodeep-scrub`) and archives crash reports.
- **OSDs:**
  - **Mark out**, **Mark in** and **Reweight** per OSD;
  - **Stop** first asks `ceph osd ok-to-stop`, and does not stop an OSD Ceph says cannot be stopped;
  - **Remove** asks `ceph osd safe-to-destroy`, and does not offer the purge Job while Ceph says the OSD is not safe
    to destroy.
- **Its own sidebar section** "Rook Ceph", with a counter of the objects that have a problem. The page was under
  Storage.
- **New problems:**
  - a failed OSD prepare Job and a failed OSD purge Job;
  - a Ceph daemon's Deployment with unavailable replicas, not told while its CephCluster has a problem;
  - an object store user naming a store that is not there;
  - a subvolume group naming a filesystem that is not there;
  - a RADOS namespace naming a pool that is not there.
- Texts that sent you to the toolbox's shell for these commands now point to the Ceph commands tab.

## 1.1.1 — 2026-10-31

- The tabs have their padding back.
- The preview of a change no longer folds on each keystroke.
- Removing an OSD is refused while its placement groups are seen not clean.
- Placeholders no longer look like values.
- JSON previews are called JSON, not YAML.

## 1.1.0 — 2026-10-31

Manages Rook through Rook's own objects (ADR-0141). The update asks for consent again: it changes and deletes.

- Mute health checks, pause Rook's reconciling, deploy or update the toolbox, restart daemons.
- The CRUSH tree and OSDs: replace a disk, stop and start, remove by Rook's purge Job after clean placement groups.
- Storage switches and device-set counts.
- A node's CRUSH labels and device class.
- Ceph upgrades checked against the versions Rook v1.21.1 supports.
- Pool, MDS and gateway settings.
- Create pools, filesystems, object stores, users and StorageClasses; delete them when unused.

## 1.0.0 — 2026-10-31

The first release (ADR-0139): read-only.

- Ceph's health checks in plain words, capacity, daemons, pools, filesystems and object stores with their
  StorageClasses and claims.
- Charts from the Ceph mgr's metrics.
- Problem rules.
- Every language Sextant has.
