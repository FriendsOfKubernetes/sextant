# ADR-0137: Extensions report problems through declarative rules the host evaluates

## Context

Extensions add pages, details sections, columns, actions and backends (ADR-0047–0054, ADR-0131), but cannot report
problems: an extension for an operator (Rook Ceph, #319) has no way to put "the storage cluster is in HEALTH_ERR" on
the Problems page, into the sidebar badge or into a notification. Its frames run only while shown, and running
extension code in the background — a frame kept alive, a backend polled — would cost memory and open a new path for
code the user installed to act while nobody looks (#317).

## Decision

- **A contribution of rules, not code.** `contributes.problems` (`sextantApi` 2) lists rules the window evaluates on
  the problems store's own watches; no extension code runs for them. Sextant accepts `sextantApi` 1 and 2; `problems`
  is refused in a manifest of API 1, so an older Sextant refuses a manifest that has them by its API version.
- **A rule** has an `id`, a `title` (shown as the problem's reason; unique among the rules), one `kind` (`group` +
  `kind`, no version, no wildcard), a condition `when`, an optional `since` (a field holding an RFC 3339 time: when the
  state began), `graceMinutes` (0–1440, default 0), `notify` (default `true`: it may notify; `false`: listed only) and
  a `message` template. At most 20 rules and 10 kinds per extension.
- **Conditions are a fixed tagged set**, as the manifest schema's validator reads unions (`type`): `equals` and `in`
  (a string, number or boolean), `exists` and `absent`, `condition` (an entry of `.status.conditions` by `type`, with
  `status` and optionally `reason`; when the rule has no `since`, the entry's `lastTransitionTime` is when it began),
  `above` and `below` (a number, or a string that reads as one), `olderThan` (a time field more than N minutes ago:
  the problem counts from that moment, so no clock runs in the rules), and `all`/`any` of at most 10 conditions, nested
  at most 3 deep, 20 conditions per rule. Nothing is evaluated as code.
- **Paths are the custom columns' field paths** (ADR-0099: `.a.b`, `[0]`, `["key"]`; no wildcards or filters), read by
  the same grammar in Rust and in the window, so each path names one value and can be judged before it is used: a
  path into a core Secret's `data`/`stringData`, or that is, holds or lies under an inline secret path of the rule's
  kind (ADR-0120), is refused when the manifest is read — in `when`, `since` and the message alike. (The window's
  watches strip Secret values anyway, but not inline secret fields.)
- **Messages are templates of field values only**: at most 300 characters and 5 placeholders `{{<field path>}}`; a
  placeholder shows a string, number or boolean, clipped to 1000 characters (100 before #373: a controller's condition
  message is longer) (anything else shows nothing); the result is cleaned like every other text from the cluster
  (`cleanText`: URI credentials cut) and capped at 1200 characters (an agent gets 300), and
  notifications pass it through `clip`/`inert` as for built-in rules (ADR-0067).
- **Where a rule runs is decided in Rust.** The command `extension_problem_scopes` (window only) gives, for an enabled
  extension and a connected cluster, each kind the user agreed to (below) with the namespaces where the extension's
  granted rules allow Read there (`access::allowed_namespaces` over `granted`, after `clusters.covers`); nowhere means
  the kind is not judged in that cluster. The window opens the problems store's usual watch of the kind, narrowed to
  those namespaces and to the accessible ones (ADR-0124), capped at `MAX_SOURCE_OBJECTS`; nothing read for a rule
  reaches the extension.
- **One category per extension**, `ext:<extension id>`, titled with the extension's name, after the built-in
  categories on the Problems page; on by default, with its own toggle in Settings → Notifications
  (`disabledCategories`). It is not one of `PROBLEM_CATEGORIES`: agents never get it (`get_problems` takes only those,
  and Rust's list is kept equal to them), the fleet cards do not watch it, and the timeline does not correlate it.
- **Consent.** `InstalledExtension.grantedProblems` holds the kinds the user agreed to have judged; the install and
  update consent lists them ("reports problems and sends notifications about …"), and an update that judges a kind
  not agreed to asks again (`asks_within`), like a new backend host. Only rules of agreed kinds run.
- **Lifecycle.** Disabling or removing the extension removes its category, its sources and their problems at once
  (`unregisterExtension`); its notification setting stays in the settings until the category comes back.
- **Not decided here**: cross-object rules, rules computed by extension code (frames or backends — that would change
  ADR-0131's "only the extension's own frames call `backend.call`"), and problems for agents.

## Consequences

- The Rook Ceph extension (#319) can report its health without running in the background.
- The rule language is small on purpose; what it cannot say stays on the extension's own pages. A new condition is a
  schema change (the SDK and Rust read the one schema; `sdk/test/fixtures/manifest-cases.json` holds the shared cases).
- A rule's paths are checked against the inline secret table of the Sextant that reads the manifest: a kind added to
  that table later refuses a manifest that reads its new secret path.

## Amendment (ADR-0168)

"Rules computed by extension code" is decided for backends: a problem judge (`contributes.problemJudges`,
`sextantApi` 4) is the extension's backend deciding facts from the declared fields of the objects of declared kinds,
with no host call and no network; a rule's `judged` condition turns a fact into a problem, with Sextant's texts,
consent, notifications and agents' rules. No frame code runs for problems.

## Amendment: rule kinds read from definitions (`kindsFrom`)

Crossplane's claim and composite kinds are known only from its CompositeResourceDefinitions at run time, so a rule
cannot name them. From `sextantApi` 4 a rule may give, instead of `kind`,
`"kindsFrom": {"kind": <definition kind>, "groupPath": ".spec.group", "kindPaths": [".spec.names.kind", ".spec.claimNames.kind"], "max": 20}`
(`kinds_from.rs` = `checkRuleKinds`):
- the paths are keys and indexes only (each names one text), checked as rule paths on the definition kind; 1 to 4
  kind paths; `max` 1 to 20 definitions, the first by namespace and name (the built-in view's "first 20 XRDs");
- every `kindsFrom` of a manifest is the same one; a rule with it judges each object by its own fields: no `missing`,
  `related`, `relatedBy`, `selectsNone`, `judged`, `toldThroughOwner`, `toldThroughReferrer`, `newestPer` or
  `source.fieldSelector` (fields an API server selects by are each kind's own);
- **what the user agrees to**: the definition kind joins the rules' kinds (`problem_kinds`, `grantedProblems`), and the
  `kindsFrom` itself word for word (`InstalledExtension.grantedKindsFrom`, in `asks_within`): the consent says "The
  kinds that objects of <definition kind> define (the API group at …, the kinds at …), read from the first N of them by
  name", in every language. So the rule's kinds stay agreed by the user, as this ADR says, by what decides them;
- **Rust decides the kinds** (`kinds_from::defined_scopes`, from `extension_problem_scopes`): only for an active
  extension whose `kindsFrom` was agreed to, where its granted rules allow Read on the definition kind, Sextant lists
  the definitions itself with the user's connection (the core's `resources::list`, ≤ 500, per namespace when the
  extension may read them only in some, ≤ 100 namespaces), reads the group and kinds at the declared paths of the first
  `max`, and keeps a kind only when its group is a custom resource's (a DNS name with a dot, not `*.k8s.io` or
  `*.kubernetes.io`), its name is a kind's, it has no inline secret field (ADR-0120), the manifest does not name it
  itself and the extension may read it somewhere (`problem_scopes`). A failed list defines nothing. Each such kind
  comes back as a scope with `definedBy` the definition kind; the window never names a kind it judges;
- **the window** compiles the `kindsFrom` rules once, applies them only on sources of `definedBy` scopes the cluster
  serves (`SourceDef.defined`, passed to the detector as `ctx.defined`), one watch per kind through the problems store
  (capped at the rules' `source.maxObjects` or `MAX_SOURCE_OBJECTS`), and gives the definition kind a source of its
  own whose rows keep the `group/kind` texts each definition names; when those change it asks Rust again
  (`REFRESH_DELAY_MS` = 1 s later), the earlier answer standing meanwhile. Section counters (`sectionBadges` by rule
  id) and the problems page count them as any rule's.

Left out: "Only problems" on Sextant's own tables of such kinds (the built-in view had none; the extension's page
filters its own rows), and a permission rule by the same `kindsFrom` — Read in a rule is decided per call by
`decide_extension` against the grant alone, and making it depend on cluster content (a cached, invalidated list of
definitions per cluster and connection on every call, watch and journal line) or adding a kind scope to the access
rules agents share (ADR-0041, strict parsing) is not small; an extension that must read such kinds still asks for Read
on every kind.
