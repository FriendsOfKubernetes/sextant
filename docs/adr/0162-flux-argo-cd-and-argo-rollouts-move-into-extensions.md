# ADR-0162: Flux, Argo CD and Argo Rollouts move into Sextant's own extensions

## Context

Since 0.30 the extension API covers what the built-in Flux, Argo CD and Argo Rollouts views did (ADR-0152–0161), and
Sextant's own extensions `extensions/flux`, `extensions/argo-cd` and `extensions/argo-rollouts` do it on the public API
only. The course of #320 is to keep the core small: tool-specific views ship as catalog extensions on their own
cadence. Two copies of the same views — the built-in one and the extension — cannot both stay: their sections, problems
and notifications would double.

## Decision

- **Removed from the core.**
  - The window features `src/features/flux`, `argocd`, `argocd-diff` and `argo-rollouts` and their texts.
  - The Argo CD API client, sign-in and diff in Rust (`sextant_core::argocd`, the `argocd_*` commands, `ArgoSessions`
    with its keyring entries, `ForwardSource::ArgoCd`).
  - The window's status patch of a Rollout (`resource_patch_status`, `STATUS_PATCH_KINDS`); an extension patches a
    granted custom kind's status through `patch_custom_status` (ADR-0155).
  - The problem categories `flux`, `argocd` and `rollouts`, and the sections of that name from `SIDEBAR_SECTIONS`.
  - The palette's short names `hr`, `ks`, `app` (the extensions declare them as `aliases`).
- **Kept in the core**, as knowledge of objects other features read, never as views:
  - managed-by marks in Cleanup and Delete, field manager names in the timeline, Helm/Argo CD/Flux origins in upgrade
    readiness;
  - Restart of an Argo Rollout (`kubectl argo rollouts restart`'s `spec.restartAt`);
  - the Flux kinds Cleanup scans for the Secrets and ConfigMaps they name (`src/resources/gitopsKinds.ts`);
  - the GitOps install from the official manifests (ADR-0058) (and, until #402, the MCP tool `gitops_action`);
  - the icons of the set the extensions name (an extension API name is never removed, ADR-0142);
  - the loopback TLS of Sextant's own port forwards, now `sextant_core::loopback_tls`, used by extension services
    (ADR-0158).
- **Places.** The extensions' sections `flux`, `argocd` and `argoRollouts` come where the built-in ones were, after
  Velero, whatever a manifest's `after` says (`EXTENSION_SECTION_PLACES`).
- **Fleet cards.** The "installed tools" of a cluster card are Gateway API and every active extension's problem category
  with a source in the cluster: the cards now watch extension categories (an amendment of ADR-0137, which kept them
  out). Agents and the timeline still never get them unasked.
- **Agents.** `get_problems` reads the old names `flux`, `argocd` and `rollouts` as the extensions' categories
  (`moved_category`); whether the agent gets them is `mcp.extensionProblems` (ADR-0146).
- **Migration** (`settings::migrate`, version 3, once):
  - a notification category the user turned off (`flux`, `argocd`, `rollouts`) stays off as the extension's
    (`ext:sextant.flux`, `ext:sextant.argo-cd`, `ext:sextant.argo-rollouts`);
  - agents, which got Flux and Argo CD problems by default, keep getting them: `sextant.flux` and `sextant.argo-cd` join
    `mcp.extensionProblems` (a new install starts empty, ADR-0146);
  - `clusters[id].argocdNamespace` is no longer read; the Argo CD extension finds `argocd-server` by its label.
  - Saved Argo CD logins in the keyring (`argocd:<ns>@<uid>`) are not carried over: the extension signs in through
    Sextant's own dialog (ADR-0160) and remembers it under its own key. The old entries stay unread.
- **Offers.** Where the active cluster serves a tool's kinds and its extension is not installed, the sidebar offers it
  (`src/features/extension-offers/`): "Install" opens the catalog's own install in Settings → Extensions (the package
  checked, then the consent window, `requestCatalogInstall`); "Not now" hides it for the run; "Don't offer again" keeps
  it in `extensionCatalog.declinedOffers`. The end of a Flux or Argo CD install offers the same.

## Consequences

- An upgrade from 0.29 shows nothing of Flux, Argo CD or Argo Rollouts until the user installs the extensions; the offer
  says so in the sidebar of every cluster that runs them. With the catalog turned off the request waits until it is on.
- The extensions must be in the catalog before 0.30.0 is released.
- `crates/sextant-core/tests/gitops_flux.rs` and `gitops_argocd.rs` keep checking the patches against real Flux and
  Argo CD: the extensions send the same ones. The core's Argo CD client tests (`gitops_argocd_diff.rs`) went with it.
- The e2e GitOps scenarios run against the extensions installed into the e2e profile.

## Amendment: Argo Workflows (#397)

Argo Workflows moves the same way in 0.30.0, on the API additions of ADR-0165: the extension `extensions/argo-workflows`
(`sextant.argo-workflows`), the built-in `src/features/argo-workflows` and its texts removed, the section `argoWorkflows`
kept in place after Velero (`EXTENSION_SECTION_PLACES`), an offer in `OFFERS` matching `argoproj.io` `Workflow`, and the
category `workflows` moved by the version-3 migration to `ext:sextant.argo-workflows` (`MOVED_PROBLEM_CATEGORIES`, not
given to agents: it never was). `fnv32a` and `DurationText`, which OpenShift used, moved to OpenShift's model and the
shared components. The extension must be in the catalog before 0.30.0 is released, as the other three.

## Amendment: the agents' GitOps tools (#402)

The MCP tool `gitops_action` leaves the core too, without an alias. The Flux extension's backend gives agents
`reconcile`, `suspend` and `resume`, the Argo CD extension's `sync`, `refresh` and `hard-refresh` (`contributes.agentTools`,
ADR-0159; MCP names `ext_sextant_flux__<tool>`, `ext_sextant_argo-cd__<tool>`), each sending the patch `gitops_action`
sent (a sync reads the Application for its sync options and retry policy). The backends are TypeScript components
(`backend/main.ts`) whose logic is the pure `src/agentTools.ts`. Agents get them only when the user agrees to the tools
when installing or updating and turns the extension's tools on in Settings → AI agents (MCP); every call is decided for
the extension and the agent both. "What's new" for 0.30.0 says so.

