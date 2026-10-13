# ADR-0031: The Flux and Argo CD sections are registry kinds in new sections; installation is detected by CRDs in discovery

## Context

The "Flux" section must appear only if the cluster has Flux, and the "Argo CD" section only if it has Argo CD (story 1). The sidebar works like this: pages (`registerPage`) are always shown, without checking discovery, while kinds registered in the registry are hidden if they are not in discovery. `ResourceDef.sidebar` accepts only sections from the closed union `SidebarSection`. Flux and Argo CD objects without registration were shown as nameless Custom Resources with standard columns.

## Decision

`SidebarSection` gets `"flux"` and `"argocd"` (before `customResourceKinds`). All kinds of both tools are registered through `registerResource` with `sidebar` in these sections; a kind absent from discovery is absent from the section too; a section with no kinds is not drawn. Until discovery arrives, the sections are hidden (`DISCOVERED_SECTIONS`; for the other kinds, all are shown until discovery arrives). A tool is considered installed if its CRDs are found in discovery: for Flux, at least one `*.toolkit.fluxcd.io` group; for Argo CD, the `argoproj.io` Application. The Flux section is one flat ordered list. Pages are not registered in these sections without their own check (`useClusterKinds` + `findKind`). `ActionId` gets ten values (`reconcile`, `reconcileWithSource`, `fluxSuspend`, `fluxResume`, `argoSync`, `argoRefresh`, `argoHardRefresh`, `argoTerminate`, `argoDiff`, `argoOpenUi`).

## Why

- `registerPage` was rejected as the main path: pages are always shown, and a custom discovery check would have to be written for each. The reason is not named directly in the materials, but follows from how the sidebar works.
- Detecting the installation by controllers (a Deployment, a namespace) instead of CRDs was not discussed in the materials; the choice of CRDs is recorded in story 1 without justification.
- `suspend` in `ActionId` is already taken by the CronJob action, so Flux gets `fluxSuspend` and `fluxResume`.

## Consequences

- A registered kind with `sidebar` disappears from the Custom Resources tree; with `sidebar: null` it appears nowhere. For a registered kind only the columns from `def.columns` are used, and the CRD's printer columns are not substituted.
- A CRD with no controller (left after the tool was removed) will also turn the section on: the criterion is the presence of a CRD, not a working installation. This follows from the detection method, not from a check.
- A new action requires a new member of the closed `ActionId` and an edit to the registry (this is an edit in the shared zone of task 01).
- Installing Flux or Argo CD while the connection is open shows the section without reconnecting, thanks to ADR-0026.
- Pages in the `flux` and `argocd` sections without their own check would be shown always, even without the tool.
