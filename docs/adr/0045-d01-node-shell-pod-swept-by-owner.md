# ADR-0045 (D01): A node shell runs in a temporary privileged pod, and the sweep on connect deletes only its owner's leftovers

## Context

A shell on a node is opened through a privileged pod. The plan assumed that when a cluster is connected the app deletes every leftover node-shell pod in `kube-system` (those with the labels `app.kubernetes.io/managed-by=sextant` and `sextant.dev/node-shell=true`) as forgotten by an earlier run. The review showed the flaw: if a colleague connects to the same cluster, the sweep would delete their live shell.

## Decision

The shell is a pod `sextant-node-shell-<node>-<rand>` in `kube-system` with `hostPID`, `hostNetwork`, `privileged`, `nodeName`, tolerations for every taint, both labels and `activeDeadlineSeconds` of 8 hours as insurance. The terminal is the existing exec into that pod running `nsenter` into the host (bash if available). Before the pod is created a dialog explains that a privileged pod will be created and removed when the shell closes. The pod is deleted when the tab is closed, the cluster is disconnected or the app exits (the session lives in `AppState`; the deletion is started synchronously without blocking the UI). On connect the app deletes pods with both labels that are its own (the label `sextant.dev/owner`, a hash of the user and the machine) from earlier runs, and any such pod older than 8 hours whoever owns it. The agent (MCP) gets no node shell: there is no tool for it.

## Why

- Sweeping every labelled pod on connect was rejected (the plan): it ends another person's shell.
- Leaving cleanup to `activeDeadlineSeconds` alone was rejected: a privileged pod could remain on a node for 8 hours after a crash.
- Never touching other people's pods was rejected: a pod left by a crashed foreign run would stay in `kube-system`. Past 8 hours the pod's own deadline has already ended it, so removing what is left is harmless.
- Giving the agent a node shell was rejected: it would be a privileged pod on a node, reachable by a program; the agent already has `exec_command` limited by rules.

## Consequences

- The owner label does not identify a person, only a user and machine hash; two people using the same account on the same machine share an owner.
- A forgotten pod of a colleague stays up to 8 hours; this is the price of not breaking their session.
- Creating the pod needs permission to create privileged pods in `kube-system`; a missing permission, an image that does not pull in 60 s, or a PodSecurity refusal gives a specific message and removes the pod.
- The image is a setting ("Node shell image", `busybox:stable` by default), so a cluster without access to a public registry needs it changed.
