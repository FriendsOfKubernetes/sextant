# ADR-0112: Restart acts on several objects one at a time and restarts ReplicaSets through their owner or pod by pod

## Context

#255 asked for Restart on a multi-selection, on ReplicaSets (row menu and details), on Argo Rollouts and on Pods. Restart existed only as `kubectl rollout restart` of one Deployment, StatefulSet or DaemonSet (`workload_restart`: the `kubectl.kubernetes.io/restartedAt` template annotation). `kubectl rollout restart` does not support ReplicaSets, a Pod cannot be restarted at all (only deleted and recreated by its controller), and a Rollout has its own field (ADR-0097, amended).

## Decision

- **One action, `restart`, `multiple: true`** (`src/features/restart/`; it replaced the registration in `features/actions`). Each selected object becomes a step (`planRestart`, `model.ts`):
  - Deployment, StatefulSet, DaemonSet: the existing `workload_restart`; a paused Deployment is refused, as `kubectl rollout restart` refuses it.
  - Argo Rollout: `{"spec":{"restartAt":<now>}}` (ADR-0097 amendment).
  - ReplicaSet with a controller Deployment or Rollout: the owner is restarted instead (an old ReplicaSet of a Deployment would only be scaled down again); several ReplicaSets of one owner make one step. The confirmation's title names the owner ("Restart Deployment web?") and the step says why.
  - ReplicaSet without a controller: its pods are deleted one at a time (below).
  - Pod whose controller is a ReplicaSet, StatefulSet, DaemonSet or ReplicationController: deleted with its uid as the precondition, so the controller creates a new one.
  - Not offered: a ReplicaSet of any other owner, a pod without such a controller (bare pods, Job pods — whether the Job makes another depends on its backoff and pod failure policy —, pods of other controllers such as Argo Workflows), static (mirror) pods, Sextant's node-shell pods and debug copies (ADR-0045, ADR-0064; by name and labels, fail closed), and anything already being deleted.
- **One confirmation lists every step** (the first 20, then "…and N more" as one plural sentence) and the patches as they are sent (the template annotation and the Rollout's `restartAt`, with the time as of opening; the time of sending is used). Nothing is sent before "Restart".
- **Sent one at a time, in the listed order.** Each step reads its objects again right before sending and sends nothing when one was replaced (another uid), is being deleted, or changed owner since the list was shown. Each request is sent once (ADR-0055) and is limited by the backend's CHANGE_TIMEOUT. A failed step does not stop the others.
- **Stop, not cancel.** While running, Escape and the backdrop do nothing; "Stop" lets the request in flight finish and starts nothing more (a ReplicaSet's pods stop between two pods). The result lists each object as restarted, not restarted (with the error code's text and the server's message), stopped partway (with "N of M pods restarted") or not started. One object restarted without trouble just closes the dialog, as before.
- **An unowned ReplicaSet's pods** are listed once when the step starts (pods of the ReplicaSet's selector in its namespace whose controller reference is the ReplicaSet's uid, not being deleted, by name) through one watch of the shared registry, released when the step ends. For each pod: read it again (gone or replaced: skipped), delete it with its uid precondition, then wait until the ReplicaSet has as many Ready pods other than the deleted one as it had before the deletion (at most its desired replicas) — a pod that was not Ready is not waited for. A replacement not Ready within 5 minutes (`REPLACEMENT_TIMEOUT_MS`) fails the step and leaves the remaining pods alone. Never two deletions at once.
- **Agents and extensions get nothing new**: no command was added; the action uses `resource_get`, `workload_restart`, `resource_patch` and `resource_delete`, which agents reach only through their existing tools and rules.

## Why

- Selected pods are deleted one after another without waiting for replacements: the user picked those exact pods, as with Delete; the ReplicaSet path waits because it decides on its own which pods go.
- Waiting for "Ready count back" rather than for the ReplicaSet's status: the status lags the deletion, so it would read "all ready" right after the delete; counting from the pod watch excludes the deleted pod at once.
- A dynamic menu label ("Restart Deployment web") was not added: labels are static per action in the registry; the confirmation's title and text name the owner instead.

## Consequences

- A table's multi-selection is of one kind, so "mixed kinds" means mixed steps (an owned and an unowned ReplicaSet, pods of different controllers) in one confirmation.
- A ReplicaSet whose pods never become Ready stops after its first pod; the result says so.
- Closing the window or the cluster during a run leaves the remaining steps unsent; nothing resumes later.
