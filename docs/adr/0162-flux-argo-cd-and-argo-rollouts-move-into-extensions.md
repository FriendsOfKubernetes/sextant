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
  - the GitOps install from the official manifests (ADR-0058) and the MCP tool `gitops_action`;
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
