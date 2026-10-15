# ADR-0058: Flux and Argo CD are installed from their official manifests, by the user's click only

## Context

ADR-0024 and ADR-0025 kept Sextant from installing anything: Flux and Argo CD were read and acted on only when they were already in the cluster, and a cluster without them got no GitOps sections at all (ADR-0031). The user asked for #81 in v0.7.0: when Flux or Argo CD is missing, offer to install it from Sextant, with a version choice, a preview and a confirmation. The briefing fixed the source: the projects' own `install.yaml`, applied through the Kubernetes API, no Helm charts; Flux as `flux install` does by default, Argo CD as its standard cluster-wide install with the UI, not highly available.

## Decision

- **Where it is offered.** "Install Flux…" / "Install Argo CD…" in the context menu of a connected cluster and in a "GitOps" section of the cluster settings, only when the tool's kind (`kustomize.toolkit.fluxcd.io/Kustomization`, `argoproj.io/Application`) is not in discovery. The sidebar sections stay hidden without the tool (ADR-0031) and appear by themselves after the install (the apply refreshes discovery; the dialog asks the window to read the kinds again).
- **Source.** Only these URLs, built by Sextant, checked again before each request: `https://api.github.com/repos/{fluxcd/flux2|argoproj/argo-cd}/releases?per_page=30` (stable releases: no pre-releases, no drafts, tags `vX.Y.Z`, newest first), `https://github.com/fluxcd/flux2/releases/download/<tag>/install.yaml` with `flux_<version>_checksums.txt` of the same release, `https://raw.githubusercontent.com/argoproj/argo-cd/<tag>/manifests/install.yaml`. HTTPS through rustls, no automatic redirects (each one must go to GitHub's asset hosts), a size limit (2 MiB for the release list, 20 MiB for a file) and 60 s per download — the rules of the extension downloader, now shared in `src-tauri/src/download.rs`. When GitHub cannot be asked (no network, its rate limit), the bundled tested versions are offered (Flux v2.9.6, Argo CD v3.5.5) with the reason.
- **Integrity.** Flux's `install.yaml` must have the SHA-256 its release's checksums file lists; otherwise nothing is installed. Argo CD publishes no checksum for `manifests/install.yaml`, so its SHA-256 is shown in the preview, not verified.
- **Plan and apply** are the core's (`sextant_core::gitops_install`): Flux without image automation and the source watcher, Argo CD into `argocd`; Namespace, CRDs, a discovery refresh, then the rest in file order; forced server-side apply per object (field manager `sextant`), stopping at the first error.
- **Preview before anything is sent**: version, source URL, SHA-256 (and "verified" for Flux), namespace, objects by kind with the cluster-wide ones marked, a cluster-admin warning, SelfSubjectAccessReview for creating CRDs and ClusterRoleBindings (a warning, the button stays), whether the tool is already (partly) there, which cluster-wide objects already exist and will be overwritten, and — for Flux over a Flux with image automation — that those controllers lose their permissions in the shared bindings. The prepared plan waits under a single-use token for 10 minutes, bound to its cluster.
- **Install** is a stream `gitops-install:<id>` opened by the window (`openStream`), registered in `AppState` before it starts: an event per object, then readiness every 3 s for up to 5 minutes (every Deployment / StatefulSet of the plan must exist and be ready — no workload is never "ready"), then `done`, `timedOut` (with the pods' reasons), `stopped` or `error`. "Stop" ends it after the current object; closing the dialog asks first; disconnecting the cluster, a reload and quitting abort it, and the window still gets a final event saying how many objects were applied; a disconnect also drops the cluster's prepared plans. The dialog is mounted once by the window shell, outside the cluster rail, so a switch between the narrow and the wide layout never unmounts (and so never stops) a running install.
- **Only the user's click.** The install is five window commands (`gitops_install_*`). There is no MCP tool and no extension method for it; a test keeps it so.

## Why

- Official manifests through the Kubernetes API keep ADR-0024's reason (nothing needed on the machine, the user's own rights) and need no `flux`/`argocd` binary or Helm.
- Fixed URLs rather than a link the user pastes: the only choice the user makes is a version, so nothing but those two projects' releases can be applied.
- A forced server-side apply, like `flux install` and `kubectl apply --server-side --force-conflicts`: an install over a partial one updates its objects instead of stopping at the first field another manager owns; the preview says what is overwritten.
- Not for agents or extensions: installing a controller changes the whole cluster with cluster-admin rights; a click in the window is the consent.

## Consequences

- Sextant now changes clusters beyond single objects. Uninstalling is not offered; the wiki gives the manual steps.
- The release list is GitHub's unauthenticated API (60 requests an hour per address); past the limit the bundled version is the only choice until the limit resets.
- Argo CD's manifest is trusted as served by raw.githubusercontent.com for the tag; a moved tag would not be noticed.
- New versions of the manifests may use kinds outside the core's allow-list and are then refused until Sextant is updated.
