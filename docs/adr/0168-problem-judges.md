# ADR-0168: An extension's backend decides problems that rules cannot say

## Context

Problem rules are declarative and evaluated by the window, and no extension code runs for them (ADR-0137); rules across
objects look other objects up by name, labels or matching fields (ADR-0144, ADR-0167). Moving Sextant's built-in Istio
view into the mesh extension (`extensions/mesh`) leaves five of its problems that no such rule can say:
`UnknownHost`, `MissingDestinationRule`, `MissingSubset`, `TlsConflict` and `ConflictingVirtualService`
(`src/features/mesh/problems.ts`, `istio.ts`). They resolve a host as Istio does — wildcards, short names completed
with the namespace and `cluster.local`, `exportTo` — pick a DestinationRule by Istio's lookup order, weigh
PeerAuthentication by its precedence and keep the oldest of conflicting objects. A rule language able to say that
would be a programming language; teaching the core Istio's resolution would keep Istio knowledge in the core that
ADR-0162 moves out. The user decided that the extension's WebAssembly backend (ADR-0131) computes them.

## Decision

- **A judge is declared, the backend only decides.** `contributes.problemJudges` (`sextantApi` 4, needs a `backend`):
  each judge is `{id, reads: [{kind, paths}], facts: [{id, values?}]}` — at most 5 judges, 10 kinds a judge, 40 paths a
  kind, 20 facts a judge and 5 value names a fact. Paths are the rules' field paths and are refused exactly as a
  rule's are when they read a core Secret's values or are, hold or lie under an inline secret field of the kind
  (`check_rule_path`, `reads_secret`, ADR-0120); a core Secret is never read by a judge at all. A judge no rule uses is
  refused, and the rules of one judge belong to one problem category (it runs once per cluster).
- **A rule turns a fact into a problem.** The condition `{"type": "judged", "judge", "fact"}` holds on an object when
  the judge's latest answer gives that fact for the object's uid; its rule's kind is one the judge reads. It may stand
  beside other conditions in `all`, but not inside `any` or `not` (as `missing`, `related` and `selectsNone`): a judge
  that cannot tell must never make a rule hold. The message may show a fact's texts as `{{fact:<name>}}`, a name the
  fact declares; texts are cleaned (`clean_text`/`cleanText`, control characters out) and clipped to 1000 characters
  like other placeholder values, and a text the answer does not give shows nothing. Titles, messages, translations
  (`translations.rs`/`translatableTexts`: no new text field), notifications, counters, "Only problems" and the
  problems page are Sextant's, as for every rule.
- **What the backend gets.** For each object of a read kind, `{apiVersion, kind, metadata: {name, namespace?, uid,
  creationTimestamp?}, values: {<declared path>: <value there>}}`, a path that leads nowhere left out. No other
  metadata goes: labels and annotations only as the values of paths that name them (`.metadata.labels`). The
  window keeps of those kinds only these values, in the rows of the problems store's own sources (the tap of
  `judgeAcross`, no second watch); a kind read only for a judge whose paths are all under `.metadata` is watched
  metadata-only.
- **Running it.** The window-only command `extension_problem_judge(id, judge, clusterId, objects)` checks in Rust that
  the extension is active, the judge declared and its kinds agreed to (`grantedProblems`), and re-projects every object
  (`problem_judges::project_objects`): a kind the judge reads, a namespace within that kind's `extension_problem_scopes`
  (an object without a namespace only where the kind may be read everywhere), name/namespace/uid/creation time and
  the declared paths only — a path reading secret material is dropped again (`without_inline_secrets` has nothing
  to hide in a map of declared values; the path check is its equivalent here), at most 5000 objects a kind and 8 MiB.
  It then calls the backend's `handle("problemJudge:<id>", {"objects": [...]})` (`ExtensionApi::problem_judge`) with
  every host call — `credentials.get` included — and every network request refused (`BackendHost.judging`), 10 s
  (`JUDGE_TIME`) and room for the payload (`judge_limits`). The answer `[{uid, fact, values?}]` is read back by
  `problem_judges::read_answer`: at most 2000 facts or the answer is refused, a uid among those sent, a declared fact,
  only the fact's value names, texts cleaned and clipped, one fact per object and id; anything else is left out and
  counted in the backend's log. No line in the activity log per call, as rules are not journaled; a failure goes to
  the backend's log by its error code only, never with object content. It is never an MCP tool nor an extension method
  (`problem_judges_are_neither_an_agent_tool_nor_an_extension_method`).
- **When the window asks** (`src/extensions/problemJudges.ts`, one runner per cluster × extension × judge): when the
  objects it would send change, at most once per 5 s and never two calls at once; a failed call is tried again with the
  same objects after a minute. It cannot tell — so the judge's rules give no problem — while any read list is not read
  in full (loading, failed, capped, not served or not readable there), holds more than 5000 objects or more than 8 MiB,
  and after a failed or timed-out call: an earlier answer is never kept past a failure. A new answer makes the
  category's sources look again (`onJudgeAnswer` in the problems store); a reconnect forgets the cluster's answers.
- **Consent.** The kinds a judge reads are agreed to with the rules' kinds (`problem_kinds` includes them, so
  `grantedProblems` and "asks for more" cover them); the consent screen lists, under the rules, the kinds and fields the
  backend gets and says that its code runs for them, in every language. The judge sees nothing the extension could
  not read itself: the namespaces are those its Read rules allow.
- **Agents.** `get_problems` with `ext:<id>` (ADR-0146) gives a problem a judge decided only when the agent may read
  every kind the judge read in every namespace its source watched (`lookupRefs` names them, Rust re-checks them as
  every ref); otherwise the window leaves it out and names its category in `notJudged`, with `notJudgedNote`.
- **SDK.** `defineBackend(handlers, { problemJudges: { <id>: (objects) => facts } })` answers `problemJudge:<id>`;
  `JudgedObject`/`JudgedFact` are generated from Rust. `sdk/examples/backend-ts` has a judge (Services of a namespace
  selecting the same pods), run by `npm run sdk:check` through the runtime's stand-in host.

## Why not frame code

A frame runs only while shown; problems and notifications must be judged while nobody looks (ADR-0137), and a frame
kept alive in the background would cost memory and could act with the extension's whole grant. A judge is a pure
function in the backend's sandbox, called by Sextant with only the declared fields and no way out.

## Why not Istio knowledge in the core

The core keeps no view of a tool whose view moved out (ADR-0162); host resolution, lookup order and precedence are
Istio's and change with Istio. In the extension they move with its releases, and every other extension can decide what
rules cannot say the same way.

## Consequences

- The mesh extension can keep every built-in Istio problem unchanged, with Sextant's texts and notifications.
- Extension code now runs for problems, but only as a judge: declared kinds and fields, no host call, no network, no
  activity line, 10 s. A misbehaving judge can only fail to tell (and, like any failing backend, be paused after three
  traps or timeouts in a row until reloaded, ADR-0131).
- `problemJudges` is part of `sextantApi` 4 (unreleased at the time): no new API number.
