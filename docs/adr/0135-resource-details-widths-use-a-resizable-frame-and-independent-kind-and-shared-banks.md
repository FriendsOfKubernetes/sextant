# ADR-0135: Resource details widths use a resizable frame and independent kind and shared banks

## Context

The resource card overlays the table at a fixed width of 725 CSS pixels. Long fields, tables and charts can need more space, while a wider card should not become a different preference merely because the window becomes smaller.

## Decision

- Keep the overlay and put its sizing in `src/layout/details/DetailsPane.tsx`. Reuse the shared `Splitter` on the left edge: dragging left grows the card, dragging right shrinks it; Left and Right do the same in 16px steps. The existing 1px line has a 7px pointer target and hover/focus feedback. Pointer cancellation, lost capture and unmount release the drag state, also for the sidebar and dock.
- Start at 725 CSS pixels, allow at least 480, and cap the rendered card at the workspace width. One `ResizeObserver` follows the workspace, not pointer movements. At window widths up to 768px, or a workspace no wider than 480px, use the full available width without a splitter. Window constraints never rewrite the preferred width. Repeated rounded values do not update the store.
- Settings → Appearance → Resource details offers `appearance.detailsWidthScope` (`kind`, the default, or `global`) and the independent `detailsWidthSessionOnly` boolean (default `false`). Both apply across clusters. `window.detailsWidths` keeps independent banks: `group/Kind` for resource kinds, without API version, namespace or cluster, and `*` for the shared width. Switching scope selects its bank without copying over another.
- Hydrate sizes once, using the existing settings cache and queue. Persist width edits after 300ms and merge them into the latest window settings. Session-only mode cancels pending width saves and keeps edits in memory. A launch with that mode enabled ignores saved widths and starts from 725px. Turning it off merges current session sizes into the saved map, preserving untouched kinds. A failed write leaves the current width usable in memory; a later adjustment retries.
- Size updates belong to the frame, whose children retain their identity. Memoize the application shell so a completed width save does not rerender the main table through `App`'s settings subscription. Namespace restoration subscribes only to settings-load readiness, rather than every layout write; the access store notifies React about a settings write only if the restricted namespace scope moved. Access-check results still notify normally and live namespace choices still come from the cluster store. Neither resizing nor its save remounts the card, changes its selected tab, resets disclosure/scroll state or restarts its subscriptions.
- Rust supplies defaults for missing or invalid appearance choices; malformed width entries are skipped independently. Widths are integer CSS pixels of at least 480. Regenerate TypeScript types from Rust. No dependency, IPC command or SDK method is added.

## Consequences

- Pod, Node and kinds in different API groups can have different widths across all clusters. A shared width remains available when the user switches back to it.
- The session-only flag itself is persisted, while that mode's sizes are not. Stored sizes remain available if persistence is enabled again; active session edits take precedence.
- Pointer handling, keyboard directions, clamping, settings compatibility, scopes, restarts, debouncing, failed saves, accessibility and subscription/render stability are covered by automated tests. Browser geometry and pointer hit testing are checked separately because Vitest does not apply layout CSS.
