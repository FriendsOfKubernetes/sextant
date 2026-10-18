# ADR-0075: Upgrade readiness reads facts in the core and judges them against a deprecation table in the repository

## Context

Before a Kubernetes upgrade the question is "what will break" (#142): manifests, Helm charts and GitOps sources that still use an API version the target release no longer serves, and nodes or control-plane components whose versions the skew policy will not allow. Tools such as Pluto or kube-no-trouble answer part of it from the command line, each with its own table and its own idea of where objects come from. An object stored by the API server always comes back in the version asked for, so "which version did this come from" has to be read from traces the clients left: `last-applied-configuration`, `managedFields[].apiVersion`, Helm's stored manifests, GitOps inventories.

## Decision

- **The table of deprecations is data in the repository**, `src/features/upgrade/deprecations.json` (group, version, kind, `deprecatedIn`, `removedIn`, `replacement`, an optional `note`), copied from the Kubernetes Deprecated API Migration Guide, with `reviewedFor` naming the last release checked. It is never fetched at run time. It must be reviewed for **every Kubernetes minor release** by the steps in `src/features/upgrade/DEPRECATIONS.md`; `table.test.ts` checks its fields, order, duplicates and notes. Only APIs served by default belong there.
- **The core reports facts, the frontend judges.** The frontend sends the group/version/kinds of the table to one read-only window command, `upgrade_scan` (`crates/sextant-core/src/upgrade.rs`, ≤ 256 API versions). It reads: `/version`; which of those versions the cluster still serves (`/api`, `/apis` and each group version's resource list, since discovery keeps only the preferred version); metadata-only lists of those kinds (≤ 2000 objects each) and their last-applied and field-manager versions; the latest revision of each Helm release (≤ 300 releases, ≤ 500 namespaces when Secrets cannot be listed cluster-wide, each release Secret decoded once and refused past 32 MiB unpacked — `helm::MAX_RELEASE_BYTES`, a gzip-bomb bound — and only apiVersion, kind, name and namespace leave the core); Argo CD `status.resources[]` and Flux Kustomization `status.inventory.entries[]` (≤ 1000 each, no Git access); nodes' kubelet and kube-proxy versions and kubeadm-style control-plane pods (`tier=control-plane` in `kube-system`). Every request is under `STEP_TIMEOUT`; a source that cannot be read or is not installed is reported in `sources` and does not fail the scan; at most 5000 usages are returned. The frontend (`evaluate.ts`, `skew.ts`) evaluates them for a chosen target version (default: the next minor), so changing the target or the filters asks the cluster nothing again.
- **Skew follows the published policy** (`skew.ts`): the control plane moves one minor at a time; kube-apiserver instances are at most one minor apart; kubelet and kube-proxy are never newer than kube-apiserver and at most three minors older (two before 1.25), kube-proxy within the same distance of its kubelet; controller-manager, scheduler and cloud-controller-manager never newer and at most one minor older. A managed control plane shows no components, and then only the node rules are checked — the page says so.
- **A trace is not a breakage.** A version found only in a live object's last-applied or field-manager entry that the cluster no longer serves is an old write, hidden unless "Show traces of old writes" is on.
- **Window only.** Neither agents nor extensions get `upgrade_scan`; nothing is written to the cluster.

## Why

- Shipping or running Pluto / kube-no-trouble was rejected: another binary, another table to trust, and neither reads Helm releases, Argo CD and Flux inventories and skew together through the user's own connection.
- Fetching the table from the network was rejected: Sextant downloads only from fixed, allow-listed sources (`src-tauri/src/download.rs`), a run-time table would change the answer without a release, and the page must work offline and on air-gapped clusters. The cost — a manual review each release — is written down and tested.
- Judging in the core was rejected: the target and the filters change in the window, and the rules are small, pure and easy to test in TypeScript; the core keeps what needs the cluster or the Helm decoding.
- Reading whole Helm manifests in the frontend was rejected: they can contain Secret values; the core keeps only the four identifying fields.

## Consequences

- The page sees stored objects and manifests, not clients that call deprecated APIs at run time; it points to the API server's `apiserver_requested_deprecated_apis` metric for those.
- A stale table under-reports: if `reviewedFor` lags the cluster, removals of newer releases are not known. The page shows the version the table covers.
- On very large clusters the caps leave objects unchecked; each truncated source says so.
- Tests: `crates/sextant-core/src/upgrade/tests.rs` (fake API server), `crates/sextant-core/tests/upgrade.rs` (kind), `src/features/upgrade/*.test.ts(x)`.
