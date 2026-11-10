# JobSet

Read-only views of [JobSet](https://jobset.sigs.k8s.io/) (`jobset.x-k8s.io`), in every language Sextant has. It lists
JobSets in a sidebar section of their own with Sextant's tables; tells a JobSet's state, its replicated jobs, its
restarts against `failurePolicy.maxRestarts`, its success, failure and startup policies, its Jobs and pods; and when it
failed, the controller's reason with the first failed Job and that Job's own reason. It reports JobSets that failed
within a day and JobSets whose restarts leave at most one before the limit. It replaces Sextant's former built-in
JobSet view (ADR-0114) with the same behaviour. Its id is `sextant.jobset`. Why it is built this way: ADR-0114 (the
readings and problems), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (a kind in a section of
its own, `not` in rules), ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161
(printer columns left out, paths picking an item, notification groups, lists counted as lengths), ADR-0163 (field
values in texts, a problem's reason from the object), ADR-0164 (case tooltips, deeper conditions, `atLeast`) and
ADR-0167 (the counter's own label, column widths, case sort values, the `muted` tone, `[*]` paths and the `sum` format,
tooltip fallbacks, `|sum` in conditions, columns and texts, `atLeast` offsets and added paths, `reasonOr`/`sinceOr`,
`stamp`, untitled sections, blocks in Sextant's own memory, capped watches).

## At a glance

| | |
|---|---|
| Id | `sextant.jobset` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `jobset-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → JobSet |
| Checked against | JobSets as kubernetes-sigs/jobset writes them (`jobset.x-k8s.io/v1alpha2`: `api/jobset/v1alpha2/jobset_types.go` and `pkg/controllers`) |

## What it adds

**A sidebar section "JobSet"** (`jobset`), shown while the cluster serves JobSets, with the built-in section's icon,
right after Kueue's section: Job Sets, with Sextant's own table, filters, selection bar and details, and Edit and Delete
as on every kind. The section's counter shows how many JobSets need attention (the problems below).

**"Only problems"**, as the built-in table had it, from the problem rules: JobSets that failed within the last day, and
running JobSets whose counted restarts leave at most one before `maxRestarts`.

**Columns**, after Name and Namespace, in place of the CRD's own printer columns (left out, as the built-in view did):
- **Status** (`jobset-status`, 120 px): Completed, Failed, Suspended, Restarting, Starting, Running or Pending, as the
  controller's conditions and `terminalState` say, coloured as the built-in column (Suspended muted); Running when any
  replicated job has active or ready Jobs; a completed or failed JobSet's condition "reason: message" on hover (the
  one of them it has, else none). It sorts by the state, as the built-in column did.
- **Succeeded** (`jobset-succeeded`, 100 px): succeeded Jobs of the wanted ones of every replicated job added up,
  "succeeded/wanted", sorted as text as the built-in column was.
- **Active** (`jobset-active`) and **Failed** (`jobset-failed`), 80 px: active and failed Jobs of every replicated job
  added up, 0 before the controller wrote any, sorted as numbers.
- **Restarts** (`jobset-restarts`, 90 px): the restarts, or with a failure policy those counted against `maxRestarts`
  as "counted/max" — the JobSet's own and its Jobs' own (`jobRestartsCountTowardsMax`); sorted as text, as the built-in
  column was.

**Details**, a section **JobSet** (`jobset`) without a heading of its own (as the built-in one; "JobSet" stays its
accessible name), drawn with the SDK's UI kit in the classes of Sextant's own details panel:
- when it failed, the controller's reason and message, the first failed Job the Failed condition names (a link) and
  that Job's own failure reason, or that it no longer exists;
- a warning when the counted restarts leave at most one before the limit, and a remark when it is suspended;
- its state, terminal state, restarts ("3 of 3 allowed (3 in all)"), restart strategy, success policy in words,
  startup order, suspension, start time, active deadline, time to live after finishing, subdomain, coordinator pod and
  `managedBy`;
- the replicated jobs (Jobs, completions/parallelism, ready, active, succeeded, failed, depends on) and the failure
  policy's rules;
- its Jobs (replicated job, index, state, restart attempt, failure) and its pods (Job, status; at most 50, those not
  running first), watched in the JobSet's namespace by the label the controller puts on them,
  `jobset.sigs.k8s.io/jobset-name=<name>`: the Jobs while their block is open or the JobSet failed (its failure names
  the first failed Job), the pods while theirs is open; each list keeps at most 500 objects and says when it is cut.

The replicated jobs, failure policy rules, Jobs and Pods blocks open and close with their titles, in Sextant's own
memory of details sections: as Settings → Appearance says (globally, per cluster, or this object only), and with the
panel's "Expand all" and "Collapse all".

The tables' columns resize (drag a header's right edge) and Sextant remembers their widths, as the built-in view's
did; the same columns keep to one line, the others wrap between words.

Every object named is a link to its details in Sextant's panel. Kueue's queue section on JobSets is Sextant's own and
stays there.

## Permissions

- **Read** JobSets (each section reads the object it shows), and Jobs and Pods (a JobSet's own, by its label, in its
  namespace), in every namespace of every cluster.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge JobSets; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `jobset`, on by default. Every rule may notify; none waits a grace period. The two
`restarts-near-limit` rules form one notification group. A failed JobSet's reason is the controller's own
(`FailedJobs`, `ReachedMaxRestarts`, `FailJobSetFailurePolicyAction`, `DeadlineExceeded`, …), "Failed" when it gives
none; it stays a problem for a day after the Failed condition's time (after its creation without one). The restarts
counted are the JobSet's own — `status.restartsCountTowardsMax`, else, from a controller without that field, every
restart (`status.restarts`) unless a rule restarts with `RestartJobSetAndIgnoreMaxRestarts` — plus its Jobs' own
(every number of `status.replicatedJobsStatus[*].jobRestartsCountTowardsMax`). A new count of restarts counts as first
seen again (the built-in problem's progress); the problem is told once, as the built-in one was. The two
`restarts-near-limit` rules are one notification group: two only because the JobSet's own count is read from a
different field, which the message adds to the Jobs' own.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `failed` | JobSet | Failed (terminal state or condition) and not completed, for a day from the Failed condition's time (else from its creation) | None | No |
| `restarts-near-limit` | JobSet | Not completed, failed or suspended; `maxRestarts` above 0; `restartsCountTowardsMax` (missing: 0) and the Jobs' own counted restarts added up are above 0 and at least one before the limit | None | No |
| `restarts-near-limit-all` | JobSet | The same from a controller without `restartsCountTowardsMax`, every restart and the Jobs' own counted | None | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0114).

## What it does not do

- It does not suspend, resume, restart or delete JobSets, or change their policies.
- It does not show Kueue's queue and admission of a JobSet: that is Sextant's own Kueue section, on JobSets too.
- It does not recompute what the controller decides: every state shown is the controller's own from the object.

## Requirements and limits

- JobSet's CRD (`jobset.x-k8s.io/v1alpha2`); the section shows only where the cluster serves it.
- No difference from the former built-in view is known.
- Checked by tests on fixtures of JobSet's objects (copied from the built-in view) against the built-in readings and
  rules; not yet tried on a live cluster.

## Troubleshooting

- **No "JobSet" section:** the cluster does not serve JobSets, or the extension is disabled.
- **"The list could not be read." under Jobs or Pods:** the extension may not read Jobs or Pods in that namespace, or
  the cluster refused your credentials.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → JobSet.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/jobset        # → extensions/jobset/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/jobset
```

- `src/main.ts` starts the details section; `details.ts` draws it with the SDK's `ui` kit and holds the watches of the
  JobSet's Jobs and pods.
- `model.ts` reads JobSet's fields; it is the former built-in view's model, ported, with its problem detector
  (`jobSetProblems`) and filter (`isProblem`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules (which also make "Only problems") and the columns with Sextant's
  own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model
  on the fixtures in `fixtures/`; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `jobset`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `jobset` and the
     commit (add `jobset` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
