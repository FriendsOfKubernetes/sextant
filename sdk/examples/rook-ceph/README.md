# Rook Ceph

A read-only view of [Rook](https://rook.io) Ceph clusters for Sextant, written only with the public extension API.
It is also the reference example of an operator extension. Why it is built this way: ADR-0139.

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

It runs no `ceph` commands and changes nothing. For commands, open the toolbox pod (`rook-ceph-tools`, linked in
**Ceph status**) and use Sextant's Shell.

## Permissions

The extension only reads:
- the Rook kinds;
- ObjectBucketClaims and ObjectBuckets;
- Pods, PersistentVolumeClaims and StorageClasses.

The install screen shows its four metric queries word for word.

## Developing

From the Sextant repository:

```sh
npm run sdk:build -- sdk/examples/rook-ceph        # → sdk/examples/rook-ceph/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts sdk/examples/rook-ceph
```

The fixtures (`fixtures/objects.json`, from Rook v1.21.1's examples) are checked against Rook's CRDs on the kind test
cluster:

```sh
node sdk/examples/rook-ceph/fixtures/dry-run.mjs "$(scripts/test-cluster.sh kubeconfig)"
```

The metric queries are checked by a real Prometheus over synthetic Ceph series. A test keeps
`fixtures/queries.promtool.json` equal to the manifest's queries.

```sh
docker run --rm -v "$PWD/sdk/examples/rook-ceph/fixtures:/t:ro" --entrypoint promtool \
  quay.io/prometheus/prometheus:v3.15.0 test rules /t/queries.promtool.json
```
