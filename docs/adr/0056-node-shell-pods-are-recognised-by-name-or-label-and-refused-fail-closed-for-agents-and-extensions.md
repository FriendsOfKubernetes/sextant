# ADR-0056: Node-shell pods are recognised by name or label, and an agent or extension that touches one is refused, fail closed

## Context

ADR-0045 gave the agent no node shell, and `exec_command` refused a pod that carried the label `sextant.dev/node-shell`. Reading the code showed that the label was the only marker and that a failed read of the pod skipped the check. An agent with Modify on pods in `kube-system` (granted by the ReadWrite and Full presets) could remove the label with a patch or an apply and then run a command in a privileged `hostPID` pod, which is a shell on the node (issue #42). The same hole existed for the new extension API.

## Decision

One function in the core decides whether an object is a node-shell pod: its name starts with `sextant-node-shell-` in `kube-system`, or it carries any of the Sextant node-shell labels. Agents and extensions may not execute in, patch, apply to or delete such a pod, whatever their rules say. If the pod cannot be read, the call is refused (fail closed). The check runs before the access guard, so no confirmation is asked for it.

## Why

- Checking the label only was rejected: it is what an agent can remove.
- Falling back to "privileged and `hostPID`" as a marker was considered in the exploration; the name and labels cover the pods Sextant creates, and a rule based on pod spec would also block a user's own privileged pods.
- Treating a failed read as "not a node shell" was rejected: anything that can make the read fail (a transient error, a Read denied by the cluster) would open the hole.
- Allowing deletion was rejected by the stories: an agent should not change or delete these pods at all. The user's own node-shell window is not affected.

## Consequences

- An agent or an extension cannot clean up a stuck node-shell pod; the user does it.
- A pod in `kube-system` whose name starts with the prefix is refused even if it is not ours.
- A genuine read error blocks a call that would have been harmless; the message says why.
- Port forwards and logs for such a pod were not part of the build (the stories name exec, change and delete).

Amended (v0.6.1): an agent's port forward never reaches a node-shell pod or a pod with `spec.hostNetwork: true` (its ports are the node's own). A Pod target is refused — by name before the access guard, by label or `hostNetwork` from the forwarder's own read of the pod after it; a Service forward skips such pods every time it picks a pod and is refused when they are all the service has (`PodFilter::NoNodeAccess` in `crates/sextant-core/src/portforward.rs`). The user's own forwards are unchanged.
