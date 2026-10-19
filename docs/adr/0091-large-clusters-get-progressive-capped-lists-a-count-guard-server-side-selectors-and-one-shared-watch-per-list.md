# ADR-0091: Large clusters get progressive, capped lists, a count guard, server-side selectors and one shared watch per list

## Context

#157 asked that Sextant stay responsive on clusters with tens of thousands of pods and hundreds of CRDs. Measured before the change (wiki page "Large clusters"): a table showed nothing until the whole list was downloaded and parsed (3.6 s for 50 000 pods from a fast fake API server, 7.2 s with 50 ms per page), the backend kept every object (≈ 480 MB for 50 000 pods), label terms in the search box were filtered in the window after everything was listed, and a table and the resource map listing the same objects each opened their own watch.

## Decision

- **The first list arrives in parts.** A watch started with `WatchOptions.progressive` sends `SnapshotPart` with the objects listed so far as the API server's pages come in (500 per page), then `SnapshotEnd`; later relists still send one `Snapshot`. The window shows rows after the first page ("Loading… N so far").
- **A table keeps at most 20 000 objects.** With `WatchOptions.maxObjects` the backend keeps and sends at most that many; the rest are counted by uid only, and `Capped` says how many match in all. The table says "Showing the first N of M" and how to narrow the list. Tables watch with `TABLE_WATCH_OPTIONS` (`src/components/Table/limits.ts`: progressive, `TABLE_MAX_OBJECTS` = 20 000).
- **Count before listing everything.** Before a namespaced kind is watched in every namespace without a selector, the table asks `resource_count` (`resources::count`: a metadata-only list of one object per namespace, the API server's `remainingItemCount`, no object body; at most 10 s; with a selector the API server does not count, so metadata pages are counted up to the limit and the answer is "at least"). Above `TABLE_GUARD_OBJECTS` (10 000) the table asks first; "Show anyway" is remembered until restart. A count that fails or takes longer than `COUNT_WAIT_MS` (3 s) does not hold the capped watch back.
- **Selector terms go to the API server.** Label terms of the search (`app=web`, `tier!=db`, `app=`) become the watch's label selector, and terms on fields the API server can select by for the kind become its field selector, 400 ms after the last keystroke (`serverSelectors`, `src/components/Table/selectors.ts`). Only the fields the API server supports per kind are mapped (`metadata.name`/`metadata.namespace` everywhere, `status.phase` and `spec.nodeName` on pods, …); any other term stays a text search in the window. The previous rows stay ("Updating…") until the narrower list is in.
- **One watch per (cluster, spec).** `src/api/watchRegistry.ts` shares a stream between every view that asks for the same cluster, kind, namespaces, selectors and `metadataOnly` — tables (`useWatch`), the resource map and the RBAC views. It is reference-counted, may linger after the last holder (`linger`), and is dropped with the cluster's connection (`dropClusterWatches`). `WatchOptions` are not part of the key: a holder asking for a cap joins an uncapped stream, and a capped stream is reopened without its cap when a holder needs every object. The problem sources and the palette index keep their own streams (they keep nothing or only metadata).
- **Counts in the sidebar are budgeted.** A count is shown next to the kinds of an open built-in section and next to the open entry (cached 60 s, "999+" above that); closed sections, installed tools' sections and custom resources ask nothing, and a cluster gets at most `COUNT_REQUESTS_PER_MINUTE` (20) count requests a minute (a table's own check is not held back).
- **The palette index is capped** at `MAX_INDEXED_OBJECTS` (50 000) per kind and says when it searched only part of a kind.
- **The window-only updates stay out of the SDK.** Agents and extensions keep the default options (one `Snapshot`, every object); the SDK's copy of `WatchUpdate` leaves out `snapshotPart`, `snapshotEnd` and `capped` (`sdk/scripts/sync-types.mjs`, `NARROW`), so an extension's exhaustive `switch` stays complete.

## Why

- Virtual scrolling alone was not enough: the time to the first row and the memory were spent before the table rendered anything.
- A cap without a notice was rejected: a table that silently shows part of a list misleads. A hard refusal above a size was rejected too: the user can narrow by namespace or label, or choose to list anyway.
- Paging the table through the API server (`continue` tokens per screen) was rejected: the table sorts and searches the whole list, and a watch needs a complete list to follow changes.
- Filtering by fields in the window for every field was kept as the fallback; sending an unsupported field selector would make the API server refuse the whole list.

## Consequences

- With 50 000 pods the first rows come after ≈ 70 ms instead of 3.6–7.2 s, and the backend keeps ≈ 193 MB instead of 481 MB.
- A table never shows more than 20 000 objects of one list; the user narrows to see the rest.
- `remainingItemCount` can be approximate, so the guard's number is "about".
- The backend still keeps a watched object as a JSON tree (≈ 4× its JSON size); keeping raw JSON is a possible next step.
