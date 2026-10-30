# ADR-0141: Rook Ceph manages Rook only through Rook's own objects

## Context

Rook Ceph 1.0.0 was read-only (ADR-0139). Issue #327 asks it to manage Rook as well:
- object settings;
- creating and deleting objects;
- operations on daemons and the toolbox;
- Ceph upgrades;
- the CRUSH map and OSDs.

An extension has no exec, so it cannot run `ceph` commands. It can only get, list, watch, patch (merge or JSON),
apply and delete through the extension API. Every call is checked by the extension guard in Rust against its grant.
Rook itself is driven by its custom resources, by a few labels and annotations it documents, and by Jobs from its
examples.

## Decision

- **Only Rook's own interface.** The extension changes nothing Rook does not read itself:
  - the documented fields of CephCluster, CephBlockPool, CephFilesystem and CephObjectStore, read at Rook v1.21.1;
  - Rook's labels and annotations:
    - `ceph.rook.io/do-not-reconcile` on a CephCluster or a daemon's Deployment;
    - `osd.rook.io/replace` on an OSD's Deployment;
  - the Node labels Rook reads for CRUSH: `topology.kubernetes.io/region|zone`, `topology.rook.io/<level>` and
    `osd.rook.io/device-class`;
  - objects written after Rook's examples:
    - pools, filesystems, object stores and their users;
    - StorageClasses on them;
    - the toolbox from `deploy/examples/toolbox.yaml`, vendored at v1.21.1 with only its namespace and image replaced;
    - the purge Job from `osd-purge.yaml`.

  It never runs a `ceph` command. CRUSH moves, reweights and marking an OSD out or in stay in the toolbox, and the
  view says so.
- **The smallest change, against the object that was shown.**
  - A merge patch names only the fields it changes and carries the `metadata.resourceVersion` the form was built
    from. If the object changed in between, the API server answers with a conflict, and the view says to look again.
  - A list is never merge-patched: a merge patch replaces the whole list. These go as a JSON patch whose `test`
    operation checks the item's name first:
    - a device set's `count`;
    - the toolbox container's `image`.
  - Every change is shown before it is sent, as the exact patch or YAML.
- **Sextant asks before every change.** The manifest asks for:
  - **read** on the Rook kinds, ObjectBucketClaims and ObjectBuckets, Pods, PersistentVolumeClaims, StorageClasses,
    Nodes, Deployments and Jobs;
  - **modify**, with confirmation, on CephCluster, CephBlockPool, CephFilesystem, CephObjectStore,
    CephObjectStoreUser, StorageClass, Node, Deployment and Job;
  - **delete**, with confirmation, on the pool, filesystem, object store and user kinds, StorageClasses, Pods and
    Jobs.

  Being an update that asks for more than 1.0.0, it needs consent again (ADR-0050, ADR-0053, ADR-0130). Every call is
  journaled in `extensions-audit.jsonl`. Agents never reach it.
- **Refuse what Rook's documentation warns against.**
  - **Ceph upgrade.** The image is checked against the Ceph versions Rook v1.21.1 supports: Squid from 19.2.0 and
    Tentacle from 20.2.1 (20.2.0 is not recommended). Each check either blocks the upgrade or only warns.
    - It is blocked by:
      - an image without a version;
      - an unsupported or too old version;
      - the same version, or a downgrade;
      - skipping a major release;
      - HEALTH_ERR, on which Rook refuses to upgrade;
      - daemons already running two versions.
    - It only warns about:
      - another registry than Rook's examples use;
      - a tag naming only the major version, which floats to that release's newest image;
      - HEALTH_WARN.
  - **OSD removal**, in the order of Rook's guide:
    1. Stop the OSD: its Deployment gets 0 replicas and `do-not-reconcile`.
    2. Check that every placement group is active and clean. The `pgs` metric query tells this; when it cannot be
       told, the view says so.
    3. Run Rook's purge Job for that one OSD with the operator's own image and `--force-osd-removal false`.

    An OSD on a PVC is removed through its device set's `count`.
  - **Replacing a disk** uses Rook's annotation. It is not offered for OSDs on PVCs, which Rook does not replace this
    way.
  - **Deleting an unused pool, filesystem or object store.** Delete is refused while a StorageClass or claim is on the
    object, and Rook's own `*DeletionIsBlocked` conditions are shown.
  - **A node's device class** is not set by label when a CephCluster gives that node its own `deviceClass`: Rook
    would skip the label.
  - **Muting a health check** uses `healthCheck.muteHealthWarning`, within Rook's limit of 10 codes.
  - **Restarting a daemon** deletes only a pod whose controller (a ReplicaSet, DaemonSet or StatefulSet) re-creates
    it.
- **Every change is checked against Rook's CRDs.** `fixtures/dry-run.mjs` loads `src/changes.ts` (Node's type
  stripping, no build). On the kind test cluster it sends each patch and each new object as a server-side dry run:
  - against the fixtures;
  - against a second CephCluster that has a device set;
  - against a Node;
  - against a Deployment shaped like Rook's, created with no replicas.

  It also checks two refusals and one result:
  - a device-set patch naming another set is refused;
  - an OSD patch on an out-of-date version is a conflict;
  - the toolbox's image patch keeps the container's command and mounts.

## Consequences

- Rook Ceph 1.1.0 is no longer read-only. ADR-0139's "Read-only" point is replaced by this ADR. Its other points
  (public API only, Rook's own words, problems as rules, metrics as fixed queries, every language) stand.
- What the extension can change is bounded by Rook's own interface, and each change is visible before it is sent.
  Anything deeper is the toolbox's job.
- A new Rook field, label or supported Ceph version changes `src/changes.ts` or `src/upgrade.ts`, with a dry-run
  case, and ships as a new extension version.
- A real Rook cluster is still not part of CI (ADR-0139). The changes are checked against Rook's schema, not against
  a running operator.
