# ADR-0172: Extension API 6 — the last gaps of the moved views

## Status

Accepted (Sextant 0.30.5)

## Context

After Sextant 0.30.3, #417 still listed nine things the moved views did that the extension API could not say. Each
extension's README listed them under "Requirements and limits": KubeRay's Workers and failed Serve application,
Knative's Traffic sort and Trigger filters, External Secrets' Last sync order, KServe's Canary %, Strimzi's
auto-restart edge cases, VPA's several HPAs, and Cluster API's problems of a paused Cluster's objects. The user asked
to close them, so that the moved views keep every function unchanged.

A new manifest field needs a new `sextantApi` (ADR-0142), so every addition below is accepted only from `sextantApi` 6
(`GAPS_API` in Rust and the SDK). Sextant 0.30.5 supports 1 to 6. The catalog keeps offering each extension's earlier
release to 0.30.0–0.30.4 through `earlier` (ADR-0149).

## Decision

Each addition is checked alike in Rust and the SDK (`sdk/scripts/manifest.mjs`), with cases in
`sdk/test/fixtures/manifest-cases.json`, and evaluated by the window only. "Cannot tell" is still never a problem
(ADR-0144), except where `unless` says what not telling means. Below `sextantApi` 6 the new path and placeholder syntax
is refused by the same pass over the raw `contributes` as API 5's (`check_parity_syntax` = `checkParitySyntax`). That
pass now reports the first use the manifest's own API lacks, so an API-5 manifest that uses an API-5 path step and an
API-6 one is still refused.

### `|sumOf:` — a list's items, each adding the product of its factors

`{{.spec.workerGroupSpecs[suspend!="true",*]|sumOf:.replicas ?? .minReplicas ?? 0 * .numOfHosts>0 ?? 1}}`.
- The path's last step, and no other, lists the items.
- The argument has 1 to 4 factors joined by ` * `. Each factor has 1 to 4 alternatives joined by ` ?? `: an item path,
  or a number (never a text).
- An alternative counts when it reads a number. `>0` after a path counts only a positive one: the built-in
  `numOfHosts || 1`.
- An item with a factor none of whose alternatives reads a number adds nothing.
- Without a list there is nothing, and an empty list is `0`.

It stands alone after one path, with no other filter. Rust parses it (`sum_of_factors`) and checks the joined path
(list plus item path) for secrets like any placeholder path. The window computes it (`placeholderText`). It writes
KubeRay's Workers without `status.desiredWorkerReplicas` as the built-in column did.

### An item case's `value`

A list column's item case may have `value`: a text with the item's placeholders. It replaces the item's text in the
column's value, which the column sorts by, and which it filters and searches by with `filterBy`/`searchBy: "value"`.
Those two now also go on a list column whose items have a `value`. The shown text stays the case's `text`. Knative's
Traffic sorts, filters and searches with the latest revision's share and no word, as the built-in value
`trafficSummary(o, "")` did.

### Judges a computed column asks

From `sextantApi` 6 a computed column's case may hold `{"type": "judged", "judge", "fact"}` (not inside `any` or `not`,
no `each`), on a kind the judge reads. Its `text` and `tooltip` may show `{{fact:<name>}}` of that fact's values,
put in last, so cluster text in them is never read as a placeholder.
- A case whose judge gives no fact for the row, or cannot tell, does not hold.
- A judge only columns ask is allowed. It runs with the extension's main problem category, which must have a rule.
  Its read kinds get the category's sources and a tap (`registerExtensionProblems`' `columnJudges`).
- The column holds the extension's problem sources while it is drawn and while a filter needs it, as a `problem`
  column does. It reads the answer by the row's uid in whichever cluster's runner has it (`judgedFactAnywhere`), so
  it still sorts and searches.
- Everything else is ADR-0168's: declared paths only, Rust's re-projection, the sandbox with every host call refused,
  consent, caps, and no MCP tool or extension method.

The rest was a tree no case can write: several dialects, attributes and nested `all`/`any`/`not` of a Knative
Trigger's filters. The user chose this over a declarative recursion: the built-in `filterText` is ported unchanged
into Knative's new backend (`extensions/knative/backend/main.ts` over `src/judges.ts`). The cost is a component of
about 12 MB in the package, like the other extensions with a backend.

