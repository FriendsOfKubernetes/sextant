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
