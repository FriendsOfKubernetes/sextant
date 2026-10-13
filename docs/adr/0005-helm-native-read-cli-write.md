# ADR-0005: Helm — releases are read natively, changes are made by the installed `helm`

## Context

Viewing releases, rollback, upgrade and chart installation are needed. The user agreed to the scheme "viewing without helm, changes with helm"; some users have Helm 3, the developer has Helm 4.

## Decision

Releases are read from the cluster natively: the `sh.helm.release.v1.*` Secret is decoded as base64, then gzip, then JSON. Any change (upgrade, rollback, uninstall, install, repositories, search, default values) is performed by calling the installed `helm` with `--kube-context` and `--kubeconfig`.

## Why

- Rewriting the Helm templating engine in Rust is unrealistic, so changes are delegated to the binary.
- Reading is still done natively rather than through `helm`: without the binary in PATH, viewing releases must work, while the action buttons are disabled with a hint (R16i.3).
- Bundling our own copy of `helm` into the installer was not considered in the materials.

## Consequences

- For changes the user must have `helm` installed. It is looked up in PATH, and the path can be set in Settings.
- The storage format lives in someone else's system. Helm 4.3 was verified on a live cluster, Helm 3 only by unit tests.
- Parsing covers storage in Secrets. Releases written by another storage driver will apparently not be seen by the core. This follows from the way of reading, not from a check.
- Reading releases depends on permissions on Secrets: without them the Helm list will be empty or will fail.
- `helm` calls are isolated: variables that redirect the cluster (`HELM_KUBE*`, `KUBECONFIG` and others) are scrubbed, and values are passed through a temporary file. A `helm` error is shown in its own words.
- For a chart with dependencies, an upgrade needs a reference to the repository, not only the chart name from the release.
