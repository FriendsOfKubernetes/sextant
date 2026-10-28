# ADR-0127: Resource table filters use typed local predicates and cluster/kind settings

## Context

Namespace selection and text search cannot express "show Pods except those owned by a Job", or numeric conditions on a column. The main resource lists share `ResourceTable`, including CRDs with printer columns and custom columns (ADR-0099). Cell renderers can show links, several values or translated text; their sorting value does not always mean what the user sees. Filters also need to survive switching tables, unlike the transient table state captured by saved views (ADR-0083).

## Decision

- **Filter loaded objects in the window.** Main kind tables and the primary Events list opt in; Helm and nested details tables do not. Namespace and search restrictions remain, followed by the new predicates, sorting and virtualization. The count and selection use the retained rows; a capped source explicitly limits the result to the loaded part. Filters reuse the existing watches and metric sources; they add no server-side resource selector.
- **Use typed raw column values.** The optional `ColumnDef.filter` describes the type, units, value getter and a shared-data observer; the default is the existing `value` getter. Owner compares the displayed owner's kind, not `kind/name`. Strings ignore case. Negative string comparisons retain missing values; numeric comparisons omit them; zero and false are not empty. CPU is stored in millicores, memory in bytes and age in milliseconds, independent of the UI language. Neither rendered HTML, regular expressions nor user code is evaluated.
- **Keep quick and advanced conditions separate.** A column can have a value selection and a condition. All quick conditions and the advanced expression combine with AND; the latter has nested AND/OR groups. Values apply immediately; condition drafts and the advanced dialog require Apply. Clearing a column removes all its rules, prunes empty groups and simplifies single-child groups, with Undo. A hidden column keeps filtering. An unavailable column pauses its quick filter and the entire dependent advanced expression, preserving the meaning of its groups.
- **Bound work and storage.** Compile once per configuration/schema, short-circuit predicates and read each referenced value at most once per row. Reuse a scratch slot per referenced column rather than cache rows. Build bounded value candidates only while an editor is open; retain selected values even if no loaded object has them, with empty first. Reuse watch revisions, the age tick and shared metric sources. The TypeScript and Rust boundaries check limits: 512 tables per cluster, 200 columns, 200 expression nodes and 200 combined conditions per table, depth 8, 1000 selected values per column and 1000 Unicode characters per value.
- **Persist per cluster and resource view id.** `ClusterSettings.tableFilters` uses the existing settings queue. The window retains only pending or failed edits outside the settings cache; a failed save is visibly session-only. `SavedView.tableFilters` captures the filters; applying a view without it clears the target table's filters. Export writes version 4; import continues to read versions 1–3 without filters. Rust validates persisted shapes and generates the TypeScript bindings; no IPC command or SDK method is added.

## Why

- Raw values give built-in and custom columns the same rules without coupling filtering to cell markup or translations.
- Local predicates preserve the existing loading limits and avoid an additional set of watches. Bounded scratch space and lazy candidates avoid retaining another copy of a large list.
- Pausing a dependent expression as a whole avoids silently changing an OR group when a column disappears. Explicit clearing is the only operation that rewrites it.
- Persistent cluster/kind settings preserve a working filter through navigation while keeping namespace selection and saved-view compatibility explicit.

## Consequences

- Results describe loaded objects, not a query over every object in the cluster; existing list caps still apply.
- Columns with composite values or external metrics must declare their raw semantics and reuse their existing data source. Hiding a column cannot release a source an active filter still needs.
- Old settings keep the previous unfiltered behavior. Filters do not change cluster resources or expose new capabilities to agents or extensions.

## Amendment (0.25.3): the review findings of #294

- **Values that are not there yet pause, not hide.** A column may declare `filter.ready`; while it is false (the CPU/memory poll has never answered for the cluster) its quick conditions keep every row and its chip shows as paused with "The values of … are not available right now", and an advanced expression that uses it is paused as a whole, like an unavailable column. While a poll loads or after it failed, metric filters read the last successful answer, as sorting does, so rows no longer vanish and come back.
- **Text that is a number compares as one.** A text column (a label, an annotation, a printer column of `type: string`) matches "greater than 2" when its text is a number; other text never does. A `type: string` printer column whose JSON value is a number or a boolean is compared as the text kubectl prints.
- **Ages are conditions only.** An age column has no Values tab (a picked age moved out within a minute) and no "equals"/"does not equal"; an age selection saved by 0.25.2 keeps the tab until it is cleared. Every column drawn as an age declares its age (`ageFilter`/`ageOptions` in `src/resources/columns.tsx`): OLM's last unpacked, Argo CronWorkflows' last scheduled, CloudNativePG, KubeRay, External Secrets, OpenShift, storage and k3s snapshot times.
- **The popup is a modal of the stack (ADR-0092).** `FilterPopup` uses `useFocusTrap`: Tab stays inside, Escape and a press outside close it only while it is the top modal, and it sits under dialogs (z-index 90). A second press of **Filters** closes it. After a chip's ✕, Undo or Retry the focus moves to **Filters**. The header button uses the shared compact size (ADR-0034).
- **Import merges table by table, and only on an exact match.** The file's tables replace the same tables of this machine's cluster, others stay; an empty map clears nothing. A cluster matched by its context name only gets no filters ("Table filters are not applied: the cluster matched by name only"), as agent access rules and links.
- **An export Sextant could not import again is not written**: above 1 MiB (`MAX_IMPORT_BYTES` of `views_import_open`) the dialog says how large it would be.
- **No secret material in a filter.** A custom column on a path of `src/resources/inline-secrets.json` (a BuildConfig's webhook secrets, a k3s/RKE2 node's arguments, …) is refused like a Secret's `data` (`readsInlineSecret`), so its values never reach a filter, `settings.json` or an export. A text with a lone UTF-16 surrogate is refused at the boundary, so one edit can no longer fail every later save.
- Smaller: one summary sentence per comparison (`filters:summary.*`) instead of an operator glued before the value; the preview has plural forms; "Filters apply to the loaded part" shows only while a filter is active; facet search labels a non-matching value once and number formatters are reused; `defaultClusterSettings()` has `tableFilters`.
- Not changed: a Controlled By condition compares the owner's kind (the values list shows kinds), not `Kind/name`; the Events page has custom columns ("Add column…") since 0.25.2.

