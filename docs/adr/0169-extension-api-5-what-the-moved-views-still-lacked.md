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

### The one object a `relatedBy` finds (`newest`, `prefer`)

The built-in k3s view judged a HelmChart with its install Job: among the Jobs labelled for the chart in its namespace,
the one `status.jobName` names, else the one helm-controller would name (`helm-install-<name>`, chart.go `jobName`),
else the newest (`jobOfChart`). A `relatedBy` held when any object it found held its `when`. With `newest: true` only one
of the objects its `pairs` find counts, and its `when` decides: the one `prefer` names, else the newest (by
`creationTimestamp`, then name, as `newestPer` ranks). `prefer` (1 to 4, with `newest`) are alternatives tried in order on
the judged object: the first whose `ours` — a field path, or a text with `{{…}}` placeholders of the judged object
(`helm-install-{{.metadata.name}}`), checked as a message — reads a text names the preferred object by `theirs`; one
that reads nothing gives way to the next, a named object that is not there to the newest, as the built-in did. The
`theirs` paths are kept on the rows like the pairs'.

### Lookups that decide nothing (`optional`), and the found object's window, time and fields

The built-in category judged a Failed chart by its own condition whatever its Job said, and took the Job's failure time
and its day from the Job where it had failed — also while the Jobs could not be read. A `related` or `relatedBy` with
`optional: true` (at the top, not in an `any` of lookups) never decides whether the rule holds and is never "cannot
tell": when the object is found and its `when` holds, what it says applies, otherwise the rule holds without it. What
it says, also for a required lookup:

- **Times inside its `when`.** From `sextantApi` 5 a `related`'s or `relatedBy`'s `when` may read `olderThan` (never
  `expiring`, which the user's setting moves while the named object's row stays). The row keeps the verdict's window
  — absolute times, so it stays right as time passes without the object changing — and the problem counts only within
  it (`AcrossRow.windows`, `foundTimes`): `not olderThan(…, 1440)` ends it a day after the Job's failure. Below 5 a
  time is refused there as before.
- **`givesSince: true`**: the problem's time is the found object's — the `lastTransitionTime` of the entry its `when`'s
  `condition` matched — and its start is redated from it (as the store dates one: the time, else first seen, plus the
  grace).
- **`{{related:<path> ?? <path>}}`** in a rule's message (and `messageForms`): a field of the object the rule's first
  `related`/`relatedBy` (in the order written) found, the first path with a text; nothing when none was found. Only in a
  rule with one; the paths are field paths of every such kind, reading no secret, without filters or literals. The rows
  keep those paths' texts. The window marks it in the rendered message by its text in hexadecimal UTF-8 between
  private-use characters (so the cleaning of URIs leaves it alone) and fills it last, cleaned and clipped, so cluster
  text in a value is never read as a placeholder. No field path reads like it, so it meant nothing before 5.

An optional lookup's kind is a looked-up kind like any (agreed to, a source, what an agent must be able to read): a
problem may carry its time or its fields.

### Whether the cluster serves a kind (`served`)

The built-in category judged the bundled components wherever the cluster served k3s Addons. `{"type": "served", "kind"}`
holds while discovery says the cluster serves the kind and cannot tell before it answered; problem rules only, not
inside `any` or `not`. It reads no object: no source, nothing agreed to, nothing an agent must read.

### A text read by a pattern (`fits`)

The built-in view recognised a k3s kubelet by `/\+k3s\d+$/`. `{"type": "fits", "path", "patterns"}` holds when the text
fits one of 1 to 20 patterns (1 to 256 characters, no control characters): `*` any text, `#` one or more ASCII digits,
every other character itself. It is no pattern language: Rust (`fits_pattern`) and the window (`fitsPattern`) walk the
positions a pattern prefix can end at, one step per pattern character, so nothing backtracks. Anywhere a text condition
goes. (`matches` named an unknown condition type in a shared case since API 2, so the name stays free.)

### Whether an inline secret field is there

The built-in view showed its Node section on a node with any of k3s's annotations, `node-args` and `node-env` included,
which no rule path may read (ADR-0123). From `sextantApi` 5 `exists` and `absent` may name exactly one inline secret
field of the kind, by names only (`is_inline_secret_field`): its presence is what the marker of hidden values tells an
extension anyway. Any other condition, a path into the field or through `*`, and every placeholder stay refused.

