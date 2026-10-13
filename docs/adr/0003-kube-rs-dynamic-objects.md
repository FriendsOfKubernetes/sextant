> Partially superseded by ADR-0015 (discovery takes only the preferred version of a group).

# ADR-0003: The Kubernetes client is kube-rs, resources are dynamic objects, TLS is rustls

## Context

Built-in kinds and arbitrary CRDs are needed in one interface; the build targets three OSes, including cross-building on GitHub Actions.

## Decision

The client is `kube-rs` with `k8s-openapi`. All resources are handled as `DynamicObject` through discovery, by one path for built-in kinds and CRDs. TLS is `rustls`, with no OpenSSL.

## Why

- Typed structures for each kind were rejected: they cannot cover CRDs, and two paths (typed and dynamic) would have to be maintained for the same table and the same details.
- OpenSSL was rejected: `rustls` is simpler for cross-building for three OSes.
- A hand-written client was not considered: the specification names `kube-rs` as the standard Kubernetes client in Rust.

## Consequences

- The compiler does not check object fields. Raw JSON goes to the frontend, and the columns and details per kind are described in the registry on the interface side.
- Discovery takes only the preferred version of a group, and a group that fails is skipped. Objects in non-preferred versions and a wholly inaccessible group are silently invisible.
- Exec plugins work the way `kube-rs` supports them. This is not verified for cloud clusters (out of scope).
- A certificate rejection arrives with the code `unreachable`. The interface tells it apart from "server unreachable" only by the message text, which is fragile (ADR-0008).
- All `kube` errors must go through the single conversion function, otherwise exec-plugin secrets will leak.
