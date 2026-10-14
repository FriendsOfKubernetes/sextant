# ADR-0049: Extension contributions are declared in the manifest and registered by the host; no extension code runs outside its frame

## Context

Extensions add pages and sidebar sections, details sections or tabs, actions, table columns, dock buttons and a settings section. The frontend registries were not ready for this: pages, details sections and dock tabs have no change notification, `ActionId` and `DockTabType` are closed unions, an action is offered only if its id is in the kind's own list, and labels are i18n keys only. Table columns are synchronous functions of the object, which an iframe cannot supply.

## Decision

Everything an extension contributes is data in `sextant-extension.json`: the host reads the manifest and registers the contributions itself, without running any code of the extension. A contributed view is an iframe opened with `view=page|details|action|dock|settings`. Table columns are declared as a JSONPath (the same subset as CRD printer columns), not code. Texts are plain strings in the manifest, so the registries accept `label` next to `labelKey`; icons are names from Sextant's icon set (an unknown name gets the default icon). Ids are namespaced as `ext:<extId>:<id>`; `ActionId` and `DockTabType` are widened to `ext:${string}`; a kind gets extension actions through `extendActions(kind, ids)`, like `extendColumns`; and every registry that lacked a version hook gets one, so a late registration or removal re-renders. All contributions of one extension are removed with one call. When an extension is disabled or removed, its items, open dock tabs and its open page disappear at once and the page falls back to the cluster overview.

## Why

- Letting an extension register contributions by running code in the host (as Lens does) was rejected: it needs the code to run outside the sandbox (ADR-0047).
- A callback API where the extension returns column values or visibility rules from its frame was rejected: table sorting and rendering need synchronous values for thousands of rows; a message round trip per cell does not fit.
- Per-extension i18n bundles added at runtime were rejected for labels: the strings are the extension's own data, not Sextant's translations, and literal titles are already accepted by columns and dock tabs.
- Namespaced ids are needed because replace-by-id in the registries would otherwise let an extension silently override a built-in page or action.

## Consequences

- An extension cannot decide at run time whether its action applies to an object or what a column shows beyond a JSONPath; richer behaviour lives inside its own frames.
- The manifest is a public contract: every contribution shape (ids `[a-z0-9-]{1,40}`, titles 1-80 characters, unknown fields refused) must stay compatible within `sextantApi` 1.
- Sidebar sections of kinds stay a closed set; an extension gets a new section only through pages, whose header shows `sectionTitle` from the manifest.
- Several registries were touched in the same build, so a regression in late registration shows in places unrelated to extensions.