## Amendment: CloudNativePG, Strimzi and Operator Lifecycle Manager

The course of moving every built-in tool module into Sextant's own extensions starts with the three that need no API
addition: `extensions/cnpg` (`sextant.cnpg`), `extensions/strimzi` (`sextant.strimzi`) and `extensions/olm`
(`sextant.olm`), each 1.0.0 on `sextantApi` 4. Their built-in features and texts are removed; their sections keep their
places (`EXTENSION_SECTION_PLACES`: `cnpg` and `strimzi` after `sealedSecrets`, `olm` after `kserve`); the sidebar offers
them where their groups are served (`OFFERS`); the version-3 migration moves the categories `cnpg`, `strimzi` and `olm`
to the extensions' (never for agents, as before); "What's new" lists them. What each extension still shows differently
from the built-in view is listed in its README under "Requirements and limits", with the API addition that would close
it.

## Amendment: External Secrets, JobSet, KubeRay and KServe

The second group moves the same way: `extensions/external-secrets`, `extensions/jobset`, `extensions/kuberay` and
`extensions/kserve` (1.0.0, `sextantApi` 4). Their sections keep their places (`externalSecrets` after `kyverno`;
`jobset`, `kuberay`, `kserve` and `olm` after `kueue`), the version-3 migration moves their categories (never for
agents), and the secret-name rule KubeRay's masks shared with the core moves to `src/resources/secretNames.ts`. The
ClusterExternalSecret Refresh column now reads `spec.refreshTime`: the built-in one read `spec.refreshInterval`, which
that kind does not have, and was always empty.

## Amendment: Knative

Knative Serving and Eventing move into one extension, `extensions/knative` (`sextant.knative`, 1.0.0), with both
sections (`knative`, `knativeEventing`, after `contour`) and a counter each, counting its own rules
(`sectionBadges[].rules`); the category `knative` moves to the extension's (never for agents). A SinkBinding's subject
selector now reads as a selector (the built-in printed `[object Object]`).

## Amendment: NVIDIA GPU Operator, and DRA kept

