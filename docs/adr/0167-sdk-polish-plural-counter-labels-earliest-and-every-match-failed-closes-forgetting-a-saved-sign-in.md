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

## Amendment: a details frame's blocks in Sextant's own memory (#416)

A details frame's context carries `blocks` — its blocks' open (`true`) or closed (`false`) choices by id, `*` for the
panel's "Expand all"/"Collapse all" — read from Sextant's memory of details sections as Settings → Appearance says
(globally, per cluster, or this object only; `useDetailsDisclosureBank` under the section's scope), and
`ui.setBlockOpen({id, open})` (details frames only, ids of `[A-Za-z0-9._-]`) writes a choice there. The SDK's
`ui.blockOpen(context.blocks, id, defaultOpen)` reads it for `ui.block`'s `collapsed`, `onToggle` writes it back.

## Amendment: case-blind comparisons, non-empty texts, commas, text sort keys, source caps (#404, #405)

`equals` and `in` take `ignoreCase`; `exists` takes `nonEmpty` (an empty text is nothing too); the placeholder filter
`|join` joins a list with ", " in every language (`|list` follows the UI language); `|firstLine` is the first line that
is not blank, trimmed; a text column case's `value` may be a text with the text's placeholders, the reason a row sorts
by; a rule's `source.maxObjects` (1 to 20 000) replaces the 5000 Sextant watches for its rules.

## Amendment: any item through a list, filter chains, clipping, a missing sort key (#404)

A match step's field with dots reaches through a list on the way, and any of its items will do
(`[tasks.state="FAILED"]` is a connector with a failed task); a placeholder takes up to two filters in a row, and
`clip:<n>` (1 to 1000) cuts the text to `n` characters with "…" (`{{.trace|firstLine|clip:300}}`); a text sort key
whose placeholder has no value gives the row no sort value, so it sorts last in both directions, as a missing value does.
A `list` column with `joinPaths` shows every path's items in order, each once (a listener declared and one only in the
status), not the first path's; `exists.nonEmpty` takes a blank text for nothing too.
A text column with `filterBy: "value"` filters by its cases' `value`s (a state's name in every language) instead of the
translated texts shown; a case's text may be empty (a blank cell, nothing to translate) that still sorts by its
`value`; the placeholder filter `|keys` names a map's keys (a SecretStore's provider, the one key of `spec.provider`).
A `list` column's `items` write each item of its lists (named by `paths` without `*`) by the first of up to 10 cases
that holds on the item, its paths read from the item, joined by `separator` (1 to 5 characters) or the UI language's
list; an item none holds for is left out (Knative's traffic: "a-1 80% · latest 20%"). `count` and `sum` columns filter as
numbers; a hover keeps up to 1000 characters where a cell keeps 200.
A placeholder may try up to 4 paths in turn, `{{.message ?? .reason}}`, the first whose value is there and not an empty
text (its filters apply to that one; `??` and `+` do not mix); a `filterBy: "value"` column whose sort key has no value
leaves nothing to filter by.
One list keeps its repeated items (two traffic targets of one revision); only `joinPaths` names each item once; a list
column without hover paths of its own hovers its whole text.
The text condition `endsWith` joins `contains` and `startsWith` (a phase `…PartiallyFailed`); a case's text `value` on a
`number`, `count` or `sum` column is filled and read as a number, so an error count coloured by its case sorts and
filters as the count.
The last path a placeholder tries may be a literal, a number or a short text in double quotes (`{{.status.updated ?? 0}}`,
`{{.value ?? "*"}}`); an extension's section counter counts a problem about another object (`about`) as that object, once.
A rule's message may go by plural form: `pluralBy` names the number (a numeric path, `|count`/`|sum` allowed) and
`messageForms` the forms besides `other`, which stays `message`; the window picks the form the UI language's CLDR rules
give, and a translation gives every form its language needs (`problems.<id>.messageForms.<form>`) with the English
message's placeholders. A list column's item texts are translated as the other texts are.
`stamp` and `notifyAgainOn` paths may end in `|sum`/`|count`; `|unique` names each text of a list once, sorted by code
point; `[<field]` ranks by a nested field too (`[<timestamp.seconds]`); a `list` or `entries` column's `separator`
joins its texts in every language alike (", " where a built-in view did).
The placeholder filter `after:<marker>` (1 to 20 characters) keeps the text after the marker's last place and nothing
when the marker is not there (`Kind=` of a composed job's group, version and kind).
From `sextantApi` 4 a rule's `missing` may look up a core Secret by name: the window lists Secrets for rules
metadata-only, never a value, as the built-in Sealed Secrets view did (ADR-0109); `related` still never names a Secret.
The condition `selectsNone` (top level only, like `related`) holds where the label selector at `selector` picks no
object of `kind` in the namespaces it covers — every one where `anyNamespacesPath` is `true`, the names at
`namespacesPath`, else the judged object's own — judged on the rows of that kind, which then keep every label (at most
64); a list not read in full or not watching those namespaces cannot tell (a ServiceMonitor that selects no Service).
Columns gain the formats `cpu` ("250m", "4") and `bytes` ("250MiB"), sorted and filtered by the amount, and `dateTime`
(a date and time in the UI language).
The condition `relatedBy` (top level only) holds where an object of `kind` in the judged object's namespace holds, for
each of up to 4 `pairs`, the judged object's text at `ours` at its own `theirs`, and its `when` (an HPA on a VPA's
target, whatever the HPA is called); the rows of that kind keep those texts. A kind only looked up by name or labels
(`missing`, `selectsNone`) is listed metadata-only. A kind's "Only problems" takes the problems of rules judged across
objects from the problems store, judged with the other objects' rows, instead of the object alone.
Placeholders gain `|product` (paths multiplied with ` * `, a missing one counting as 1: replicas times shards),
`|countAll` (the items of the lists in a list: a PrometheusRule's rules over its groups) and `|selector` (a label
selector as the built-in views wrote one, labels first, each part in the object's order: `app=web,tier in (a,b)`).
From `sextantApi` 4 an extension has up to 40 problem rules (a section counter counts up to 40), and a match step takes
up to 12 pairs, enough for "the first False condition but these types" (Cluster API).
A path may hold two lists (`[*]` twice), the second's items of every first's item read as one flat list (a proxy's
delegations' namespaces); `+` adds counts before `|count` too (a scalar counting 1); a text condition's values may hold
the object's own texts (`{{.metadata.namespace}}/`), a value whose placeholder has none left out.
A rule's `toldThroughReferrer` (`path` of a list in objects of the rule's own kind, an item's `namePath` and
`namespacePath`, the referrer's `when`) leaves a problem untold while an object of its kind that names it there,
directly or through others naming each other, holds `when` — an orphaned HTTPProxy under an invalid one, which tells
it; the rows of the kind keep the names they name (at most 200) and the `when` as a fact; rows not read in full cannot
tell, so the problem is not told on its own either.
`missing` may read a list (`path` with `[*]`): each item names an object by `namePath` (the item itself when it is a
text) and `namespacePath`, the items `itemWhen` holds for count, and the condition holds when any of them names an
object that is not there; `namespacePath` also places a single name in another namespace; a rule's message may say
`{{missing}}`, the names not found in the UI language's list (a Traefik route's missing Services and Middlewares).
Paths may end in `|min`/`|max` (the smallest or largest number, or the earliest or latest time of a list), also in
`since`/`sinceOr` (an ImageStream's first failing import); a column case's text may go by plural form (`pluralBy` +
`textForms`, translated form by form as a rule's message); a `list` column may be `sorted` in the UI language's order.
`newestBy` ranks `newestPer`'s newest by a number instead of the creation time (a Build's `openshift.io/build.number`);
`toldThroughReferrer.alsoPaths` (at most 3) name more places a referrer names others, a single object read as a list of
one (an HTTPProxy's `spec.tcpproxy.include`).
From `sextantApi` 4 an extension has up to 60 rules over 30 kinds (a section counter counts up to 60), and `{{missing}}`
names a namespace only when it is not the object's own.
A manifest may hold 512 KiB (256 KiB before): the moved views' texts in 14 languages (Traefik, Knative, Cluster API).
Kubernetes quantities: a compared path may end in `|quantity` (the amount of "64Gi", "500m"), and a placeholder's
`|cpu`/`|bytes` write one as Sextant writes its own ("1500m", "45.9GiB") — a NodePool's usage against its limits.
`expiring` (`sextantApi` 4) holds while the time at a path is no more days away than the user's
`notifications.certExpiryDays` (14 by default), and a problem it gives moves when that setting changes, as Sextant's
own certificate problems do (`expiresAt`, `applyCertExpiryDays`); `olderThan.minutes` may be 0 (expired at once) — a
cert-manager Certificate's `status.notAfter`.
`|daysLeft` (a compared path, a column's `paths`, a placeholder) is the whole days until a time, 0 once it has passed,
and a frame's context carries `certExpiryDays` (the user's warning days, sent again when they change): the
cert-manager extension's "Expires in" column and details warn as Sextant's own did.
`contributes.problemsTitle` (`sextantApi` 4, translated) titles an extension's main problem category, its name when
unset: the cert-manager extension's "Certificates", still the one category agents may be given (ADR-0146).
For the mesh extension's details and request check: `ui.navigate({page, closeDetails: true})` closes the details panel as
Sextant's own "Check a request…" does (without it nothing changes); `ui.revealSection({id})` (details frames only) opens,
scrolls to and focuses a section of the same panel, Sextant's by its id or the extension's own (never another
extension's), as the built-in Linkerd block's "Show request metrics"; `storage.*` with `session: true` keeps data in
memory for this run only, apart from the stored data, under the same 1 MB (a form kept while pages change, never across
a restart). The built-in `revealRequestHealth` now opens a collapsed section too (it clicked the `h3`, not its button).

## Amendment: what the mesh extension's views still lacked

A section counter's `count: "problems"` (`sextantApi` 4; `"objects"`, the default, counts each object once) counts the
active problems themselves, as Sextant's own Istio counter counted its findings (`useExtensionSectionCount`).
The column format `firstPlus` reads a list as `list` does (`items`, `joinPaths`, `sorted`; no `separator`) and shows its
first text and `+N` for the rest, sorted and searched by that text, its hover every text on a line of its own: the
built-in hosts columns. A list column's item case may read a text item as itself, `{{.}}` and a condition's path `.`,
and the column's object as `{{$.<path>}}` (texts only, not conditions; checked as the object's paths by
`check_item_message`/`check_item_condition`); cases that read the item only so may go with `paths` holding `*`
(`.spec.servers[*].hosts[*]`), whose item is then the value the checked path reads. Placeholders gain `|lower` and
`|fqdn:<namespace path>`: a text without a dot, not empty or `*`, completed as Kubernetes' DNS names a Service
(`web` → `web.<namespace>.svc.cluster.local`, trimmed) — exactly what the built-in ServiceEntry hosts did after lower
case, so no Istio knowledge comes into the core; `{{.|lower|fqdn:$.metadata.namespace}}`. A Gateway's hosts are
`{{.|after:/|lower}}` where a host has a `/` (`after:` takes the text after the last `/`, the built-in the first; an
Istio host `namespace/dnsName` has one), each once by `joinPaths: true`. `joinPaths: "keep"` keeps every path's items
with their repeats (a Linkerd identity written both ways, as the built-in did).
The SDK's `ui.button(label, onClick, {icon})` draws one of Sextant's icons before the label, as Sextant's own buttons:
the frame asks the window's local method `ui.icon({name})` → `{svg}` (the host's own markup of `src/components/icons.tsx`,
rendered once per name by `iconSvg`) or `null` for a name outside the set, which then shows no icon; the connected
client hands the kit its `ui.icon` (`sdk/src/icons.ts`).
A frame's context carries `kindsVersion`, a number that moves on whenever the kinds its cluster serves change (a CRD
installed or removed while it shows; `clusterKindsVersion`, compared by the served kinds, not by each discovery), so a
frame reads `kinds` again then, as the built-in views followed discovery; left out before discovery came.

## Amendment: a details section on the kinds of a domain's groups, and the UI kit's checkbox

A details section's kind may be `{"group": "*.<domain>", "kind": "*"}` (`sextantApi` 4; `group_suffix` in
`contributions.rs`, checked alike by `checkDetailsSections`): every kind of a group ending in `.<domain>`, a domain of
custom resource groups (a DNS name with a dot, not `k8s.io` or `kubernetes.io`'s own), never with a `when` (its paths
could not be checked against kinds unknown until shown); any other `*` in a section's kinds is refused. Crossplane's
managed resources of a vendor's providers (`*.upbound.io`) get their block without a frame on every core object. The
UI kit's `ui.checkbox(label, onChange, {checked, disabled, title})` draws Sextant's own checkbox
(`src/components/checkbox.css`, both themes' marks) instead of the browser's: "Only problems" on an extension's page.

## Amendment: every kind of a custom resource group, more definitions than a `kindsFrom` reads, and resizable kit tables

A details section's kind may also be `{"group": "*.*", "kind": "*"}` (`sextantApi` 4; `is_every_custom_group` in
`contributions.rs`, checked alike by `checkDetailsSections`, matched by `underDomain` in the window): every kind of a
custom resource group (`is_custom_group`: a group with a dot, not `k8s.io`, `*.k8s.io` or `*.kubernetes.io`), never
with a `when`. Crossplane's claims, composite resources and managed resources are of groups the XRDs and providers
pick, so no domain names them; the built-in section was registered on kinds of installed APIs, and so is this one —
never on a core object or one of Kubernetes' own groups.
`extension_problem_scopes` marks the definition kind's scope `moreDefinitions` when the cluster holds more objects of it
than the `kindsFrom` reads (`max`; Rust counts them as it lists them in `kinds_from::defined_scopes`), and the window's
source of that kind then counts as truncated (`SourceDef.moreDefinitions`): the category tells it judges a part, as the
built-in Crossplane category did past 20 XRDs.
The UI kit's `ui.table(headers, rows, {label, id, sextant, columns, nowrap})`: with an `id` and the connected client its
columns resize as Sextant's own plain tables do (`ResizableTable`: a handle over each named header's right edge, drag,
double-click for the column's own width, the APG window-splitter keys with one tab stop, `table-layout: fixed` once a
width is set, cut cells with their text as the tooltip), and Sextant keeps the widths: the frame's local method
`ui.setColumnWidth({table, column, width | null})` (ids `[A-Za-z0-9._-]{1,80}`) writes them into
`AppSettings.columnWidths` under `ext:<extension id>:<table id>` with the same caps and pause as Sextant's tables
(`src/extensions/columnWidths.ts`), and every frame of the extension gets its own tables' widths in its context
(`columnWidths`, by table and column) — never another extension's or Sextant's. The handles' names and hint are
Sextant's own words in the UI language (`context.texts.resizeColumn`/`resizeHint`), so no extension translates them.
`nowrap: true` keeps every cell on one line; `nowrap` as a list, one per column, is Sextant's details tables' "words" mode
(`table(id, headers, rows, columns)` in `src/features/details/ui.tsx`): the marked columns stay on one line, the rest wrap
only between words, and a table too wide for its place scrolls sideways. Sextant's own extensions keep the built-in
tables' column positions, so the version-3 migration moves each built-in table's widths (`details:<id>` or its own id)
to the extension's (`moved_details.json` `tables`).
The version-3 migration also carries over what the moved views left in the settings (`settings/moved_details.rs` over
`moved_details.json`): each details block's open or closed choice under the path the built-in view wrote (0.29.2) moves
to the extension's block (`ext:<extension>:<section>/<section>/<block>`), only under the kinds it names where an
extension split one section by kind, in the global bank and each cluster's; and the built-in Crossplane page's widths
(`crossplane.composites`) to `ext:sextant.crossplane:composites`. A choice already kept under the new key wins. The
Argo, Argo CD and Flux extensions draw no collapsible blocks, so theirs have nowhere to go.