### `sortAs: "time"` on an age column

The column sorts by the time itself, the oldest first, as a built-in column sorted its timestamp. Its age filter and
search are unchanged. External Secrets' Last sync.

### A blank case (`blank: true`)

While the case holds, the cell has no value: it shows nothing, sorts last and filters as nothing. Its `text` is `""`,
and it has no `value`, `tone` or `pluralBy`. Before, an empty text was a text and sorted first. It lets KServe's
Canary % be a `sum` column, sorted and filtered as a number, and blank without a split.

### A match of several values, and by name

- `[status=("DEPLOY_FAILED","UNHEALTHY")]` matches any of 1 to 12 quoted values; `!=(…)` matches none of them, and
  `~` compares them trimmed.
  - Rust and the window keep the values in the one value text, joined by a quote, which a value never holds
    (`ALTERNATIVES`).
  - The window writes them back as written (`formatFieldPath`).
- A last part `^` takes, of a map's matching values, the first in the order of their keys by name. A list keeps its
  order.
  - The window orders by the UI language's collation, as the built-in view sorted a RayService's applications.
  - Rust orders by Unicode lower case, then as written (`PathStep::by_name`). Rust reads it only for agents' own
    `fields`, never for an extension's texts.

Both are in the shared grammar of custom columns too (`settings/custom_columns.rs` = `path.ts`), since they did not
parse before. KubeRay's failed Serve application is the first that failed, by name.

### A compared path's default (` ?? <literal>`)

The paths of `equals`, `in`, `above`, `below`, `same` and `atLeast` (`numeric_path` = `numericPath`) may end in
` ?? <number or "text">`. The condition reads the literal where the path holds nothing or `null`. That is how Strimzi
reads a missing restart count as 0 and a missing `maxRestarts` as 7.

### `isTime`

`{"type": "isTime", "path"}` holds when the text at the path reads as a time, as `olderThan` reads one. With it,
Strimzi's restart time that is there but no time gets one reconciliation's grace, as the built-in view gave it.

### `related` and `relatedBy` with `unless`

The rule holds unless the named object is found and its `when` holds. It also holds while the object is not there,
its list cannot tell, or nothing is named.
- It goes at the top of a rule only, and not with `optional`, `givesSince` or `newest`.
- An agent's `lookupRefs` still name the kind, since the problem rests on it.
- In Cluster API, a Machine's or KubeadmControlPlane's problem stands unless its Cluster is read paused, as the
  built-in view kept it while it could not read the Cluster. One rule now covers a Cluster that is there, not there
  or not named, so twelve rules go (39 → 27).

### `relatedBy` with `each`

The rule gives one problem for each object the pairs find with its `when` holding.
- Each problem's key and notification key carry that object (`namespace/name`), and its `{{found}}` names it alone.
- It goes at the top of a rule only, and not with `optional`, `givesSince`, `newest` or `unless`.

VPA tells each fighting HPA apart, as the built-in problem did.

## Consequences

- Sextant 0.30.5 releases KubeRay 1.1.0, Knative 1.2.0, External Secrets 1.1.0, KServe 1.1.0, Strimzi 1.1.0, VPA 1.1.0
  and Cluster API 1.1.0 (`sextantApi` 6). 0.30.0–0.30.4 keep their earlier releases.
  - Their READMEs no longer list the nine differences of #417.
  - Each test compares the manifest's columns and rules with the built-in reading on new edge fixtures:
    - KubeRay: multi-host groups and groups without `replicas`; applications without a status, and names in mixed case.
    - Strimzi: every restart count, maximum, a missing count and an unreadable time.
    - VPA: two HPAs on one target.
    - Cluster API: a paused Cluster, and its list not read.
    - Knative: every filter shape, the judge against `filterText`.
- Knative now has a backend: installing or updating 1.2.0 asks for consent to it.
- What stays different is still listed in each README. Each one is a cap Sextant keeps on purpose, or something that
  cannot occur in practice. VPA's README also lists differences #417 never named: a scaled-to-zero target, a target's
  group, per-container metrics with policies, empty `controlledResources`, and custom target kinds.
- A Cluster API problem may notify once more after the update: the rules that held for a Cluster not there are gone,
  and their objects' problems are now told by the remaining rule's id.