### `|cut:<n>`

A placeholder filter: the first 1 to 1000 characters without "…", as the built-in Addon column cut a checksum; with a
`clip:` the shorter decides.

### How kinds only looked up are listed (`lookupSources`)

The built-in category listed the charts' Jobs by helm-controller's label, at most 1000; a kind the rules only look up
was listed whole, capped at 5000. `contributes.lookupSources` (1 to 20) gives such a kind — one no rule judges, no
`kindsFrom` reads and no judge reads — a `labelSelector` the API server picks it by, a `maxObjects`, or both, as a
rule's `source` lists its own kind. Only the objects it picks are looked up: an object outside it is "not there".

### Masked copies of inline secret material (`permissions.maskedSecrets`)

The built-in view showed a node's arguments and a chart's values masked; an extension gets them blanked
(`without_inline_secrets`), and a masked view needs Sextant to mask them before they leave it. `permissions.maskedSecrets`
(sextantApi 5) names some of the kinds Sextant can mask — a Node, a HelmChart, a HelmChartConfig, nothing else — and the
consent screen names them; a grant is within another only with these kinds agreed to (`is_within`). For an extension
with the grant, every object it reads of such a kind (`resources.get|getMany|list|watch` and what a patch answers)
carries a masked copy computed in Rust (`sextant_core::resources::masked_secrets`) instead of the empty text:

- a node's `k3s.io/node-args`/`rke2.io/node-args`: read as the window reads them (`src/resources/nodeArgs.ts`) and
  written back as k3s writes them, a flag and its value as one `--flag=value` word, every hidden value — k3s's own
  secret flags, every flag whose name looks secret (`looksSecret`, ported), every `*-arg` flag naming a secret-looking
  setting, k3s's own mask — as `********`, every other value cleaned of URI credentials (`clean_text` = `cleanText`);
- a HelmChart's and HelmChartConfig's `spec.valuesContent`: one YAML mapping (serde_yaml, its repetition limit, ≤ 256
  KiB), every value under a secret-looking key `<hidden>` (its shape kept), every other text cleaned, written as JSON
  text, which YAML reads;
- a HelmChart's `spec.set`: each value as text, `<hidden>` under a key any `.`-part of which looks secret, else cleaned.

Anything that does not read — not k3s's JSON list of texts, not one mapping, a YAML tag, a key that is no text, number
or flag, two keys that read alike, a number JSON cannot hold, too long — is blanked as for any extension, never passed
on. Every other inline secret (a node's `node-env`, a Route's key, …) stays blanked. The copies are computed from the
object as read, then the object is blanked as before and only the copies go back, so the raw value never leaves Rust;
`sextant.dev/values-hidden` still names every path that held something (a copy is never saved over the real object) and
`sextant.dev/values-masked` names the masked ones. The extension's watches share one core watch with other frames only
under a key that says masked. Never for an agent: an agent tool's call through the extension's backend (ADR-0159) gets
the fields blanked; agents, the timeline and every other path are untouched. The rules are shared as cases
(`src/resources/masking-cases.json`) that Rust, the window's `nodeArgs` and the k3s extension's `mask.ts` each pass —
what Sextant gives reads, in the window's and the extension's rules, as the original does.

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
- k3s / RKE2 1.1.0 (`sextantApi` 5) uses all of them: a node's arguments and a chart's values shown masked again, the
  chart's problems judged on the chart with its install Job found as the built-in found it (`newest`, `prefer`), its
  message, time and day as the built-in category gave them (`optional`, `givesSince`, `{{related:…}}`, times inside a
  `relatedBy`), also while its Jobs cannot be read, those Jobs listed by helm-controller's label (`lookupSources`), the
  components judged where Addons are served (`served`), the Node section on k3s's kubelet versions (`fits`) and on a node
  whose only sign is its `node-args` or `node-env` annotation, and the Checksum cut silently (`|cut`). (Its Size column
  needed no addition: a case on `|quantity` writes it as the built-in did.) What stays different is in its README: the
  ServiceLB Services read in one call, agents' choice of the category, and a values text Sextant reads more strictly.
- An extension can now see masked copies of some inline secret fields, only where the user agreed to it on the consent
  screen; the masking is Rust's, fails closed, and never reaches an agent.
