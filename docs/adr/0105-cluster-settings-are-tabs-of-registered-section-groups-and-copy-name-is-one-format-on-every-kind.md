# ADR-0105: Cluster settings are tabs of registered section groups, and "Copy namespace/name" is one format on every kind

## Context

The cluster settings dialog had grown into one long page of sections registered by features (general, metrics, agent access, change preview, GitOps, and more to come). #230 asked for tabs, one per group, with the last tab remembered and links from elsewhere opening the right one. #229 asked for a quick way to copy an object's `namespace/name`.

## Decision

- **Tabs come from the section registry.** `ClusterSettingsSectionDef` gains `tab`; tabs are `ClusterSettingsTabDef` (`id`, `order`, `labelKey`), built in to `settingsRegistry.ts` — General, Connection, Metrics, AI agent access, Change preview, GitOps, More — and a feature may add one with `registerClusterSettingsTab`. A section without `tab`, or naming a tab nobody registered, goes to "More", so a section of another feature is never lost. A tab with no section is not shown (GitOps is shown as before: the install section does not depend on discovery). A section's heading is drawn only when its tab holds several sections; with one, the tab names it. The dialog uses the shared `Tabs` (WAI-ARIA keys, roving focus) and has one width for all tabs, so switching does not resize it.
- **"Connection"** holds where the context comes from (context, cluster, server, user, kubeconfig file; moved out of "General") and is the place for more about the connection — the kubeconfig viewer (#228) registers there.
- **The last tab is remembered per window, in memory** (`settingsTab` in `clustersStore.ts`, like the Settings page's tab), not in `settings.json`: it is a convenience of the session, not a setting.
- **Deep links**: `openClusterSettings(id, target)` takes `"icon"` (the icon field of General) or a section id; the section's tab is selected and the section scrolled into view and focused. The "Open cluster settings" links next to missing metrics, request health and the traffic graph open "metrics".
- **Copy namespace/name** is two registered actions offered on every kind through `extendActionsForAll`: "Copy namespace/name" for namespaced objects and "Copy name" for cluster-scoped ones; several selected rows give one name per line. Only this format (the user's choice): no YAML, no kind prefix, no `-n`. The text goes through `navigator.clipboard`, like every other copy in the window (nothing secret is copied, so the backend clipboard used for kubeconfig credentials is not needed). A short confirmation is shown at the bottom of the window (`CopyToast`, a live region always in the page, 2.5 s); a refused clipboard says so instead.
- **Ctrl+C / ⌘C on a focused table row** runs the same action (the row, or every selected row when the row is one of them). It fits the keyboard model of ADR-0092: the row is the focus target and had no use for Ctrl+C; a text selection keeps the browser's copy; Ctrl+Shift+C stays the terminal's.
- Agents and extensions get nothing new.

## Consequences

- A new cluster settings section picks its tab (or gets "More"); a new group adds a tab next to the built-in ones.
- `getClusterSettingsSections()` now returns sections in tab order, then their own order.
