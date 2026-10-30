# Rook Ceph

A view and a control panel of [Rook](https://rook.io) Ceph clusters: one of Sextant's own extensions, installed from
the catalog and written only with the public extension API, in every language Sextant has. Why it is built this way:
ADR-0139 (the module), ADR-0140 (its translations) and ADR-0141 (what it may change).

## What it adds

**Rook Ceph page (Storage section).**
- Every CephCluster: Ceph's health, the first health checks, capacity, and when Rook last checked. The status is
  marked stale after 15 minutes without a refresh.
- Pools, filesystems and object stores with their phases and the StorageClasses on them.
- The other Rook objects.
- The StorageClasses on Ceph, with how many claims use each.

**CephCluster details.**
- **Ceph status:** each health check in plain words, capacity, versions (and a mixed-version warning), and the
  toolbox pod.
- **Daemons tab:**
  - the operator, monitors, managers, OSDs (by node), MDS, RGW, NFS, mirroring, exporters and the CSI drivers;
  - for each pod, whether it is ready and how often it restarted.
- **Metrics tab:** health, raw capacity, OSDs up and in, and placement groups by state, from the Ceph mgr's metrics
  in the cluster's Prometheus-compatible source.

**CephBlockPool, CephFilesystem, CephObjectStore details.** The StorageClasses on it, and the PersistentVolumeClaims
or ObjectBucketClaims that use them.

**Columns.** The Ceph version on CephClusters. Phase and Health are Rook's own printer columns.

**Problems.**
- Ceph HEALTH_ERR, Rook's phase `Failure`, HEALTH_WARN (after 15 minutes), and a status not refreshed for 15
  minutes;
- pools, filesystems and object stores not ready, or without a status, for 10 minutes.

## Managing Rook (1.1.0)

Every change is shown first, as the exact patch or YAML, and Sextant asks before it is sent. A change is made against
the version of the object that was shown: if Rook or someone else changed it in between, it is refused and the view
asks to look again.

**Ceph status.**
- Mute or unmute a health check (Rook's `muteHealthWarning`, at most 10).
- Pause or resume Rook's reconciling of the cluster (`ceph.rook.io/do-not-reconcile`).
- Deploy Rook's toolbox when there is none, or bring its image to the cluster's Ceph image.

**Daemons tab.** Restart a daemon by deleting its pod, when its controller re-creates it.

**CRUSH and OSDs tab.**
- The CRUSH tree from Rook's labels on the OSD Deployments, with each OSD's state, usage and reweight.
- Per OSD:
  - replace its disk (Rook's `osd.rook.io/replace`);
  - stop or start it;
  - pause or resume its reconciling;
  - once it is stopped, remove it with Rook's purge Job. This is offered only after the placement groups are seen
    active and clean.
- The cluster's storage switches (`useAllNodes`, `useAllDevices`, `deviceFilter`, the device class and CRUSH weight
  updates, removing OSDs that are out and safe to remove) and the `count` of each device set.

**Node details, "Rook Ceph" tab.** The CRUSH location labels Rook reads (`topology.kubernetes.io/region|zone`,
`topology.rook.io/<level>`) and the node's device class.

**Actions.**
- **Upgrade Ceph…** on a CephCluster. The image is checked against the Ceph versions Rook v1.21.1 supports, the
  cluster's health and the versions it runs.
- **Pool settings…**: replica count, quotas, failure domain, device class, CRUSH root.
- **Metadata servers…** on a filesystem: active MDS count and standby-replay.
- **Object gateways…** on an object store: the number of RGW instances.
- **Create StorageClass…** on a pool, filesystem or object store.
- **Delete if unused…** on a pool, filesystem, object store, user or StorageClass, refused while StorageClasses
  or claims are on it.

**Rook Ceph page, "Create".** A pool, filesystem, object store or user, optionally with a StorageClass on it,
written as Rook's examples write them.

It never runs a `ceph` command. CRUSH moves, reweights and marking OSDs out or in are done in the toolbox pod
(`rook-ceph-tools`, linked in **Ceph status**) with Sextant's Shell.

## Permissions

The extension reads:
- the Rook kinds;
- ObjectBucketClaims and ObjectBuckets;
- Pods, PersistentVolumeClaims, StorageClasses, Nodes, Deployments and Jobs.

It may change, each time after Sextant's confirmation:
- CephClusters, pools, filesystems, object stores and their users;
- StorageClasses, Nodes (labels), Deployments (Rook's daemons and the toolbox) and Jobs (the purge Job).

It may delete, each time after Sextant's confirmation:
- pools, filesystems, object stores and users;
- StorageClasses;
- Pods (a restart);
- Jobs (a finished purge Job).

The install screen shows its five metric queries word for word. Updating from 1.0.0 asks for consent again, because
1.1.0 asks for more.

## Developing

From the Sextant repository:

```sh
npm run sdk:build -- extensions/rook-ceph        # → extensions/rook-ceph/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts extensions/rook-ceph
```

The texts are in `src/locales/<lang>.json` (English is the source) and in the manifest's `translations`;
`src/locales.test.ts` keeps both complete in every language of Sextant's `src/locales/`.

The fixtures (`fixtures/objects.json`, from Rook v1.21.1's examples) and every change of `src/changes.ts` are checked
against Rook's CRDs on the kind test cluster:

```sh
node extensions/rook-ceph/fixtures/dry-run.mjs "$(scripts/test-cluster.sh kubeconfig)"
```

The metric queries are checked by a real Prometheus over synthetic Ceph series. A test keeps
`fixtures/queries.promtool.json` equal to the manifest's queries.

```sh
docker run --rm -v "$PWD/extensions/rook-ceph/fixtures:/t:ro" --entrypoint promtool \
  quay.io/prometheus/prometheus:v3.15.0 test rules /t/queries.promtool.json
```
