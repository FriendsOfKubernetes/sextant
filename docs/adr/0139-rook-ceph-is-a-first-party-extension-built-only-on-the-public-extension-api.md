# ADR-0139: Rook Ceph is a first-party extension built only on the public extension API

## Context

Optional, operator-specific views are to move from the core into catalog extensions over time (#320). The first one
is written as an extension from the start: Rook Ceph (#319), once extensions can report problems (ADR-0137) and read
metrics (ADR-0138). It has to prove that an operator view is possible with nothing an outside author lacks.

## Decision

- **A module of Sextant's own, not an example.** The extension lives in `extensions/rook-ceph`, the folder of
  Sextant's own extensions, apart from the SDK's examples. The id is `sextant.rook-ceph`.
  - It is built against the SDK of the same commit.
  - `npm run sdk:check` type-checks, tests, builds and packs (dry run) every folder of `extensions/`.
  - A Rust test (`the_sdk_examples_and_sextants_extensions_have_manifests_sextant_accepts`) has Sextant's own parser
    accept its manifest.

  It is released on its own version from the catalog repository `FriendsOfKubernetes/sextant-extensions`, signed with
  a key of Sextant's own extensions, not the examples' key (#320).
- **Public API only.** No core change was made for it. If a later operator extension needs something the API lacks,
  that becomes an issue and an ADR, not a private hook. Four pieces cover what it needs:
  - the manifest's contributions:
    - a page in Storage;
    - a section and two tabs on CephCluster;
    - a section on pools, filesystems and object stores;
    - a column;
    - ten problem rules;
    - four metric queries;
  - read-only permissions on the Rook and ObjectBucketClaim kinds, Pods, PersistentVolumeClaims and StorageClasses;
  - watches, gets and lists;
  - `ui.openDetails`.
- **Read-only.** It runs no `ceph` command and changes nothing through the operator. Extensions have no exec, so the
  toolbox (`rook-ceph-tools`) is only found and linked: Shell on its pod is Sextant's own.
- **Rook's own words.**
  - **Status fields** are read by the names of Rook's types (`pkg/apis/ceph.rook.io/v1/types.go`, read at v1.21.1).
  - **Pods** are matched by the labels Rook and ceph-csi-operator set:
    - `app` with `rook_cluster`, `ceph-osd-id` and `ceph_daemon_id`;
    - the CSI drivers' `<driver>-nodeplugin` and `-ctrlplugin`, and Rook's older `csi-*plugin` names.
  - **StorageClasses** are matched to pools, filesystems and object stores by the parameters of Rook's examples:
    - RBD: `clusterID` with `pool` or `dataPool` (the Ceph pool's name is `spec.name` when set);
    - CephFS: `clusterID` with `fsName`;
    - buckets: `objectStoreName` with `objectStoreNamespace`.

    A StorageClass set up by hand with another `clusterID` is not matched, and the view says what it matches by.
  - **Health checks** are explained in plain words from Ceph's documentation of them. An unknown code is shown with
    Ceph's own message only.
- **Problems are rules, not code.** The rules:
  - HEALTH_ERR and phase `Failure` at once;
  - HEALTH_WARN after 15 minutes, as a rule of its own so its notifications can be muted separately;
  - a `lastChecked` older than 15 minutes, meaning Rook's operator is not refreshing the status. Its default interval
    is 60 s; the views mark the same status "Stale" after the same 15 minutes, and a test keeps the two equal;
  - pools, filesystems and object stores in `Failure`, `Progressing` or `Connecting`, or without a phase, after 10
    minutes.

  A pool's state has no time of its own, so these count from when Sextant first saw it.
- **Metrics from the Ceph mgr, as Prometheus-compatible queries.** The queries read Ceph health, raw capacity, OSDs up
  and in, and placement groups by state. They use the metric names of Ceph's `mgr/prometheus` module and
  `namespace="<the cluster's namespace>"`, which is the label Prometheus gives the targets of Rook's ServiceMonitor:
  - each query takes the largest value per daemon or pool first, so a second scrape of the mgr counts once;
  - `fixtures/queries.promtool.json` checks the four queries with promtool (Prometheus 3.15) over synthetic series,
    including a duplicate scrape and another cluster's namespace, and a test keeps it equal to the manifest.

  Where the source has no such series, the Metrics tab says so and names the setting that makes Rook export them.
- **Fixtures are checked against Rook's CRDs.** `fixtures/objects.json` is built from Rook's examples.
  `fixtures/dry-run.mjs` creates its Rook objects on the kind test cluster and replaces their status as a server-side
  dry run. Rook declares its statuses with `x-kubernetes-preserve-unknown-fields`, so the API server would keep a
  misspelt field; the script also walks every field against the CRD's schema. A real Rook cluster is not part of CI:
  Ceph needs raw devices and several GB of memory.
- **Every language Sextant has.** Its manifest's texts are translated in `translations` and its pages' texts in
  catalogs `src/locales/<lang>.json` (ADR-0140, #323). A test keeps every catalog equal to English and the manifest
  translated whole into every language of `src/locales/`.

## Consequences

- An outside author can write the same kind of extension. The only things Sextant itself does for Rook Ceph are what
  any extension gets.
- Problems of Rook Ceph form one category named after the extension. Agents never receive them (ADR-0137).
- Rook keeps changing; a new label or field is a change of the extension only, released on its own version.
- A release needs a release workflow and a signing key in the catalog repository, and an entry there.
