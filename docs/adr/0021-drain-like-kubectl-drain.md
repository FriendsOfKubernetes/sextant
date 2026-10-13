# ADR-0021: Drain works like `kubectl drain`: preview first, questionable pods only with checkboxes

## Context

Drain cordoned and evicted all of a node's pods except mirror pods, DaemonSet pods and those already being deleted. Pods with no controller, with emptyDir, finished pods and PDBs were deliberately not examined, and there were no warnings or options.

## Decision

Drain goes in two steps. `node_drain_preview(clusterId, name)` returns `DrainPreview { evict, unmanaged, emptyDir, daemonSet }`, and the dialog lists pods with no controller and with emptyDir. `node_drain(clusterId, name, options)` takes `DrainOptions { force, deleteEmptyDirData }`, which are mandatory in IPC. Pods with no controller are evicted only with "force", pods with emptyDir only with "delete emptyDir data"; without the checkboxes such pods are not touched. Stricter than `kubectl`: finished pods (Succeeded, Failed) with no controller or with emptyDir also require the checkboxes. The other pods are evicted, and an `other` error lists the remaining ones with the reason.

## Why

- The old behavior was rejected: a pod with no controller will not be recreated by anyone, and the contents of emptyDir are lost.
- We carry over the semantics of `kubectl drain` because they are familiar to Kubernetes users, and a dialog with the familiar "force" and "delete emptyDir data" checkboxes needs no explanation.
- The preview is needed as a separate step so that a person sees by name what will be lost before pressing the button, not from an error afterwards.
- Evicting the other pods when the checkboxes are lacking differs from `kubectl`, which refuses before starting. The reason is not recorded in the materials; the consequence is described below.

## Consequences

- `node_drain` without `options` is no longer accepted (an IPC change, ADR-0007). All calls and tests were updated.
- A drain that did not get the necessary checkboxes leaves the node with partly evicted pods (as before, it stays cordoned), and the report arrives as an error. The user must read it rather than count on "all or nothing".
- The preview is a snapshot at the moment the dialog is opened; pods that appear later it will not show.
- Strictness toward finished pods is a divergence from `kubectl`, and a user accustomed to it may not expect it.
- Each eviction goes as a separate request under a 30 s per-request limit (ADR-0023); a PDB still answers 429, so the eviction client works without retries (ADR-0016).
