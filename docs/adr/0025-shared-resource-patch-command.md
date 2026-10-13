# ADR-0025: GitOps actions go through the shared `resource_patch` command, not a command per action

## Context

Flux and Argo CD need ten actions (`reconcile`, `reconcileWithSource`, `fluxSuspend`, `fluxResume`, `argoSync`, `argoRefresh`, `argoHardRefresh`, `argoTerminate` and others). All boil down to patching an annotation or a field of an object. There was no general command for a merge or JSON patch. The existing actions are tailored to their own kind: `workload_restart` accepts only apps Deployment, StatefulSet, DaemonSet (`ensure_kind`), `cronjob_suspend` only batch/CronJob. The helpers `patch_params()` and `object_api` in `mutate.rs` were not exported. By the established procedure a new command touches the core, `lib.rs`, `src/api/commands.ts`, `src-tauri/tests/commands.rs` and `mockBackend`.

## Decision

Core: `resources::patch(mgr, cluster, &ObjectRef, &Value, PatchType) -> CoreResult<Value>`, `PatchType { Merge, Json }`, field manager `sextant`, the response goes through `to_json`. The command `resource_patch(clusterId, ref, patch, patchType)` runs under `with_timeout(CHANGE_TIMEOUT)` (30 s, ADR-0016); TS `api.resources.patch(clusterId, ref, patch, "merge" | "json")` returns the object. A patch that names `sextant.dev/values-hidden` is rejected with the code `invalid`. Flux and Argo CD use only `"merge"`.

## Why

- This is what the specification says: the feature does not introduce a command per action.
- A command per action was rejected: ten actions are ten sets of edits in five places, and each would have to repeat kind resolution and patch parameters.
- Why `"json"` is in the contract when the build does not use it is not stated in the materials.
- The ban on the `sextant.dev/values-hidden` marker upholds the invariant of ADR-0014: an object with the marker must not be written back.

## Consequences

- Any frontend code can patch any object: the shared command has no per-kind restrictions like those in `workload_restart` and `cronjob_suspend`. The only content check is the ban on the Secret marker. There are no other checks in the materials.
- The response goes through `to_json`, so patching a Secret will not return values to the window (ADR-0014).
- kube errors pass through `kube_error`; a server conflict is `Conflict`. The 30 s expiry does not cancel the patch on the server (ADR-0016): an action shown as an error may have been applied.
- The earlier commands (`workload_restart`, `cronjob_suspend`) remain; moving them to the shared command was not planned in the materials. There are now two paths for changes of the same kind.
- A merge patch replaces lists whole. This applies to `operation.sync.syncOptions` too, which Sync writes itself.
