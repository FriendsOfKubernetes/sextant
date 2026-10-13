# ADR-0023 (D01): The timeout of multi-step operations is set per request, not per operation

## Context

The plan of task 05 assumed that the 30 s `CHANGE_TIMEOUT` wrapper would cover any change operation as a whole, including multi-doc apply and drain. The condition was handed to task 06, the owner of `mutate.rs`.

## Decision

In `resources::drain` and in multi-doc apply, the 30 s limit (`resources::STEP_TIMEOUT`) applies to each individual request inside the operation, and there is no wrapper around the whole operation. On expiry the error names what was done and what was not sent. `eviction_client` got the same `CONNECT_TIMEOUT` as the main client. Single-request actions remain under `CHANGE_TIMEOUT` (ADR-0016).

## Why

- The code showed that a general timeout reports a wrong outcome. A cut-off at the 31st second in the middle of a drain or a set of documents would leave the node cordoned with some pods evicted, and the message "timeout" would say nothing about what was done.
- A general 30 s limit was rejected: draining many pods and applying a large set are legitimately longer, and the limit would turn normal work into an error.
- Leaving it with no limit at all was rejected: this brought back actions hanging for minutes (ADR-0016).

## Consequences

- The total time of drain and multi-doc apply is not limited: in the worst case n requests of 30 s each. There is no cancellation of the operation in the materials.
- Two 30 s constants in two zones (`CHANGE_TIMEOUT` in `commands/actions.rs`, `STEP_TIMEOUT` in the core) are in no way linked, and will have to be changed separately.
- The expiry of an individual request, like any (ADR-0016), does not cancel it on the server: the "done" named in the error may turn out incomplete.
