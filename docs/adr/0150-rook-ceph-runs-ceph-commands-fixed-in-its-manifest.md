# ADR-0150: Rook Ceph runs ceph commands fixed in its manifest

## Context

Rook Ceph 1.1 (ADR-0141) changes Rook only through Rook's own objects and never runs a `ceph` command, because an
extension could not run anything in a container. Marking OSDs out or in, reweighting, the cluster's OSD flags and
archiving crash reports stayed in the toolbox's shell, and the OSD removal could judge only from metrics whether
the placement groups were clean.

Sextant 0.29 lets an extension run commands fixed in its manifest (`contributes.commands`, `sextantApi` 3,
ADR-0147), gives it counters on sidebar sections of its own (ADR-0143) and rules that look across objects
(ADR-0144). The user chose (2026-11-05) that Rook Ceph gets both kinds of commands: those that read («Чтение и
меняющие»), and those that change, each confirmed. The user also chose that its page moves from Storage into a
section of its own with a counter («Свой раздел»).

## Decision

- **Rook Ceph 1.2.0 needs `sextantApi` 3.**
  - An older Sextant keeps 1.1.1, which the catalog offers it through `earlier` (ADR-0149). Sextant 0.26–0.28 do
    not read `earlier`, so for them the catalog says a newer Sextant is needed.
  - A 1.1.1 already installed keeps working (ADR-0142).
- **The commands, word for word in the manifest.** Each runs in Rook's toolbox: label `app=rook-ceph-tools`,
  container `rook-ceph-tools`, from `deploy/examples/toolbox.yaml`, in the CephCluster's namespace. Each is run
  with `ceph` as its program and no shell.
  - **Read:**
    - `ceph status`, `ceph health detail`;
    - `ceph osd tree`, `ceph osd df tree`, `ceph df`, `ceph pg stat`;
    - `ceph versions`, `ceph crash ls-new`;
    - `ceph osd dump --format json`, read only for its flags;
    - `ceph osd ok-to-stop {{osd}}`, `ceph osd safe-to-destroy {{osd}}`.
  - **Change, `changes: true`, so Sextant confirms each run with the filled words:**
    - `ceph osd out {{osd}}`, `ceph osd in {{osd}}`;
    - `ceph osd reweight {{osd}} {{weight}}`;
    - `ceph osd set {{flag}}`, `ceph osd unset {{flag}}`;
    - `ceph crash archive-all`.
  - **Parameters:**
    - `osd` is an `int` from 0 to 100000.
    - `weight` is an `enum` of 13 values from `1.0` down to `0.1`. A free number would need a parameter type Sextant
      does not have; `0` is `out`.
    - `flag` is an `enum` of `noout`, `norebalance`, `nobackfill`, `norecover`, `noscrub`, `nodeep-scrub`. These are
      the maintenance flags of Ceph's own documentation. Flags that stop client I/O (`pause`, `full`) or that only
      Ceph's upgrades set are left out.
  - **No CRUSH move.** `ceph osd crush move` takes `host=<name>` as one word, and a parameter can only be a whole
    word (ADR-0147). Rook places OSDs in CRUSH from Node labels anyway, which the Node tab changes.
- **Ceph's own checks before Rook's steps:**
  - "Stop" on an OSD first asks `ceph osd ok-to-stop`. When Ceph answers no, the OSD is not stopped, and Ceph's words
    are shown. When Ceph cannot be asked (no toolbox, a refusal, a timeout), it is stopped as in 1.1, the way Rook's
    guide stops it.
  - Opening "Remove" asks `ceph osd safe-to-destroy`. When Ceph answers no, the purge Job is not offered. When Ceph
    cannot be asked, the view says so, and Rook's Job, not forced, still refuses an OSD that is not safe.
  - The placement groups' metric stays the first check.
- **Where they are:**
  - **The "Ceph commands" tab of a CephCluster:**
    - the toolbox (the status section's view, with Deploy);
    - a button per reading command, with its output, exit code and pod;
    - the six flags as set, not set or unknown, read from the OSD map, each with Set or Unset;
    - Archive every crash report.
  - **The "CRUSH and OSDs" tab:** "Mark out" or "Mark in" per OSD, by its `in` metric (both when that is not known),
    and Reweight.
  - The page moves to the section `rookCeph`, "Rook Ceph", which gets a counter of every rule (`sectionBadges`).
- **New problem rules (ADR-0144):**
  - an OSD prepare Job (`app=rook-ceph-osd-prepare`) or purge Job (`app=rook-ceph-purge-osd`) with `Failed`;
  - a Deployment labelled `rook_cluster` with unavailable replicas for 10 minutes, `toldThroughOwner`: Rook makes the
    CephCluster its controller, so it is not told while the cluster has a problem of the extension;
  - a reference to an object that is not there, each with a 2-minute grace:
    - a CephObjectStoreUser's `spec.store`, only when `spec.clusterNamespace` is empty (the store may be in that
      namespace otherwise);
    - a CephFilesystemSubVolumeGroup's `spec.filesystemName`;
    - a CephBlockPoolRadosNamespace's `spec.blockPoolName`.

  Rook v1.21.1's CRDs name these fields. The extension reads the two new kinds.
- **What the output is.** Ceph's output is the extension's to show, unfiltered (ADR-0147). These commands print
  status, maps and crash summaries, not keys: `ceph auth` is not among them.

## Consequences

- ADR-0141's "It never runs a `ceph` command" is replaced by this ADR. Its other points stand: changes through
  Rook's objects, the smallest patch against the version shown, refusals of what Rook's documentation warns
  against.
- An update from 1.1.x asks for consent again: there are new commands and two new read kinds (ADR-0147, ADR-0053).
- Everything that runs a command needs the toolbox. Without it the views say so and offer to deploy it.
- The commands are checked by the manifest checks and by tests on recorded Ceph answers, not on a running Ceph
  cluster: CI has none (ADR-0139).
