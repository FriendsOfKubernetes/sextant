# ADR-0037: Pod requests and limits are computed on the frontend from spec, init containers are not summed

## Context

Metrics give only consumption (metrics-server or Prometheus). Requests and limits already lie in the pod's `spec.containers[].resources`, which the window receives through a subscription, but they were shown only as chips per container and were nowhere summed. Quantity parsing exists both in TS (`parseQuantity`) and in the core (`quantity.rs`). The pod's request and limit must be shown next to consumption, including without metrics (stories 16–19).

## Decision

We compute on the frontend from the pod object, only over `spec.containers`. The pod's request is the sum of those set; if it is not set on all containers, "set on N of M containers" is added. The pod's limit is shown only when it is set on every container; otherwise "no limit". Init containers are not summed. The consumption bar goes from the limit if it is complete, otherwise from the request if it is complete. If nothing is set, the row is not shown. Requests and limits are visible even when metrics are unavailable.

## Why

- Computing in the core (Rust) was rejected: the data is already in the pod object in the window, and the computation would require a new command and a new type across the boundary (ts-rs, three registration places). The materials directly name the reason as "computed on the frontend"; the rest is inference.
- Summing init containers was rejected: while the pod is running they do not run (the specification).
- A partial limit as the sum of those set was rejected: the user would read the sum as the pod's ceiling, although one container may have no ceiling; hence "no limit".
- Taking values from metrics only was rejected: with metrics-server or Prometheus unavailable, requests and limits would vanish.

## Consequences

- The number diverges from what the scheduler counts if an init container asks for more than the sum of the regular ones, and it does not account for sidecar containers in `initContainers`. This is a consequence of the rule "only `spec.containers`", checked only against the text of the specification.
- Two places that parse quantities (TS and Rust) have to be kept consistent by hand.
- Showing "set on N of M" and "no limit" makes the block wordier for pods with no explicit values.
- Values are taken from spec at the moment the object is received; what admission substituted (LimitRange) is already in spec, not computed separately.
- Nodes and Deployments are not affected: the calculation is done only for Pod (out of scope).
