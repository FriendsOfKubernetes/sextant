# ADR-0157: Extensions add items to a cluster's context menu

## Context

Installing Flux or Argo CD starts from a cluster's context menu (ADR-0058, ADR-0062). An extension had no place there
(#352), so that install could not move into one.

## Decision

- **`contributes.menuItems` (`sextantApi` 4).** Each item is `{id, title, icon?, menu: "cluster"}`, at most 10.
  - The items show after Sextant's own install items (`registerClusterMenuItem`).
  - A click opens the extension's window (`view=action`, the item's id as contribution) with that cluster as the
    context's `clusterId` and no selection.
- Titles are translatable (`menuItems.<id>.title`). The consent screen lists the items.
- Everything the window then does goes through the extension API with the user's grant, confirmations and journal.
  Installing from manifests downloaded by the backend needs Modify on what it applies, which the user grants at
  install.

## Consequences

- A GitOps install can be an extension's. The trust it needs is then the extension's permissions and backend hosts,
  shown at consent, rather than Sextant's own allow-list (ADR-0058). The built-in install stays until an extension
  replaces it.
