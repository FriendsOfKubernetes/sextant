# ADR-0036: The cluster rail view (with labels or without) is a frontend field in the window settings

## Context

UI state (`useAppStore`) lives only in memory; `localStorage` is not used anywhere in the project. The sizes of the sidebar and dock and the last cluster are saved through `useLayoutPersistence` into `window.*` of the `settings.json` file. The backend itself writes only `kubeconfigSources` and the window size, so `update_settings` takes these fields from the saved copy. The expanded rail must survive a restart (R13i).

## Decision

`WindowLayout.railExpanded` is a boolean field with a default of `false` in the settings schema (Rust and the generated TS type). Only the frontend reads and writes it: the state is in `useAppStore` (`railExpanded`, `setRailExpanded`), and the write is the existing `useLayoutPersistence`. The field is not added to `update_settings`. One flag for the wide layout and for the slide-out panel of the narrow one.

## Why

- A field written by the backend was rejected: nothing in the backend changes it, and an extra entry in `update_settings` would become one more field to remember when editing.
- `localStorage` was rejected as a separate place: the project uses it nowhere, and the rail view would end up in a different store than the rest of the window view. The materials did not examine this option directly.
- In-memory only was rejected by the requirement: the view must persist between launches.
- A separate flag for the narrow layout was not introduced: the specification requires the slide-out panel to show the rail "in the chosen view".

## Consequences

- The field is in the Rust schema (for reading old files with `serde(default)` and for type generation), but the frontend controls it: anyone who writes `WindowLayout` from the backend must preserve it, otherwise the view will reset.
- Old `settings.json` files are readable: the field was added with a default value (covered by a test).
- The write goes with a 300 ms delay: if the window is closed right after toggling, the view may not be saved.
- One view for all clusters and for both layouts: it is not possible to choose "with labels only in a narrow window".
