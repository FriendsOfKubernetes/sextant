# ADR-0169: Extension API 5 — what the moved views still lacked after 0.30.0

## Status

Accepted (Sextant 0.30.1)

## Context

Sextant 0.30.0 moved every built-in tool view into Sextant's own extensions (ADR-0162). Each extension's README lists
under "Requirements and limits" where it still differs from the former built-in view because the extension API could
not say it; #417 gathers them. The user asked to close those gaps and ship them in 0.30.1.

A new manifest field needs a new `sextantApi` (ADR-0142): a manifest that names 4 and uses a field 0.30.0 does not know
would install on 0.30.1 and be refused by 0.30.0, and the catalog offers releases by their API (ADR-0149; the bug of
#420). So every addition below is accepted only from `sextantApi` 5 (`PARITY_API` in Rust and the SDK), and Sextant
0.30.1 supports 1 to 5. An extension that uses them is released with `sextantApi` 5; the catalog keeps offering its
API-4 release to 0.30.0 through `earlier`.

## Decision

Each addition is checked alike in Rust and the SDK (`sdk/scripts/manifest.mjs`), with cases in
`sdk/test/fixtures/manifest-cases.json`, evaluated by the window only, and documented in the wiki page "Writing
extensions". "Cannot tell" is never a problem (ADR-0144).

Below `sextantApi` 5 every one of them is refused with "needs sextantApi 5 or later": the fields and conditions where
they are checked, and the path and placeholder syntax by one pass over the raw `contributes` before anything else
(`problems::check_parity_syntax` = `checkParitySyntax`, strings in key order), since paths are checked in many places
that do not know the API. An API-4 manifest means what it meant on 0.30.0: nothing it could say changed meaning, and
the window applies `{{missing}}`'s new reading only to a manifest that names 5 (`AcrossRules.api`).

### A column case asks what the extension's rules say of the row (`problem`)

`{"type": "problem", "state": "found" | "unknown" | "checking"}` (`ProblemCondition::Problem`, `ProblemState`), in a
computed column's `cases[].when` only (`check_case_condition`; anywhere else — a rule, an action's `when`, a list
column's item case, `problemWhen` — it is refused), on a kind one of the extension's rules judges. `found` (the
default): a problem of the extension's categories stands for the row's object, counted or still in its grace, not
one that only counts later or has ended. `checking`: Rust has not said where the rules run, or one of the extension's
sources in the cluster is still listing. `unknown`: the rules cannot tell — `judgeAcross` now reports the uids whose
lookups, referrers or newest-per rows it could not tell (`untold`, kept as `SourceState.untold` by the store's
`publish`), or the row's kind has no source watching its namespace, or that source failed or was capped. The window
(`src/extensions/rowProblems.ts`: `rowProblemState`, `useRowProblemState`) holds the extension's problem sources while
such a column is shown — whatever the opt-in setting of its categories, which decides what the problems screen, the
counter and the notifications show, not what a table of the extension's own may read — as the built-in Traefik view's
store was held by its "References" column. Such a column does not sort and is not searched (its value lives outside the
object, as the built-in's), and filters through an observer that holds the same sources. It reads nothing an agent
or another extension could not: the problems are the extension's own, in its own window.

### `|positions`

A placeholder filter: the 1-based places of the matches of a path's last step (`[…,*]`, the only list step of the
path) in its list, each once, ascending, in the UI language's list (`positionsOf`); paths joined with `+` give the
union. Nothing when no path reads a list, an empty text when nothing matches. It numbers the routes Traefik skips,
as the built-in message did ("Traefik skips its routes 1, 3: …").

### Match fields compared trimmed (`[field~="…"]`)

A match step's field may end in `~` (before an optional `!`): the entry's text trimmed of white space is compared
with the value trimmed, and a field that leads nowhere, `null`, an empty list or a text on the way reads as `""` — as
Go reads a struct's string field and Traefik trims a rule (`[match~=""]` a blank or missing rule, `[match~!=""]` one
with text). Rust's `pair_fits` (`trimmed_fits`) and the window's `pairsFit` (`trimmedFits`) agree, and so does every
reader of the grammar (custom columns, agents' `fields`), since a field with `~` did not parse before.

### `missing` looked up in more kinds (`alsoKinds`)

1 to 3 kinds after `kind`: the name is missing only when none of them that the cluster serves has it, and a kind the
cluster does not serve has no objects (as an `optional` judge read, ADR-0168 amendment); a served kind whose list
cannot tell makes the lookup "cannot tell". So a Traefik target is found in either of Traefik's groups, as the
built-in view looked (`exists` in `traefik.io` where served, else `traefik.containo.us`, and a `traefik.io` object's
target only in the old group "legacy only", open), and a target kind neither group serves is missing, as the built-in
called it. The kinds count among the rules' kinds, are agreed to with them (`problem_kinds`), get sources, are
narrowed together and are what an agent must be able to read (`lookupRefs`).

### Lists three deep, and the namespace of the object holding a list

A path may list three times (`MAX_LISTS`; four are refused): a route's services' middlewares. A `missing` over a list
gets `namespaceWhen` (the item's `namespacePath` counts only where it holds of the item: another provider's service
names a namespace Traefik does not use) and `enclosingNamespacePath` with `enclosingNamespaceWhen` (where the item
names none, the namespace of the object holding the list — what the path before the list's field reads, for a path
ending in `.<field>[*]` (`heldItems`) — where that condition holds of it). Order: the item's, else the holder's, else
the object's own, as Traefik's `serviceRefs` resolves a load balancer's middlewares and transport. Both conditions read
only their object, no time.

### 100 rules

From `sextantApi` 5 an extension has up to 100 rules (`MAX_RULES_5`, the schema's `maxItems`); the 30 kinds stay.
Traefik's references of both groups take 72.

### `{{missing}}` names a single reference too

From `sextantApi` 5 a rule's `{{missing}}` names what a `missing` of one name did not find as well, with its
namespace where it is not the object's own (a TLS option of another namespace), before the names of its lists. Below
5 it keeps naming lists only.

### Who selects an object (`selectedByNone`, `selectsNone.selectedBy`, `namedOnly`)

The built-in Prometheus Operator category warned of a ServiceMonitor or PodMonitor no Prometheus picks up
(`NotPickedUp`) and judged "selects nothing" where the Prometheuses that pick a monitor up make it look. A rule could
ask only the reverse (`selectsNone`: the judged object's selector picks nothing), and `relatedBy` joins equal texts in
the judged object's namespace. Two additions, read as Prometheus Operator reads its selectors — the field documentation
of `CommonPrometheusFields` (`pkg/apis/monitoring/v1/prometheus_types.go`): a null `serviceMonitorSelector` selects
nothing and an empty one everything; a null `serviceMonitorNamespaceSelector` (the default) covers the Prometheus' own
namespace only, an empty one every namespace, any other the namespaces whose labels it matches; and
`ignoreNamespaceSelectors` makes the selected monitors look in their own namespace only
(`getNamespacesFromNamespaceSelector`, `pkg/prometheus/promcfg.go`). The same null/empty reading is
`metav1.LabelSelectorAsSelector`'s for any Kubernetes label selector, so nothing in them is the operator's own.

- **`selectedByNone`** `{kind, alsoKinds?, selector, namespaceSelector}`: no object of `kind` (or of the 1 to 3
  `alsoKinds`; a kind the cluster does not serve has no objects) has a label selector at `selector` matching the judged
  object's labels with a namespace selector at `namespaceSelector` covering its namespace. With no object of those
  kinds at all it does not hold: the built-in did not judge then (the monitor may be meant for another collector).
  Cannot tell — so no problem, and `untold` for a `problem` case — while a list of those kinds is not read in full or
  not of every namespace (an object anywhere may select), or a namespace selector with terms needs the Namespaces'
  labels and their list cannot tell; one object that selects is enough to say no.
- **`selectsNone.selectedBy`** `{kind, alsoKinds?, selector, namespaceSelector, ownNamespaceWhen}`: the objects that
  select the judged one, read alike, narrow where its selector looks — where `ownNamespaceWhen` (reading only that
  object, no time) holds for every one of them, in its own namespace only; for some, in its own too; when they cannot
  tell or none selects it, as written — as the built-in `targetNamespaces(monitor, pickedBy)`.
- **`selectsNone.namedOnly`**: a selector that (after `selectedBy`) still looks in every namespace is not judged and
  widens no `narrowLookups` list, as the built-in never judged a monitor of every namespace; before, an API-4 rule could
  only leave such a monitor out by its own fields (`not any`), which also left out one its Prometheuses narrow.

Both are problem rules' conditions only, never inside `any` or `not`. The selecting kinds and the Namespaces (metadata
only, for their labels) are looked-up kinds: they count among the rules' kinds, are agreed to (`problem_kinds`), get
sources (the selecting kinds whole, their rows keeping the selectors by path, `AcrossRow.selectors`, and the
`ownNamespaceWhen` fact), and are what an agent must be able to read everywhere (`lookupRefs`). A narrowed lookup kind's
list also covers the judged object's own namespace when `selectedBy` may make it look there.

### `{{selectsNone:namespaces}}`

A rule message's placeholder for the namespaces its `selectsNone` looked in, sorted, in the UI language's list: after
`selectedBy` they are not what the object's fields say, and the built-in message named them. Only in a rule with a
`selectsNone`. No field path reads like it (`:` is no name character), so it meant nothing in an API-4 manifest.

### A kind's "Only problems" from some of its rules (`problemRules`)

A listed kind's `problemRules` (1 to 100 ids of the extension's rules of that kind; not with `problemWhen`): its table's
"Only problems" shows the objects with an active problem of those rules only. The built-in monitor tables showed the
monitors that select nothing, not those no Prometheus picks up. (The section counter already takes `rules`.)

### `|uniqueKey`

A placeholder filter for a sort key: a list's texts each once, empty ones left out, sorted by code point, joined with
`,` in every language, as a built-in view keyed a list of names (the monitors' Namespaces column sorted and filtered by
`names.join(",")`); `|unique` writes the shown text in the UI language's list, which sorts otherwise.

### A map's entries as a list column's items (`items` on `format: "entries"`, `items.with`)

The built-in Karpenter column wrote every limited resource of a NodePool with what is in use against its limit
(`cpu 3920m/4, memory 45.9GiB/1000GiB`). An entries column could write only `key=value`, and a case's text names fixed
paths, so the extension wrote nine fixed sets of limits. From `sextantApi` 5 an `entries` column may have `items`: each
entry of the map, in key order, is the item `{key, value}`, written by the first of its cases holding on it, as a list
column's items are (an entry none holds for is left out; `items.separator`, else the column's, else the UI language's
list). `items.with` (1 to 3 names, a lower-case letter then letters and digits, not `key` or `value`) names more maps of
the object, field paths without `*` checked as the column's: the value each holds at the entry's key is the item's
field of that name (`{"used": ".status.resources"}` → `{{.used}}`), absent where it has none. Item paths are checked
as a list column's items' are: the map path reads no secret, so neither does an entry. `items.with` on any other format
is refused.

