# Rook Ceph

A view and control panel of [Rook](https://rook.io) Ceph clusters, in every language Sextant has. It shows Ceph's
health in plain words, capacity, daemons, the CRUSH tree and OSDs, pools, filesystems and object stores with the
storage classes and claims on them, charts and problems. It changes Rook through Rook's own objects and runs a fixed
set of `ceph` commands in Rook's toolbox. Every change is shown first and confirmed by Sextant. Its id is
`sextant.rook-ceph`. Why it is built this way: ADR-0139 (the module), ADR-0140 (its translations), ADR-0141 (what
it may change through Rook's objects) and ADR-0150 (the `ceph` commands).

## At a glance

| | |
|---|---|
| Id | `sextant.rook-ceph` |
| Version | 1.2.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 3: Sextant 0.29 or newer. Sextant 0.28 is offered 1.1.1 by the catalog of Sextant 0.29+; Sextant 0.26–0.28 themselves show "needs a newer Sextant" (ADR-0149). |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `rook-ceph-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Rook Ceph |
| Checked against | Rook v1.21.1's CRDs and examples; its upgrade check knows Ceph Squid (from 19.2.0) and Tentacle (from 20.2.1) |

## What it adds

**The "Rook Ceph" page** (`overview`), in a sidebar section of its own, "Rook Ceph" (`rookCeph`). The section's
counter shows how many objects have a problem of the rules below.
- Every CephCluster: Ceph's health, the first health checks, capacity, and when Rook last checked. The status is
  marked stale after 15 minutes without a refresh.
- Pools, filesystems and object stores with their phases and the StorageClasses on them.
- The other Rook objects.
- The StorageClasses on Ceph, with how many claims use each.
- **Create:** a pool, filesystem, object store or user, optionally with a StorageClass on it, written as Rook's
  examples write them.

**CephCluster details:**
- **Ceph status** (`status`, a section): each health check in plain words, with Mute and Unmute (Rook's
  `muteHealthWarning`); capacity; versions, with a warning when daemons run two; Pause or Resume of Rook's
  reconciling; the toolbox pod, with Deploy when there is none and Update when its image differs from the
  cluster's.
- **Daemons** (`daemons`, a tab):
  - the operator, monitors, managers, OSDs (by node), MDS, RGW, NFS, mirroring, exporters and the CSI drivers;
  - each pod's readiness and restarts;
  - Restart, when the pod's controller re-creates it.
- **CRUSH and OSDs** (`osds`, a tab):
  - the CRUSH tree from Rook's labels on the OSD Deployments, with each OSD's state, usage and reweight;
  - per OSD: replace its disk, stop or start it, pause or resume its reconciling, mark it out or in, reweight it,
    and once it is stopped, remove it with Rook's purge Job;
  - the cluster's storage switches and the `count` of each device set.
- **Ceph commands** (`commands`, a tab): the toolbox, the reading commands with their output, the cluster's OSD flags
  with Set and Unset, and archiving crash reports.
- **Metrics** (`metrics`, a tab): health, raw capacity, OSDs up and in, and placement groups by state, over 1 hour to
  7 days.

**CephBlockPool, CephFilesystem, CephObjectStore details:** **Storage classes and claims** (`storage`, a section),
listing the StorageClasses on the object and the PersistentVolumeClaims or ObjectBucketClaims that use them.

**Node details:** the **Rook Ceph** tab (`topology`): the CRUSH location labels Rook reads
(`topology.kubernetes.io/region|zone`, `topology.rook.io/<level>`), the node's device class, and the OSDs on it.

**Actions:**
- **Upgrade Ceph…** (`upgrade`) on a CephCluster, checked against the Ceph versions Rook v1.21.1 supports, the
  cluster's health and the versions it runs.
- **Pool settings…** (`pool-settings`): replica count, quotas, failure domain, device class, CRUSH root.
- **Metadata servers…** (`mds`) on a filesystem: the active MDS count and standby-replay.
- **Object gateways…** (`gateways`) on an object store: the number of RGW instances.
- **Create StorageClass…** (`create-class`) on a pool, filesystem or object store.
- **Delete if unused…** (`delete-unused`) on a pool, filesystem, object store, user or StorageClass. It is refused
  while StorageClasses or claims are on it.

**Column:** **Ceph** (`ceph-version`) on CephClusters, the version Ceph runs. Phase and Health are Rook's own printer
columns.

## Permissions

It reads, so that it can show them:
- the Rook kinds (CephCluster, CephBlockPool, CephFilesystem, CephObjectStore, CephObjectStoreUser, CephNFS,
  CephClient, CephBlockPoolRadosNamespace, CephFilesystemSubVolumeGroup);
- ObjectBucketClaims and ObjectBuckets;
- Pods (daemons, the operator, the toolbox), PersistentVolumeClaims, StorageClasses, Nodes, Deployments (OSDs and
  daemons) and Jobs (OSD prepare and purge).

It may change, each time after Sextant's confirmation:
- CephClusters, pools, filesystems, object stores and their users;
- StorageClasses;
- Nodes (CRUSH labels);
- Deployments (Rook's daemons and the toolbox);
- Jobs (the purge Job).

It may delete, each time after Sextant's confirmation:
- pools, filesystems, object stores and users;
- StorageClasses;
- Pods, as a restart;
- Jobs, a finished purge Job.

The install screen also lists, word for word:
- its five metric queries;
- its seventeen commands, with where they run and which of them change something.

An update asks for consent again when a version asks for more. 1.1.0 did, with changes and deletes; so does 1.2.0,
with commands and two read kinds.

## Problems

Each rule makes a problem in the category "Rook Ceph" on the Problems page, in notifications and in the section's
counter. Agents get them only when the user lets them (Settings → AI agents (MCP), ADR-0146).

| Rule | Kind | Holds when | After |
|---|---|---|---|
| `health-error` | CephCluster | Ceph reports `HEALTH_ERR` | at once, since `status.ceph.lastChanged` |
| `cluster-failed` | CephCluster | Rook's phase is `Failure` | at once |
| `health-warning` | CephCluster | Ceph reports `HEALTH_WARN` | 15 minutes |
| `health-stale` | CephCluster | Rook last checked Ceph more than 15 minutes ago | at once |
| `pool-not-ready` | CephBlockPool | phase `Failure`, `Progressing` or `Connecting` | 10 minutes |
| `pool-no-status` | CephBlockPool | no phase | 10 minutes |
| `filesystem-not-ready` | CephFilesystem | phase `Failure`, `Progressing` or `Connecting` | 10 minutes |
| `filesystem-no-status` | CephFilesystem | no phase | 10 minutes |
| `object-store-not-ready` | CephObjectStore | phase `Failure`, `Progressing` or `Connecting` | 10 minutes |
| `object-store-no-status` | CephObjectStore | no phase | 10 minutes |
| `osd-prepare-failed` | Job | an OSD prepare Job (`app=rook-ceph-osd-prepare`) has `Failed` | at once |
| `osd-purge-failed` | Job | an OSD purge Job (`app=rook-ceph-purge-osd`) has `Failed` | at once |
| `daemon-unavailable` | Deployment | a Deployment labelled `rook_cluster` has unavailable replicas; not told while its CephCluster has a problem of these rules | 10 minutes |
| `object-user-store-missing` | CephObjectStoreUser | `spec.store` names no CephObjectStore in its namespace (only when `spec.clusterNamespace` is empty) | 2 minutes |
| `subvolume-group-filesystem-missing` | CephFilesystemSubVolumeGroup | `spec.filesystemName` names no CephFilesystem in its namespace | 2 minutes |
| `rados-namespace-pool-missing` | CephBlockPoolRadosNamespace | `spec.blockPoolName` names no CephBlockPool in its namespace | 2 minutes |

A missing object is judged only when every list it needs has been read in full, so a list that is still loading or
cannot be read is never a problem (ADR-0144).

## Metrics

The queries run against the cluster's Prometheus-compatible source, through the API server's service proxy, for the
CephCluster's namespace only (ADR-0138). They read the Ceph mgr's `prometheus` module.

| Query | Reads |
|---|---|
| `health` | Ceph's health: 0 OK, 1 WARN, 2 ERR |
| `capacity` | raw capacity: total and used bytes |
| `osds` | OSDs up, in, and in all |
| `pgs` | placement groups by state |
| `osd-usage` | each OSD: up, in, override weight, size and used bytes |

## Commands

Every command runs in Rook's toolbox (pods labelled `app=rook-ceph-tools`, container `rook-ceph-tools`, in the
CephCluster's namespace), with `ceph` as its program and no shell. The extension sends a command's id and the values
of its parameters, never words of its own (ADR-0147). A command that changes something is confirmed by Sextant every
time it runs, with the words it will run. The journal (Settings → Extensions → Activity) keeps each run's words,
never its output.

| Command | Words | Changes |
|---|---|---|
| `status` | `ceph status` | no |
| `health-detail` | `ceph health detail` | no |
| `osd-tree` | `ceph osd tree` | no |
| `osd-df` | `ceph osd df tree` | no |
| `df` | `ceph df` | no |
| `pg-stat` | `ceph pg stat` | no |
| `versions` | `ceph versions` | no |
| `crash-ls-new` | `ceph crash ls-new` | no |
| `osd-dump` | `ceph osd dump --format json` (read for its flags) | no |
| `osd-ok-to-stop` | `ceph osd ok-to-stop <osd>` | no |
| `osd-safe-to-destroy` | `ceph osd safe-to-destroy <osd>` | no |
| `osd-out` | `ceph osd out <osd>` | yes |
| `osd-in` | `ceph osd in <osd>` | yes |
| `osd-reweight` | `ceph osd reweight <osd> <weight>`, the weight one of `1.0`, `0.95`, `0.9` … `0.1` | yes |
| `osd-set` | `ceph osd set <flag>`, the flag one of `noout`, `norebalance`, `nobackfill`, `norecover`, `noscrub`, `nodeep-scrub` | yes |
| `osd-unset` | `ceph osd unset <flag>`, the same flags | yes |
| `crash-archive-all` | `ceph crash archive-all` | yes |

`<osd>` is a whole number from 0 to 100000.

## Changes it makes

Every change is one of these, and Sextant asks before each is sent.
- **A patch of a Rook object, or of a Node, Deployment or StorageClass.**
  - It is the smallest merge patch, shown first, carrying the `resourceVersion` of the object as it was shown. If
    Rook or someone else changed the object in between, the API server refuses the patch, and the view asks to look
    again.
  - A list is never merge-patched: a device set's `count` and the toolbox's image go as a JSON patch whose `test`
    checks the item first.
- **A new object** (a pool, filesystem, object store, user, StorageClass, the toolbox, a purge Job), shown as YAML
  first.
- **A deletion**: a pool, filesystem, object store, user or StorageClass that nothing uses, a pod to restart it, or
  a finished purge Job.
- **A `ceph` command** of the table above that changes something.

What Rook's documentation warns against is refused:
- **A Ceph upgrade** to an image without a version, an unsupported or older one, or one that skips a major
  release; or while Ceph is `HEALTH_ERR` or runs two versions.
- **Stopping an OSD** that Ceph says is not OK to stop.
- **Removing an OSD:**
  - while its placement groups are seen not active and clean;
  - when Ceph says it is not safe to destroy;
  - when it was not stopped first.
- **Deleting a pool, filesystem or object store** that a StorageClass or claim uses.
- **Setting a node's device class by label** when the CephCluster gives that node one of its own.

Every patch and new object is checked against Rook's CRDs by a server-side dry run (see Development).

## What it does not do

- It runs no `ceph` command outside the table above: no `ceph auth`, no `ceph config set`, no pool or CRUSH
  commands. For those, use Shell on the toolbox pod.
- It does not move CRUSH buckets: Rook places OSDs in CRUSH from Node labels, which the Node tab changes.
- It does not install or upgrade Rook itself, or touch Rook's operator settings.
- It never reads a Secret: keys of object store users and CSI secrets stay where Rook put them.

## Requirements and limits

- Rook's CRDs in the cluster. Without them the page says Rook is not installed and watches nothing of Rook's.
- Rook's toolbox for every command, including the OSD checks. The Ceph status section and the Ceph commands tab
  deploy one from Rook's `deploy/examples/toolbox.yaml` (v1.21.1) on request.
- The Ceph mgr's `prometheus` module and a Prometheus-compatible source that scrapes it, for the Metrics tab, the
  OSD usage and the placement groups check. Without them those parts say so.
- It was checked against Rook v1.21.1's CRDs (every patch and new object) and with recorded Ceph answers. It has not
  been run against a live Rook cluster in CI.

## Troubleshooting

- **"No toolbox runs in this namespace"**: deploy it from Ceph status or the Ceph commands tab, or apply Rook's
  `toolbox.yaml` yourself. The commands then run in its newest ready pod.
- **"Ceph could not be asked whether the OSD is safe to destroy"**: there is no toolbox, or Ceph did not answer in
  30 seconds. Rook's purge Job still refuses an OSD that is not safe.
- **A command ends with an exit code other than 0**: the output shows Ceph's own words. For example, `EBUSY` from
  `ok-to-stop` means placement groups would become unavailable.
- **The flags show as unknown**: the OSD map could not be read. Read them again, or run `ceph osd dump` in the toolbox.
- **No metrics**: the cluster has no Prometheus-compatible source that Sextant finds, or the mgr's `prometheus`
  module is off. See the cluster's settings, Metrics tab.
- **A change is refused with "changed since"**: Rook updated the object after it was shown. Look again and repeat.
- **"denied"**: you declined Sextant's confirmation, or the extension's permissions do not cover it. See Settings →
  Extensions.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/rook-ceph        # → extensions/rook-ceph/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts extensions/rook-ceph
```

- `src/main.ts` picks the view by the frame's context. Each view is a file:
  - `page.ts`, `status.ts`, `daemons.ts`, `osds.ts`, `commandsView.ts`, `metrics.ts`, `storageView.ts`,
    `nodeTopology.ts`, `actions.ts`, `create.ts`;
  - Rook's fields are read in `rook.ts`;
  - every change is built in `changes.ts`;
  - every command is run through `commands.ts`.
- The texts are in `src/locales/<lang>.json` (English is the source) and in the manifest's `translations`.
  `src/locales.test.ts` keeps both complete in every language of Sextant's `src/locales/`.
- The fixtures (`fixtures/objects.json`, from Rook v1.21.1's examples) and every change of `src/changes.ts` are
  checked against Rook's CRDs on the kind test cluster:

  ```sh
  node extensions/rook-ceph/fixtures/dry-run.mjs "$(scripts/test-cluster.sh kubeconfig)"
  ```

- The metric queries are checked by a real Prometheus over synthetic Ceph series. A test keeps
  `fixtures/queries.promtool.json` equal to the manifest's queries.

  ```sh
  docker run --rm -v "$PWD/extensions/rook-ceph/fixtures:/t:ro" --entrypoint promtool \
    quay.io/prometheus/prometheus:v3.15.0 test rules /t/queries.promtool.json
  ```

- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `rook-ceph` and
     the commit.
  3. The catalog's index picks the release up. Older releases of a lower `sextantApi` stay offered to older
     Sextants through `earlier` (ADR-0149).
