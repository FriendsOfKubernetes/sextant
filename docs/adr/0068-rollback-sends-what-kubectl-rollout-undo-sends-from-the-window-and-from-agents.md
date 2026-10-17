# ADR-0068: A rollback sends what `kubectl rollout undo` sends, from the window and from agents

## Context

Deployments, StatefulSets and DaemonSets keep their history in ReplicaSets and ControllerRevisions, and a bad rollout is undone with `kubectl rollout undo` (#134). Users want to see the revisions, compare two pod templates and go back with one click; agents (MCP) were asked to roll back too. There is no rollback endpoint in the API: kubectl builds a patch on the client, and the details (which annotations to keep, the `pod-template-hash` label, paused Deployments) decide whether the result matches what operators expect.

## Decision

- **The same patch as kubectl.** A Deployment gets `spec.template` replaced with the ReplicaSet's template without `pod-template-hash`, and `metadata.annotations` replaced with the ReplicaSet's, keeping the Deployment's own revision bookkeeping and last-applied annotation (kubectl's `annotationsToSkip`). A StatefulSet or DaemonSet gets the template stored in the ControllerRevision. Only ReplicaSets and ControllerRevisions the workload controls (`ownerReferences` with `controller: true` and its uid) are revisions. A paused Deployment is refused; a revision that already matches the live template changes nothing.
- **The window computes it in the frontend** (`src/features/rollouts/model.ts`) from the watched revisions, shows the current template and the chosen revision side by side in the confirmation, and sends it as a JSON patch through `resource_patch`. The History tab also shows the rollout status, change causes and images.
- **Agents get `rollout_undo`** (`toRevision`, or the previous revision), computed in the core (`crates/sextant-core/src/resources/rollouts.rs`), under the existing Modify permission on the kind, with `Guard::check` right before the patch, so "Ask before running" applies.

## Why

- A new Tauri command for the window was rejected: the History tab already watches the revisions and must show the diff before anything is sent, and `resource_patch` already carries the field manager, timeout and error handling of every change.
- Only the frontend implementation was rejected: an MCP tool runs in Rust without a window.
- A new action (for example "Rollback") in the agent access model was rejected: a rollback is a change of the workload's spec, the same thing Modify already allows through `patch_resource`; a separate action would add a rule everyone has to learn without narrowing anything.
- A rollback that also restores replicas or other fields was rejected: kubectl does not, and an operator who knows `rollout undo` would be surprised.

## Consequences

- The rule exists twice, in TypeScript and in Rust; both are tested against the same cases (`model.test.ts`, `crates/sextant-core/tests/rollouts.rs`), and a change to one has to be made in the other.
- A revision whose ReplicaSet or ControllerRevision was pruned (`revisionHistoryLimit`) cannot be rolled back to; it is not listed.
- A rollback is an ordinary update: the controller creates a new revision number for the old template, as with kubectl.