## Amendment: a column searched by its values, a list column without its whole-text hover, nested kit blocks

A text column with `cases` may say `searchBy: "value"` (`sextantApi` 4): the table's search finds it by its cases'
`value`s, not the translated words shown, as some built-in columns searched by a state's name (Contour's Status);
`filterBy: "value"` stays the filter's own choice. A `list` or `firstPlus` column with `listTooltip: false` hovers no
text of its own (it hovers its whole text by default), as a built-in cell without a hover (KEDA's Triggers). Both are
checked alike by `check_columns` and `checkColumns`. The UI kit's `block` makes a block inside its content a heading
level deeper (h3, h4, h5), as Sextant's nested details blocks are.

## Amendment: Read on the groups under a domain

`permissions.readGroups` (`sextantApi` 4): entries `*.<domain>` of custom resource groups (`group_domain` in
`permissions.rs` = `isGroupDomainPattern`, at most 10), Read only, in every namespace of the covered clusters, on
every kind whose group ends in `.<domain>`. Cluster API's providers define kinds under `controlplane.`,
`infrastructure.`, `bootstrap.` and `addons.cluster.x-k8s.io` that no list can name in advance, and the built-in view
read any of them with the user's own access; the user chose this over Read on every kind and over the listed kinds.
`decide_extension` allows Read there when the rules do not, `ExtensionPermissions::allowed_namespaces` and
`has_any_permission` (used for list scopes, the kinds an extension sees and its problem scopes) count it, and
`is_within` asks again for a wider domain. The agents' access model (`access.rs`) is unchanged: an agent working
through an extension still gets no more than its own access. The consent screen says it in its own sentence.

## Amendment: Sextant's own certificate view as an extension's details section

A details section may be `certificate: {secretNamePath}` (`sextantApi` 4, a `section`, kinds named one by one, no
`startHidden`; `check_details_sections` = `checkDetailsSections`, the path checked as a rule path of each kind): the
window draws no frame but Sextant's own TLS certificate view (`SecretCertificate` in `src/features/tls/`) of the Secret
whose name the shown object holds at that path, in its namespace, and nothing where it holds none. The certificate is
read and parsed as ADR-0069 says (`tls_certificate_info`, with the user's access, only `tls.crt`/`ca.crt`, values
wiped in Rust), and nothing of the Secret reaches the extension: it names a field, as a link would. The built-in
Traefik view showed a route's TLS Secret this way; the user chose this over leaving it to the Secret's own details.
