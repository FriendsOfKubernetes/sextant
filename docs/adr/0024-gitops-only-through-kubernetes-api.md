# ADR-0024: Flux and Argo CD are read and managed only through the Kubernetes API, without their CLIs

## Context

Flux and Argo CD run in the clusters of the user and the team. The state of their objects must be visible, and actions must be possible: reconcile, suspend/resume, sync, refresh, terminate. Both tools have their own CLIs (`flux`, `argocd`). For Helm a different scheme was chosen: reading is native, changes are made by the installed `helm` (ADR-0005).

## Decision

Flux and Argo CD objects are read as ordinary Custom Resources, and actions are performed by patching the same objects through the shared command (ADR-0025): the annotation `reconcile.fluxcd.io/requestedAt`, `spec.suspend`, the `operation` field of an Application, the annotation `argocd.argoproj.io/refresh`, the `Terminating` phase of an operation. The `flux` and `argocd` binaries are not called and are not needed on the machine. The only place where Sextant talks to Argo CD itself is login and the "desired ↔ live" diff through its HTTP API (ADR-0027, ADR-0028). Everything else, including Argo CD actions, goes through the Kubernetes API.

## Why

- This is what the specification says: it works with the user's permissions, nothing is needed on the machine.
- Calling a CLI was rejected for the same reason: a binary in PATH and its own cluster access settings would be needed. For Helm a similar dependency was accepted (ADR-0005), because the templating engine cannot be rewritten; for Flux and Argo CD the actions boil down to writing fields into an object, and there is no reason to call a CLI.
- Why the diff still goes through the Argo CD API rather than the Kubernetes API is not stated directly in the materials; it only says that the data is taken by the managed-resources request (`targetState` / `liveState`).

## Consequences

- All actions require the user's permission to patch these objects. There is no permission check in advance: a refusal arrives as a Kubernetes error.
- An action is a request to a controller: Sextant records the intent (an annotation, `operation`), and the controller in the cluster carries it out. If there is no controller or it is not working, the object will change but the action will not happen.
- "Reconcile with source" for Kustomization and HelmRelease is a sequence of patches (the source first, then the object), not one atomic action.
- Verified on kind with Flux v2.9.6 and Argo CD v3.5.5. Other versions were not verified in the materials. On the user's cluster (read only) actions were not run; there is no Argo CD there.
- The patch format (the structure of `operation`, annotation names) is known to the frontend (`src/features/argocd`, `src/features/flux`), not to the core. A format change in Argo CD or Flux means editing the frontend.

> Amended (v0.7.0): Sextant can now install Flux and Argo CD into a connected cluster that lacks them, from their official `install.yaml` through the Kubernetes API, on the user's click only (ADR-0058, #81). Reading and actions are unchanged: still no `flux`/`argocd` CLI.
