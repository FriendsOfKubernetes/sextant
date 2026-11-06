# ADR-0155: Extensions patch the status of custom kinds the user granted

## Context

Argo Rollouts' promote, abort and retry send part of `kubectl argo rollouts`' patches to the Rollout's status
subresource (ADR-0097). Sextant does that through the window-only `resource_patch_status`, and a test kept it away
from extensions. So these actions could not move into an extension (#347).

## Decision

- **`permissions.statusPatches` (`sextantApi` 4)** lists kinds whose status the extension may patch, at most 20.
  - Only custom resources: an API group with a dot that is neither `k8s.io` nor ends in `.k8s.io` or
    `.kubernetes.io`, and no wildcard. Each kind is listed once.
  - The kinds are part of the permissions, so a new kind needs consent again (`is_within`). The consent screen names
    them.
- **`resources.patch` gains `subresource: "status"`.** It is decided as Modify on the object, with the usual
  confirmation, journal (`status of <object>`) and refusals (`sextant.dev/values-hidden`, node-shell pods).
  - The kind must be among the granted `statusPatches`; anything else is denied.
  - Any other `subresource` value is invalid.
- **The core** sends it through `resources::patch_custom_status`, which refuses a non-custom group before any request.
  The window's `patch_status` and its `STATUS_PATCH_KINDS` are unchanged.
- No new method name: the test that keeps `patch_status` out of the extension methods stands, with a note.

## Consequences

- Argo Rollouts' actions can be an extension's, sending exactly the plugin's patches.
- Kubernetes' own kinds' status, such as a Pod's or a Node's, stays out of every extension's reach.
