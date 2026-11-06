# Changes of Flux

## 1.0.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's built-in Flux view as an extension.

- **The Flux section** with Sextant's own tables of the 13 Flux kinds, and a counter of the objects with a problem.
- **Columns** Source, Ready, Status, Revision and Suspended.
- **Details:** the Flux fields of every object, a Kustomization's applied resources, a HelmRelease's resources and the
  Kustomizations and HelmReleases that use a source.
- **Actions:** Reconcile now, Reconcile with source, Suspend and Resume, each showing its patch first and confirmed
  by Sextant.
- **Problems:** a GitRepository, OCIRepository, HelmRepository, Bucket, Kustomization or HelmRelease that is not
  ready and not suspended or still reconciling, after 2 minutes.
- Installing it asks for consent: Read on the Flux kinds and on the kinds a Helm chart usually creates, Modify on the
  Flux kinds.
