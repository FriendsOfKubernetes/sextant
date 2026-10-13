# ADR-0008: Errors reach the UI as a code and the original text, wording comes from translations

## Context

The specification requires errors a human can understand ("server unreachable", "no permissions", "exec plugin not found"), and the UI language must come from translation files (G04).

## Decision

The core returns one error type: a code from a closed set plus the original text. The UI picks the wording by code from the `errors` translation file and shows the original text next to it.

## Why

- Ready-made English phrases from Rust were rejected: they bypass the translation files, and a new language would not cover the errors.
- Passing a raw `kube` error without a code was rejected: the UI would have to parse the text itself, and exec-plugin errors contain secrets.
- The code is needed for UI decisions as well, not only for text: "Reconnect" on `unreachable`, "no permissions" in a table on `forbidden`, a `resourceVersion` conflict on `conflict`.

## Consequences

- The set of codes is part of the contract, and extending it is expensive. The specification lists ten codes, while `interfaces.md` has an eleventh, `kubeconfig` (invalid kubeconfig). The discrepancy remains; `interfaces.md` is the one to trust.
- A code is coarser than the cause. A certificate rejection and an unreachable server both arrive as `unreachable`, and the UI tells them apart by the message text. A websocket upgrade refusal in exec and port-forward (404, 403, 400) is also collapsed into `unreachable`.
- `helm` errors arrive as `other` with the stderr text and are shown in its own words. They are not translated.
- The original error text stays English in any UI language.
- A write without `resourceVersion` is rejected with the code `invalid`: blind overwriting of an object is impossible.
