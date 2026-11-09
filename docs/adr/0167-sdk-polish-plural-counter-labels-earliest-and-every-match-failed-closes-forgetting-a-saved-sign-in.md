# ADR-0167: SDK polish: plural counter labels, the earliest and every match, failed closes, forgetting a saved sign-in

## Context

After Argo Workflows moved (ADR-0165), four differences from the built-in views were left that extension API 4 could
not express (#398–#401). `sextantApi` 4 is still unreleased, so they are additions to it (ADR-0142).

## Decision

- **A counter's own label** (#398). `contributes.sectionBadges[].label` gives the tooltip and accessible label by CLDR
  plural form (`zero`, `one`, `two`, `few`, `many`, `other`; `other` required), each text with `{{count}}` once and no
  other placeholder, ≤ 80 characters (`check_label_forms` = `checkLabelForms`). Translations key every form a language
  needs as `sectionBadges.<section>.label.<form>`; when a language translates any form the window uses its forms only,
  else the English ones. The window picks the form with `Intl.PluralRules` in the UI language, `other` when that form is
  not given, and writes the count with `formatNumber` (`src/extensions/pluralLabel.ts`).
- **The earliest match and every match** (#399). A match step ends in `<field` — of the matches, the one whose `field`
  sorts first (RFC 3339 times sort as text; one without it last) — or `*` — every match, as a list, only in the last step:
  `.status.nodes[type="Pod",phase="Failed",<finishedAt].message`, `.status.nodes[type="Pod",*]`. One grammar in Rust
  (`PathStep::Match { pairs, pick: MatchPick }`), the window and the SDK. Where one value is needed and a list cannot be
  (the MCP projection, a service answer's `capture`) `*` is refused.
- **A failed close** (#400). `ui.close({failed: "…"})` ends an action window or a headless action as failed: Sextant
  shows its own failure dialog for the action with the text (≤ 1000 characters), as for a built-in action
  (`reportActionFailure`). Without `failed` a close is a plain close, as before.
- **Forgetting only a saved sign-in** (#401). `service.forget({…, saved: true})` removes only the sign-in remembered in
  the keyring and keeps this run's session and tokens; journaled as "saved sign-in of service …".

## Consequences

- Argo CD offers "Forget saved login" without signing the user out of the running session; Argo Workflows counts with
  "N workflows failed recently" and names the step that failed first; Flux's and Argo Workflows' headless actions end
  with Sextant's failure dialog instead of a notice.
- A `*` path yields a list: a column formats it with `format: "list"`, a rule compares it as a list (`same`, lists
  counted as lengths).

## Amendment: more rules and kinds from `sextantApi` 4

Moving the built-in tool modules into extensions needs more than 20 rules over 10 kinds (Knative's two groups,
Crossplane's chain). From `sextantApi` 4 an extension may have 30 problem rules judging 20 kinds (`rule_limits` =
`ruleLimits`); older manifests keep 20 and 10, so an older Sextant never meets a manifest it would refuse.

## Amendment: details sections by condition (#408)

`contributes.detailsSections[].when` (`sextantApi` 4) shows a section only for objects for which the condition holds,
checked as an action's `when` (`check_details_sections` = `checkDetailsSections`, no `missing`) and evaluated by the
window (`DetailsSectionDef.appliesToObject`); while the object loads the section is left out. A GPU block goes only on
GPU nodes, a devices block only on pods that claim devices.

## Amendment: problem categories of an extension's own (#410)

`contributes.problemCategories` (`sextantApi` 4, at most 5: `{id, title, optIn}`) and a rule's `category`
(`check_problem_categories` = `checkProblemCategories`; titles translatable as `problemCategories.<id>.title`). The
window registers each as `ext:<extension id>:<category id>` beside the main `ext:<extension id>`; an opt-in one is off
until turned on (`isOptIn` asks the registry through `setExtensionOptIn`), shown with the opt-in toggles on the Problems
page, and counted on the extension's section only while on. Agents never get these categories: Rust takes only
`ext:<id>` (`category_for_agents`). A columns' `muted` tone came with it (#403).

## Amendment: a details section on every kind (#411)

A details section whose `kinds` is `[{"group": "*", "kind": "*"}]` alone (`sextantApi` 4, no `when`) shows on every
kind: Kyverno's policy results belong to whatever object a report names. The frame hides itself (`ui.setHidden`) where
it has nothing to show. Elsewhere `*` is no wildcard: a permission's or an action's kind `*` matches no kind.

## Amendment: opening a workload cluster (#413)

`ui.openCluster({host, port, node?})` (frames only, a window method like `ui.openUrl`): Sextant lists the configured
clusters whose kubeconfig server is that endpoint (`serverIs`, the default port by scheme) in its own dialog and opens
the one the user picks — connected first if it is not, with `node` that Node's details — every time. The extension
learns only `{opened}`, or `{opened: false, found: 0}` without a question; never the user's clusters or contexts.

## Amendment: a rule's literal reason and since fallbacks (#404, #407)

A problem rule's `reasonOr` (a literal, no `{{…}}`) is the reason when `reason` comes out empty, instead of the title,
and `sinceOr` (≤ 4 field paths, only with a `since`) is tried in order when `since` gives no time: the built-in readings
"the reason, else `NotReady`" and "`endTime`, else `startTime`, else the creation" are one rule each again.

## Amendment: text conditions (#405)

`{"type": "contains" | "startsWith", "path", "values", "ignoreCase"?}` (`sextantApi` 4, ≤ 20 values of ≤ 256
characters) hold when the text at `path` holds or begins with one of the values, compared as written or in lower case.
No pattern language: the built-in regular expressions of alternatives (`/unrecoverable|cannot|…/i`) are lists, and
nothing can backtrack. A value that is not a string never holds.

## Amendment: details sections without a heading, or hidden until shown (#406)

A details `section` may set `heading: false` — no visible heading, as Sextant's own untitled blocks, the title kept as
the group's accessible name — and `startHidden: true` — hidden until its frame calls `ui.setHidden(false)`, so a section
on every kind (#411) never flashes empty. A computed column may give its `width` (`<n>px` or `minmax(<n>px, <m>fr)`), and
a case's `value` sorts a text column too (#403).

## Amendment: a problem about another object, and progress that restarts its grace (#405)

A rule's `about` names the object its problem is about when it is not the judged one — its kind written out, or read
with `apiVersionPath` + `kindPath` (a policy report's `scope`); its name read; its namespace read, the judged object's
(default), or none (`clusterScoped`) — and notifications follow that object unless the rule has a `notifyAs`. Without
the name (or a read kind) the problem stays about the judged object. A rule's `stamp` (≤ 4 paths) is its progress: when
the values change it counts as first seen now, as the built-in rollout and plan rules did. The problems store already
carried both (`Detected.object`, `stamp`); an agent gets a problem only when it may read its object (`can_object`).

## Amendment: lists of a field, counts, sums and map entries (#404)

A path step `[*]` takes every item of a list, or value of a map in key order, and the steps after a `*` step (this one
or `[field="value",…,*]`) read each item, those leading nowhere left out — `.spec.kafka.listeners[*].name` is the
listeners' names; one list per path. `[<field]` is the item with the smallest value there. A custom column shows one
value, so it refuses a path that gives a list (`is_valid_spec`, `checkSpec`); the MCP projection and a service's
`capture` refuse it as before. Column formats `count` (a list's items or a map's entries), `sum` (a list's numbers,
numeric text included) and `entries` (a map's `key=value` in key order, joined in the UI language) read such values;
`count` and `sum` take a `valueText` and a case's `value` like `number`.

## Amendment: richer match steps (#404)

A match step's field may name a nested one (`[connector.state="FAILED"]`) and end in `!` for "not this value"
(`[type!="Ready"]`, also when the entry lacks it); values are compared as text, so `[controller="true"]` and `[n="3"]`
match a boolean and a number too (`pair_fits` = `pairsFit`).

## Amendment: placeholder filters and times in seconds (#404)

A placeholder may end in a filter: `{{path|firstLine}}`, `|lastSegment` (after the last `.` or `/`), `|list` (a list's
scalars joined in the UI language) or `|count` (a list's items, a map's entries) — in messages, reasons and column case
texts alike (`PLACEHOLDER_FILTERS`). A rule's `sinceUnit: "seconds"` reads `since` and `sinceOr` as seconds since 1970.

## Amendment: offsets, unreadable times and deeper rules (#405, #407)

`atLeast` takes an `offset` added to the other value (`-1`: one before the limit), and `olderThan` with `orUnreadable`
holds at once for a value that is there but no time, as the built-in rules counted it. From `sextantApi` 4 a rule nests
`all`/`any`/`not` 6 deep with 40 conditions, and a section counter names up to 30 rules.

## Amendment: actions that need served kinds (#414)

An action's `requiresKinds` (`sextantApi` 4, 1 to 5 kinds) offers it only where the active cluster's discovery serves
every one, as the built-in "Back up namespace…" needed Velero's Backups.

## Amendment: the shown object's uid in the details context (#415)

A details frame's context carries `uid` (optional, beside `resourceVersion`) once the object is read, so a frame finds
what is named by it — a policy report — without reading the object or asking Read on its kind.

## Amendment: a merged logs tab's title (#407)

`ui.openLogs({namespace, labelSelector, title})` titles the merged tab as written (≤ 80 characters, no control
characters) — `raycluster/<name>` rather than the selector; the title stays in the window and never reaches Rust.

## Amendment: blocks that tell their toggles, with actions in their head (#406, #407)

The SDK's `ui.block` takes `onToggle` — each open or close, so a frame remembers it in its `storage` and watches a
block's lists only while it is open — and `actions`, buttons in its head after the title.

## Amendment: a capped watch (#406)

An extension's `resources.watch` may ask `maxObjects` (1 to 20 000): the core keeps that many and counts the rest, and
the `capped` update (still no `WatchUpdate` an extension switches over: the SDK tells it apart, `onCapped` and
`Watch.capped`) says how many match. A capped watch is its own shared list (the cap is in the hub's key), and the hub
tells a frame that joins late the last cap. Watches without `maxObjects` are as before: no `capped`, no parts.

## Amendment: a case's tooltip fallbacks (#403)

A column case's `tooltipOr` (1 to 3, after a `tooltip`, translatable as `cases.<i>.tooltipOr.<k>`) is tried in order:
with it, a tooltip whose placeholder is empty or missing gives way to the next — "reason: message", else "message".

## Amendment: a named object with its own condition (#409)

`{"type": "related", "path", "kind", "when"}` (`sextantApi` 4, problem rules only, not inside `any` or `not`) holds
when the text at `path` names an object of `kind` there — looked up as `missing` looks it up, unknown while that list is
not read in full — for which `when` holds: a claim that exists but is not allocated. `when` reads only the named object,
nothing across objects and no time, since it is judged when that object changes: the row of each looked-up object keeps
the answer of every such `when` (`AcrossRow.facts`, `factKey`), and the judge needs the row there with its fact true.

## Amendment: a rule's source by a field selector (#409)

A rule's `source.fieldSelector` passes field terms to the API server — only fields it selects that kind by, as the
window's table search does: the one table `src/components/Table/field-selectors.json` (read by `selectors.ts`, by
Rust's `is_field_selector` through `include_str!`, and by the SDK) — so DRA's rules watch only Pending pods. Like a label
selector, an object leaving such a list is not deleted, and every rule of a kind has the same source.

## Amendment: sums and counts in conditions (#407)

A compared path of `equals`, `in`, `above`, `below`, `same` or `atLeast` may end in `|sum` (a list's numbers, numeric
text included, added) or `|count` (a list's items, a map's entries): JobSet's restarts of every replicated job against
its limit, `atLeast` with `offset: -1` for one before it.

## Amendment: nested sums, added paths, column sums (#407)

`|sum` adds the numbers of lists inside a list too (`[*].jobRestartsCountTowardsMax|sum`), as a placeholder filter
(`{{path|sum}}`) and at the end of a column's `paths` or `totalPaths` (a ratio of succeeded over wanted jobs); `atLeast`'s
`addPaths` (≤ 3) adds more paths' numbers to `path`'s before the comparison.