`extensions/gpu-operator` (`sextant.gpu-operator`, 1.0.0) takes the GPU Operator view, its Node "GPU" block on GPU nodes
only (`detailsSections[].when`, #408); the section keeps its place after `dra`, and the category `gpuOperator` moves to
the extension's (never for agents). A component not rolled out is now a problem of its DaemonSet, not of the
ClusterPolicy (a rule cannot name another object, #405). Dynamic Resource Allocation stays built in: its rules cannot yet
see a claim that exists but is not allocated nor watch only Pending pods (#409).

## Amendment: Velero

`extensions/velero` (`sextant.velero`, 1.0.0) takes the Velero part of the storage insights (ADR-0086): its five kinds
in the section `velero`, which keeps its place right after `volumeSnapshots` (the sections that were placed after
`velero` — `flux`, `argocd`, `argoRollouts`, `argoWorkflows` — are now anchored to `volumeSnapshots` behind it, so the
order is unchanged), "Back up namespace…" and "Restore from this backup…" through `resources.create` (#412, ADR-0086
amendment), and an offer where `velero.io` is served. Velero had no problem category, so the migration has nothing to
move. Volume usage, VolumeSnapshots and their actions stay in the core's `src/features/storage/`, and so does the window's
`resource_create`, which they still use.

## Amendment: Kueue and Kyverno

`extensions/kueue` (`sextant.kueue`, 1.0.0) takes the Kueue view and its "Queue" details section on the jobs Kueue
queues; `extensions/kyverno` (`sextant.kyverno`, 1.0.0) takes the Kyverno view and "Policy results" on every object's
details. Their sections keep their places (`kyverno` right after `crossplane`, with `externalSecrets` now anchored to
`crossplane` behind it; `kueue` right after `gpuOperator`, with `jobset`, `kuberay`, `kserve` and `olm` now anchored to
`dra` behind it, so the order is unchanged), and the sidebar offers them where `kueue.x-k8s.io` and `kyverno.io` are
served. Their problems move into categories of the extensions' own (`problemCategories`, #410): the version-3 migration
turns `kueue` (on by default) into `ext:sextant.kueue:queues` (`MOVED_PROBLEM_CATEGORIES`, its extension part naming the
category) and the opt-in `kueueWorkloads` and `policies` into `ext:sextant.kueue:workloads` and
`ext:sextant.kyverno:policies` (`MOVED_OPT_IN_CATEGORIES`); none of them is ever given to agents, as before, and
`get_problems` still refuses the old names.

## Amendment: Dynamic Resource Allocation

`extensions/dra` (`sextant.dra`, 1.0.0) takes the Dynamic Resource Allocation view (ADR-0116): the four
`resource.k8s.io` kinds in the section `dra`, the "Devices" page, and the Pod "Devices" and Node "DRA devices" details
blocks. The section keeps its place right after `helmController` (the sections that were placed after `dra` —
`gpuOperator`, `kueue`, `jobset`, `kuberay`, `kserve` and `olm` — are now anchored to `helmController` behind it, so the
order is unchanged), and the sidebar offers it where `resource.k8s.io` is served. Its wait is told by rules over the
Pending Pods that look the ResourceClaims up (`missing`, the looked-up claim's allocation), which #409 lacked when the GPU
Operator moved; where the extension still differs is listed in its README. The version-3 migration moves the category
`dra` (on by default) to `ext:sextant.dra` (`MOVED_PROBLEM_CATEGORIES`, never for agents by default, as before).
`resource.k8s.io` stays among Kubernetes' own groups (`src/resources/useKinds.ts`), so without the extension its kinds
are not listed under Custom Resources either.

## Amendment: Sealed Secrets

`extensions/sealed-secrets` (`sextant.sealed-secrets`, 1.0.0) takes the Sealed Secrets view (ADR-0109): SealedSecrets
in the section `sealedSecrets` with the built-in columns, "Only problems" and details (the Synced state and the
controller's error in words, the scope, the target Secret and how it stands, the sealed keys by name and size, the
controller and its sealing keys), Secrets read as metadata only and the sealing certificate never. The section keeps its
place right after `crossplane`, behind `kyverno` and `externalSecrets` (`cnpg` and `strimzi`, which were placed after
`sealedSecrets`, are now anchored to `crossplane` behind it, so the order is unchanged), and the sidebar offers it where
`bitnami.com` SealedSecrets are served. Its problems are rules of the extension's own opt-in category (`problemCategories`,
#410): failed unseals, and synced SealedSecrets whose Secret is missing, told by `missing` against a metadata-only
Secret list. The version-3 migration turns the opt-in `sealedSecrets` into `ext:sextant.sealed-secrets:sealed-secrets`
(`MOVED_OPT_IN_CATEGORIES`); it is never given to agents, as before, `get_problems` still refuses the old name, and the
Problems page's own toggle for it is gone (the extension's category has the toggle every opt-in extension category
gets). Where the extension still differs — the Secrets it lists to tell a missing one, the table's search by the shown
words, the SDK's details tables and the blocks' memory (#417) — is listed in its README.

## Amendment: Vertical Pod Autoscaler and Prometheus Operator

`extensions/vpa` (`sextant.vpa`, 1.0.0) takes the Vertical Pod Autoscaler view (ADR-0111): VerticalPodAutoscalers and
their Checkpoints in the section `vpa` with the built-in columns, "Only problems" and details (the state from the
recommender's conditions, the update mode, the recommendation per container against the target template with what the
admission controller would set on a pod created now, an HPA that fights it, the recommender, updater and admission
controller), and the workloads' "Vertical Pod Autoscaler" block (its details section `workload`, the built-in
`vpaWorkload`). The section keeps its place right after `karpenter`, and the sidebar offers it where
`autoscaling.k8s.io` VerticalPodAutoscalers are served. Its problems (`ConfigUnsupported`, `NoPodsMatched`,
`HpaConflict`, the HPA found by `relatedBy`) are rules of the extension's own category; the version-3 migration moves
the category `vpa` (on by default) to `ext:sextant.vpa` (`MOVED_PROBLEM_CATEGORIES`, never for agents by default, as
before).

`extensions/prometheus-operator` (`sextant.prometheus-operator`, 1.0.0) takes the Prometheus Operator view (ADR-0100):
ServiceMonitors, PodMonitors, Probes, PrometheusRules, Prometheuses and Alertmanagers in the section
`prometheusOperator` with the built-in columns, "Only problems" and details (what a monitor selects now and whether its
ports exist, which Prometheus picks an object up, a rule's groups, readiness). The section keeps its place after
`crossplane`, behind `strimzi`, and the sidebar offers it where `monitoring.coreos.com` is served. Its problems are
rules of the extension's own opt-in category (`problemCategories`, #410): Prometheuses and Alertmanagers not available,
not reconciled or degraded, and monitors that select nothing, told by `selectsNone` against metadata-only Service and Pod
lists. The version-3 migration turns the opt-in `prometheusOperator` into
`ext:sextant.prometheus-operator:prometheus-operator` (`MOVED_OPT_IN_CATEGORIES`); it is never given to agents, as
before, `get_problems` still refuses the old name, and the Problems page's own toggle for it is gone. The built-in
provider and store that judged monitors across objects go with it; the problems store's `SourceDef.external` and
`across` and the map's `judgedByRules` stay, still used by other categories (k3s, mesh, Traefik, Crossplane, Contour and
OpenShift). Cleanup keeps its knowledge of the monitoring kinds (`hygiene/kinds.ts`). Where the extensions
still differ — for the VPA, a problem's HPA by name, no pods matched never notifying and the HPAs it looks up; for
Prometheus Operator, the "not picked up" warning and the Services and Pods it lists — is listed in their READMEs.

## Amendment: Cluster API

`extensions/cluster-api` (`sextant.cluster-api`, 1.0.0) takes the Cluster API view (ADR-0113): Clusters, ClusterClasses,
KubeadmControlPlanes, MachineDeployments, MachineSets, Machines, MachineHealthChecks and ClusterResourceSets in the
section `clusterApi` with the built-in columns, "Only problems" and details (each object's state in both status shapes,
the chain Cluster → control plane and infrastructure → MachineDeployments → MachineSets → Machines → bootstrap and
infrastructure objects → the Node, a MachineHealthCheck's checks and why remediation is blocked). The section keeps its
place after `crossplane`, behind `prometheusOperator`, and the sidebar offers it where `cluster.x-k8s.io` is served. A
workload cluster Sextant has opens through `ui.openCluster` (#413), which the core keeps. Its problems (`Failed`,
`NotAvailable`, `ProvisioningStuck`, `RemediationBlocked`) are rules of the extension's own category; the version-3
migration moves the category `clusterApi` (on by default) to `ext:sextant.cluster-api` (`MOVED_PROBLEM_CATEGORIES`,
never for agents by default, as before). A paused Cluster's Machines and control planes are told by the extension's
rules (their own Paused condition, or their Cluster with only old conditions), so the problems store's
`AcrossDef.from` — a source judged across another source's rows, which only Cluster API used — goes with the built-in
view, as does `Detected.belongsTo`; `across` on a source's own rows stays (Contour, OpenShift). The objects-by-name
reader the built-in view shared with k3s's ServiceLB table moves to `src/resources/refObjects.ts`. Where the extension
still differs — the state columns' hover in two status shapes, provider objects of kinds not named in its permissions,
a paused Cluster it cannot read, the workload cluster opened through Sextant's dialog — is listed in its README.
