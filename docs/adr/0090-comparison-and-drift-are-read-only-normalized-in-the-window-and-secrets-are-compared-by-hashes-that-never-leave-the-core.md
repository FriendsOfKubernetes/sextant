# ADR-0090: Comparison and drift are read-only, normalized in the window, and Secrets are compared by hashes that never leave the core

## Context

#156 asked to compare an object across clusters and namespaces (staging against production), two namespaces as a whole, and an object against what was meant to be deployed — its `kubectl.kubernetes.io/last-applied-configuration` or its Helm release's manifest. A raw diff of two live objects is mostly noise (uids, resource versions, status, generated names and hash labels, API-server defaults), and Secrets are exactly the objects users most want to compare and must not see in plain text by accident.

## Decision

- **Read-only, window only, nothing connects implicitly.** Four commands (`compare_list`, `compare_secrets`, `compare_secret_namespaces`, `compare_helm_drift`, `src-tauri/src/commands/compare.rs`) only read; objects themselves are read with `resource_get`. A cluster that is not connected is an error; the window offers it only with a "Connect" button the user clicks. MCP agents and extensions get none of it (`neither_agents_nor_extensions_get_the_comparison`).
- **Where it is offered.** "Compare with…" (`compareWith`, every kind through `extendActionsForAll`) compares an object with another object of its kind in any connected cluster and namespace (names suggested from the palette's `objectIndex`), with its last-applied configuration (only when the annotation exists; always for Secrets), or with its Helm release's manifest (only when the object carries `meta.helm.sh/release-name`/`-namespace`). The "Compare namespaces" page (Cluster section) compares two (cluster, namespace) sides over a fixed list of common namespaced kinds into only-left / only-right / different / same; it runs once per click and opens no watch.
- **Normalized in the window.** `src/features/compare/normalize.ts` always drops `status`, server-written metadata, generated name suffixes, controller hash labels, noise annotations and a Secret's `data`; "Hide defaults" (off by default) also drops API-server defaults while they still hold the default value and cluster-assigned fields. The user's ignore paths are applied last: per kind (`group/Kind`), JSON-pointer-like with `*` for one key or item, saved in `AppSettings.compare.ignorePaths` (frontend-written, read leniently with caps by `settings/compare.rs`).
- **Drift counts only what the desired side sets.** Against a last-applied configuration or a Helm manifest, fields the API server or controllers added are not drift (`driftChanges`, `model.ts`). The Helm drift (`compare_helm_drift`) takes the latest readable revision's manifest as the release details decode it, cuts it into objects (unreadable documents counted) and reads each live copy (≤ 300 objects).
- **Bounded lists.** `compare_list` returns at most 40 namespaced kinds × 500 objects per side, without `status`, with an error per kind instead of failing the run.
- **Secrets by hashes inside the core.** `compare_secrets` and `compare_secret_namespaces` read the values in the core, hash each one with SHA-256 per request, and return only key names with "on left", "on right" and "equal"; neither values nor hashes leave the core, and the hashes are discarded after the comparison. A Secret's last-applied values and a Helm manifest's Secret are compared the same way. A value is shown only after "Show values" on one key, through the existing `secret_value` of a live Secret.

## Why

- Comparing in the core with the cluster's own server-side apply semantics was rejected: the window already has the objects' JSON, the rollouts' `TemplateDiff`, and ignore paths the user edits live; the core is used only for what must not reach the window (Secret values) and for bounded multi-object reads.
- Sending hashes to the window was rejected: the hash of a short value (a port, a flag, a short password) is as good as the value.
- Connecting a cluster for a comparison was rejected: connecting may run an exec plugin or a cloud login, which only the user starts.

## Consequences

- A comparison is a snapshot; it does not follow changes.
- Kinds outside the namespace page's fixed list are compared object by object only.
- An ignore path that matches nothing is harmless; one that matches too much can hide real differences, so the paths are shown next to every result.
