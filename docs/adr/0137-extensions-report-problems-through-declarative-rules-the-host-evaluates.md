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
  placeholder shows a string, number or boolean, clipped to 100 characters (anything else shows nothing); the result is
  cleaned like every other text from the cluster (`cleanText`: URI credentials cut) and capped at 300 characters, and
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
