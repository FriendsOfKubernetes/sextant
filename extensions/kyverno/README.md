# Kyverno

Read-only views of [Kyverno](https://kyverno.io) policies and policy reports (`kyverno.io`, `wgpolicyk8s.io`,
`reports.kyverno.io`), in every language Sextant has. It lists ClusterPolicies, Policies, PolicyReports,
ClusterPolicyReports and Kyverno's ephemeral reports in a sidebar section of their own with Sextant's tables; tells a
policy's readiness, mode (Enforce or Audit, per rule since Kyverno 1.13), background scans and rules, and sums up its
results over the reports that carry its label with the objects that fail it; shows a report's object and results; and
adds "Policy results" to the details of every other object, read from the one report Kyverno names after the object's
uid. Objects that fail policy rules are problems of an opt-in category. It replaces Sextant's former built-in Kyverno
view (ADR-0101) with the same behaviour; the few places where the extension API cannot say exactly the same are in
"Requirements and limits". Its id is `sextant.kyverno`. Why it is
built this way: ADR-0101 (the readings and problems), ADR-0139 (Sextant's own extensions), ADR-0140 (translations),
ADR-0152 (kinds in a section of their own, `not`), ADR-0153 (computed columns), ADR-0160 (the section's icon and place,
the UI kit), ADR-0161 (printer columns left out, paths picking an item, notification groups), ADR-0163 (field values
in texts, a problem's reason), ADR-0164 (deeper conditions, a case's own number), ADR-0165 (a kind's own "Only
problems") and ADR-0167 (the counter's own label, more rules, every match `*`, problem categories of the extension's
own, a details section on every kind, column widths and sort keys, counts and steps after `[*]` in conditions,
case-blind comparisons, a problem about another object, times in seconds, placeholder filters, untitled details
sections hidden until shown, the shown object's uid, capped watches, details blocks in Sextant's own memory).

## At a glance

| | |
|---|---|
| Id | `sextant.kyverno` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `kyverno-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Kyverno |
| Checked against | Kyverno's own types (`api/kyverno/v1` ClusterPolicy/Policy with rule-level `failureAction`, `api/policyreport/v1alpha2`, `api/reports/v1` ephemeral reports) and the report labels `cpol.kyverno.io/<name>` / `pol.kyverno.io/<name>` |

## What it adds

**A sidebar section "Kyverno"** (`kyverno`), shown while the cluster serves any of its kinds, with the built-in
section's icon and place (after Crossplane): Cluster Policies, Policies, Policy Reports, Cluster Policy Reports,
Ephemeral Reports and Cluster Ephemeral Reports, with Sextant's own table, filters, selection bar and details, and Edit
and Delete as on every kind. The section's counter shows how many objects fail policy rules, only while the opt-in
category below is on.

**"Only problems"**, as the built-in tables had it: policies whose Ready condition is False (else whose older
`status.ready` is false), and reports with a failed or errored result (by their summary, else counted from their
results).

**Columns**, in place of the CRDs' own printer columns (left out, as the built-in view did), each with the built-in
column's width, sort order and filter:
- ClusterPolicies and Policies, after Name (and Namespace): **Ready** (`cluster-policy-ready`, `policy-ready`: Ready,
  Not ready or Pending, coloured, from the Ready condition, else `status.ready`; sorted and filtered by the state's
  name, `True`, `False` or `Unknown`, in every language), **Mode** (`cluster-policy-mode`, `policy-mode`: Enforce in
  amber, Audit or Mixed over every rule, from each validating rule's own `failureAction`, else the policy's
  `validationFailureAction`, else Audit; sorted and filtered by `Enforce`, `Audit` or `Mixed`), **Background**
  (`cluster-policy-background`, `policy-background`: Yes unless `spec.background` is false; No sorts first), **Rules**
  (`cluster-policy-rules`, `policy-rules`: how many, a number) and **Message** (`cluster-policy-message`,
  `policy-message`: the Ready condition's message, whole on hover).
- Each report kind: **Object** (`policy-report-object`, `cluster-policy-report-object`, `ephemeral-report-object`,
  `cluster-ephemeral-report-object`: `Kind/name` of the report's `scope`, or `spec.owner` of an ephemeral report) and
  the counts **Pass**, **Fail**, **Warn**, **Error** and **Skip** (`policy-report-pass`, `policy-report-fail`,
  `policy-report-warn`, `policy-report-error`, `policy-report-skip`, `cluster-policy-report-pass`,
  `cluster-policy-report-fail`, `cluster-policy-report-warn`, `cluster-policy-report-error`,
  `cluster-policy-report-skip`, `ephemeral-report-pass`, `ephemeral-report-fail`, `ephemeral-report-warn`,
  `ephemeral-report-error`, `ephemeral-report-skip`, `cluster-ephemeral-report-pass`, `cluster-ephemeral-report-fail`,
  `cluster-ephemeral-report-warn`, `cluster-ephemeral-report-error`, `cluster-ephemeral-report-skip`), numbers from the
  report's summary, else counted from its results; failures and errors in red.

**Details**, drawn with the SDK's UI kit in the classes of Sextant's own details panel, their blocks opened and closed
as the built-in ones (open at first, remembered in Sextant's own memory of details sections, with the panel's "Expand
all" and "Collapse all"); a closed block draws and watches nothing:
- a block on each Kyverno kind, titled by the kind (`cluster-policy`, `policy`, `policy-report`,
  `cluster-policy-report`, `ephemeral-report`, `cluster-ephemeral-report`):
  - a ClusterPolicy or Policy: its readiness in plain words (in red when not ready, with Kyverno's message), what its
    mode means, Ready, Mode and Background scans, the rules (name, type, mode, matched kinds), and a block **Results in
    reports**: its results counted over the reports carrying its label (`cpol.kyverno.io/<name>` in every namespace and
    the ClusterPolicyReports for a ClusterPolicy, `pol.kyverno.io/<name>` in its namespace for a Policy; at most 1000
    reports read, with a note when more carry the label) and the objects that fail it (at most 50 listed), each a link;
    the reports are watched only while this block is open;
  - a report: the object it is about (a link), its counts, and its results, failures first (policy as a link, rule,
    result, message; at most 50 listed).
- a block **Policy results** (`policy-results`) on every other kind (`*`/`*`): the results of the object's own report
  (a PolicyReport in its namespace, a ClusterPolicyReport for a cluster-scoped object, watched by the name Kyverno
  gives it, the object's uid as Sextant tells it), failures first, with "Failing policy rules: N of M checked." in red
  or "No policy rule fails". It stays hidden on Kyverno's own kinds, reports and Events, where the cluster serves no
  reports, and while Kyverno has not reported on the object; it shows an error where discovery or the report could not
  be read. Closed, it looks once — its title shows where there are results, it hides where there are none — and
  watches again when opened, as the built-in block did.

The details' tables keep the built-in ones' columns on one line (the rest wrap between words); their columns resize,
and Sextant remembers their widths, as the built-in tables did.

## Permissions

- **Read** ClusterPolicies, Policies, PolicyReports, ClusterPolicyReports, EphemeralReports and ClusterEphemeralReports
  in every namespace of every cluster: the details read the shown Kyverno object and the reports; "Policy results"
  finds an object's report by the uid Sextant gives it, without reading the object.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge PolicyReports and ClusterPolicyReports; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `policies`: the extension's own category **Kyverno policy failures** (`policies`), opt-in —
off until turned on on the Problems page, because an Audit policy can fail on hundreds of objects at once. Only
wgpolicyk8s.io reports are judged; Kyverno's ephemeral reports are its intermediate results. A report with a failed
result is a problem `PolicyViolation` that notifies; one with a result Kyverno could not evaluate (`error`) is a
problem `PolicyError` listed only, never notified. Both are in one notification group (`policies`). Each problem is
about the object the report names (its `scope`; a report without one is told about itself), counts from the earliest
such result's time (Kyverno writes it in seconds), and says the built-in words in the count's plural form, each policy
once, sorted: "2 policy rules fail: a, b", "1 policy rule could not be evaluated: c".

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `report-failures` | PolicyReport | A failed result | None | No |
| `report-errors` | PolicyReport | A result `error` (listed only) | None | No |
| `cluster-report-failures` | ClusterPolicyReport | A failed result | None | No |
| `cluster-report-errors` | ClusterPolicyReport | A result `error` (listed only) | None | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0101).

## What it does not do

- It does not create, change or test policies, run the Kyverno CLI, or ask Kyverno for anything: every value comes from
  the policies' and reports' own fields.
- It does not install or upgrade Kyverno.
- It does not judge Kyverno's ephemeral reports, nor policy exceptions, cleanup policies or the newer
  ValidatingPolicy kinds.

## Requirements and limits

- Kyverno's CRDs (`kyverno.io/v1`, `wgpolicyk8s.io/v1alpha2`, `reports.kyverno.io/v1`); the section shows only where
  the cluster serves them. "Policy results" needs Kyverno 1.10 or newer (one report per resource, named by its uid).
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - The counter counts each object with problems once; the built-in counted problems, so an object whose report has
    both a failure and an error counted twice there.
  - Mode counts every action a verifyImages rule's entries set (Audit on one entry and Enforce on another is Mixed);
    the built-in took the rule's first entry that sets one. A match step cannot pick the first item that has a field.
    Mode also reads a rule as Kyverno admits it — of one type, its actions as the CRDs' enum writes them — where the
    built-in read a rule of two types by the first and an action in any case.
  - Background filters by the shown Yes or No; the built-in filtered by its boolean.
  - A block inside a block keeps the outer block's heading level.
  - An error in "Policy results" or "Results in reports" says "Something went wrong."; the built-in named the
    discovery error's own code and message.
  - "Policy results" is a frame on every object's details, hidden until it has found a report on the object.
- Checked by tests on fixtures of Kyverno's objects (copied from the built-in view) against the built-in readings and
  rules; not yet tried on a live cluster.

## Troubleshooting

- **No "Kyverno" section:** the cluster does not serve Kyverno's kinds, or the extension is disabled.
- **The counter shows nothing:** the category "Kyverno policy failures" is off; turn it on on the Problems page.
- **No "Policy results" on an object:** Kyverno has not reported on it (it reports only on kinds its policies match,
  with background scans or at admission), or Kyverno is older than 1.10.
- **"Something went wrong." in "Policy results":** the report could not be read (the cluster refused your credentials,
  or discovery failed).
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Kyverno.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/kyverno        # → extensions/kyverno/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/kyverno
```

- `src/main.ts` starts the details sections; `details.ts` draws them with the SDK's `ui` kit and holds the report
  watches (a policy's labelled reports, an object's own report by name); `dom.ts` keeps the blocks in Sextant's memory
  (`BlockMemory`).
- `model.ts` reads Kyverno's fields; it is the former built-in view's model, ported, with its problem detector
  (`policyProblems`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules, the kinds' "Only problems" and the columns with Sextant's own
  window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on
  the fixtures in `fixtures/` and variants of them (the Mode column on every policy of up to three rules of eight
  shapes under each policy-wide action and on longer ones, the messages in every plural form of every language);
  `views.test.ts` drives the details through the SDK's test host, blocks and capped watches included.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `kyverno`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `kyverno` and the
     commit (add `kyverno` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