### A case toning the cell's own text (`{{value}}`)

The built-in column was red as a whole when any limit was reached, and an extension's tone comes from a case, whose text
replaces the cell's. From `sextantApi` 5 a computed column case's `text` may hold `{{value}}`: the text the cell shows
when no case holds. It is put in after the rest of the case's text is filled, so cluster text in it is never read as a
placeholder, and a case whose cell has no text does not hold. (`valueText` keeps its own `{{value}}`; anywhere else
`{{value}}` stays no placeholder.)

### `atLeast` over every key of two maps (`eachKey`)

The built-in "Only problems" compared every limited resource with what is in use; a rule could compare only named
paths. With `eachKey: true` an `atLeast`'s `path` and `otherPath` name maps (without `*`), a filter ending a path
(`|quantity`) reading each value: it holds when, for any key both maps have, the value at `path` is at least the one at
`otherPath` plus `offset`. A key on one side only, or a value that is no number on either side, compares nothing — it
never makes a problem. Not with `addPaths`. It reads only the object, so it goes anywhere an `atLeast` goes (rules,
`problemWhen`, cases, item cases).

### `|quantity` in a text

A placeholder filter: a Kubernetes quantity's amount as a number in the UI language, a whole one without fraction
digits, any other with two, without grouping (`1k` → `1000`, `1500m` → `1.50`) — as the built-in Karpenter column wrote
a resource that is neither cpu nor memory nor storage. Before 5 a text could not have it (a compared path's
`|quantity` reads the amount as before).

