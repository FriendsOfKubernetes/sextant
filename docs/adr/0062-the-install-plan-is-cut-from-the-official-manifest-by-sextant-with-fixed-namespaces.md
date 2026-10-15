# ADR-0062: The install plan is cut from the official manifest by Sextant, with fixed namespaces

## Context

ADR-0058 installs Flux and Argo CD from the projects' own `install.yaml`. The files do not match what the user asked for as they are: Flux's file contains the image automation controllers and the source watcher, which `flux install` does not install by default; Argo CD's file is meant for `kubectl apply -n argocd` and has no Namespace and mostly no `metadata.namespace`, while Sextant applies a namespaced object without one into the kubeconfig context's default namespace.

## Decision

The core turns the downloaded text into a plan (`prepare`, no network):

- **Flux** is installed as `flux install` does by default: the documents of `image-reflector-controller`, `image-automation-controller` and `source-watcher` (Deployment, RBAC, CRDs of their groups) are removed; source, kustomize, helm and notification controllers stay. The namespace is `flux-system`.
- **Argo CD** is installed into `argocd`: a `Namespace argocd` is put first and `metadata.namespace: argocd` is set on every namespaced document that has none. The standard cluster-wide, UI, non-HA file is used. Whether a kind is namespaced comes from a fixed list of cluster-scoped kinds; every other kind is treated as namespaced.
- **Only known kinds.** A manifest with a kind outside an allow-list of those the official files use, or with the hidden-values marker, is refused as a whole.
- **The namespace is not chosen by the user.** Order: Namespace, CRDs, a discovery refresh, then the rest in file order.

## Why

- Applying the file untouched was rejected: it would add controllers and CRDs the user did not ask for (Flux), and put Argo CD's objects into whatever namespace the context happens to default to, possibly `default`.
- A namespace chosen by the user was rejected: the official RBAC refers to `flux-system` and `argocd`, and the rest of Sextant (installation lookup, ADR-0032; Argo login keys, ADR-0029) expects those. A different namespace would need rewriting subjects inside the manifests.
- Helm charts, `kustomize` overlays or a copy of the manifests inside Sextant were rejected: a chart or an overlay adds a second source of truth and a tool on the machine; a bundled copy goes stale. The official file at a chosen tag, edited in memory, stays the project's own artifact.
- Asking the cluster whether a kind is namespaced (discovery) was rejected for this step: the CRDs of the file are not in discovery yet when the plan is made, and the plan must be the same text that the preview shows.
- An allow-list rather than a deny-list: a new kind in a future manifest is refused loudly instead of being applied with the wrong namespace.

## Consequences

- Sextant has to follow how Flux builds its default install: a new optional component with new labels would be installed until the filter is updated.
- Removed Flux components leave the shared ClusterRoleBindings without those subjects; an existing Flux with image automation loses their permissions on reinstall. The preview warns about it (ADR-0058).
- A new Flux or Argo CD version that uses a new kind is refused until the allow-list is extended in a Sextant update.
- Image automation, Argo CD in HA or in a namespace-only mode, and a custom namespace are not available from the app; they remain a manual install.
