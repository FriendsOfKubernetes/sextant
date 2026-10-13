# ADR-0030: A kind from discovery is read in the preferred version if the cluster does not serve the requested one

## Context

The Flux and Argo CD CRDs are served in different API versions in different clusters (story 3: "the API versions that the cluster serves are supported"). Discovery stores one version per kind — the preferred one (ADR-0015 left open which exactly). The window's kind registry keys a kind by `group/Kind` without a version, and `KindView` for a registered kind takes the version from `registered.kind.version` without waiting for discovery. Before this build, a kind unknown to the cluster gave `NotFound: the cluster does not serve …`; `notes.md` at the same time says that on a version mismatch the core already takes any served version. Whether this behavior was new, the materials do not separate.

## Decision

`resolve_kind` (`get.rs`): the requested version is taken if discovery provides it; otherwise the version from discovery is used, and the object arrives with that `apiVersion`. Built-in kinds do not change. A kind that is served but not preferred is read in the preferred version. Flux kinds are registered in the registry with the preferred version from discovery. `replace_yaml` and `apply_yaml` go to the URL of the version from the document (`resolve_document_kind`, `pub(crate)` in `get.rs`) if the group serves that version; otherwise `notFound` without a request. The fallback to the version from discovery applies only to get, watch and patch by `ObjectRef`.

## Why

- A rigid version from the registry (a `NotFound` error if the cluster does not serve it) was rejected: the condition of story 3 is to work with the versions that the cluster serves.
- Discovery still keeps one entry per `(group, kind)` (ADR-0015); the core picks the second version on access. Keeping all versions in discovery was not discussed in the materials.
- For `apply` and `replace` the fallback was rejected: the request body carries the document's `apiVersion`, and with a different version in the URL the API server refuses. Example: a HelmRelease in `v2beta2` when `v2` is preferred.

## Consequences

- The frontend may receive an object in a different `apiVersion` than it registered. Columns and details (`status.artifact.revision`, `status.lastAppliedRevision`, `status.inventory`) are designed for fields that exist in that version; whether fields match between versions was not checked in the materials.
- Action patches write the annotation and `spec.suspend` into the object of the preferred version; whether these fields look the same in older versions was not checked.
- A document in a version that the group does not serve is rejected at once, before a request to the server: the `notFound` error is visible without a network call.
- The registry does not distinguish versions (the key is `group/Kind`): two versions of the same kind cannot be registered in it.