## Consequences

- Sextant's own extensions that use these additions need Sextant 0.30.1; on 0.30.0 they stay at their API-4 releases.
- Traefik 1.1.0 (`sextantApi` 5) uses all of them: the References column, every reference of both groups judged where
  Traefik looks, the skipped routes numbered. What stays different from the built-in view is in its README: one
  problem per kind of reference and place; "References found" for a reference into another namespace, another
  provider's object or a target only in the old group, which the built-in called "Not all checked" (the column tells
  what the rules say, and the rules judge those found); unknown service kinds, which Traefik's CRDs refuse; `|keys`
  for a Middleware's one key; `(containo.us)` in rule titles; and the Secrets grant, which cannot say "metadata only"
  without a new permission action.
- A table column of an extension can now make the window hold its problem sources while it is shown, even with an
  opt-in category off: the sources are bounded as the category's own (ADR-0144) and released 5 s after the table.
- Prometheus Operator 1.1.0 (`sextantApi` 5) uses `selectedByNone`, `selectsNone.selectedBy`/`namedOnly`,
  `{{selectsNone:namespaces}}`, `problemRules` and `|uniqueKey`: monitors not picked up are a listed, not notified,
  problem again, "selects nothing" is judged where the Prometheuses make a monitor look, and the Rules and Namespaces
  columns count and sort as the built-in (the Rules count needed no addition: `[alert!="",*].alert` reads only a
  present name). What stays different is in its README: past 40 namespaces it lists the Services or Pods everywhere
  the extension may read (the built-in judged nothing then), and an endpoint without any port leaves no empty item.
- Karpenter 1.1.0 (`sextantApi` 5) uses an entries column's items with `with`, `{{value}}`, `eachKey` and `|quantity`:
  Usage / limits writes every limited resource as the built-in column did and is red when one is reached, and "Only
  problems" compares every limited resource. Its README lists no difference left; the resources are written in key
  order, as the API server writes the map.
