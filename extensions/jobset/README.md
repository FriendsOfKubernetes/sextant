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
ADR-0167 (the counter's own label, more conditions per rule).

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
- **Status** (`jobset-status`): Completed, Failed, Suspended, Restarting, Starting, Running or Pending, as the
  controller's conditions and `terminalState` say, coloured; a completed or failed JobSet's condition reason and
  message on hover.
- **Succeeded** (`jobset-succeeded`): succeeded Jobs of the wanted ones.
- **Active** (`jobset-active`) and **Failed** (`jobset-failed`): active and failed Jobs.
- **Restarts** (`jobset-restarts`): the restarts, or with a failure policy those counted against `maxRestarts` as
  "counted/max".

**Details**, a section **JobSet** (`jobset`) drawn with the SDK's UI kit in the classes of Sextant's own details panel:
- when it failed, the controller's reason and message, the first failed Job the Failed condition names (a link) and
  that Job's own failure reason, or that it no longer exists;
- a warning when the counted restarts leave at most one before the limit, and a remark when it is suspended;
- its state, terminal state, restarts ("3 of 3 allowed (3 in all)"), restart strategy, success policy in words,
  startup order, suspension, start time, active deadline, time to live after finishing, subdomain, coordinator pod and
  `managedBy`;
- the replicated jobs (Jobs, completions/parallelism, ready, active, succeeded, failed, depends on) and the failure
  policy's rules;
- its Jobs (replicated job, index, state, restart attempt, failure) and its pods (Job, status; at most 50, those not
  running first), watched while the section shows in the JobSet's namespace by the label the controller puts on them,
  `jobset.sigs.k8s.io/jobset-name=<name>`.

Every object named is a link to its details in Sextant's panel. Kueue's queue section on JobSets is Sextant's own and
stays there.

## Permissions

- **Read** JobSets (each section reads the object it shows), and Jobs and Pods (a JobSet's own, by its label, in its
  namespace), in every namespace of every cluster.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge JobSets; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `jobset`, on by default. Every rule may notify; none waits a grace period. The `failed`
rules form one notification group, and so do the `restarts-near-limit` rules. A failed JobSet's reason is the
controller's own (`FailedJobs`, `ReachedMaxRestarts`, `FailJobSetFailurePolicyAction`, `DeadlineExceeded`, …), "Failed"
when it gives none; it stays a problem for a day after the Failed condition's time (after its creation without one).
The restarts counted are `status.restartsCountTowardsMax`, else, from a controller without that field, every restart
(`status.restarts`) unless a rule restarts with `RestartJobSetAndIgnoreMaxRestarts`. Because a rule cannot subtract,
"one before the limit" is spelled out for each limit up to 19 (11 for a controller without the field); a higher limit
is reported once the restarts reach it.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `failed` | JobSet | Failed (terminal state or condition), not completed, with a reason and a time, for a day from the Failed condition | None | No |
| `failed-unnamed` | JobSet | The same without a reason (reason "Failed") | None | No |
| `failed-untimed` | JobSet | Failed with a reason, the condition without a time: for a day from its creation | None | No |
| `failed-unnamed-untimed` | JobSet | The same without a reason (reason "Failed") | None | No |
| `restarts-near-limit` | JobSet | Not completed, failed or suspended; counted restarts above 0 and at or over the limit, or one below a limit of 1 to 7 | None | No |
| `restarts-near-limit-8` | JobSet | The same, one below a limit of 8 to 13 | None | No |
| `restarts-near-limit-14` | JobSet | The same, one below a limit of 14 to 19 | None | No |
| `restarts-near-limit-all` | JobSet | As `restarts-near-limit`, from a controller without `restartsCountTowardsMax` (every restart counted), limits 1 to 6 | None | No |
| `restarts-near-limit-all-7` | JobSet | The same, one below a limit of 7 to 11 | None | No |

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
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - The Succeeded, Active and Failed columns add up the replicated jobs only for a JobSet of one replicated job; for
    more, they show each replicated job's count in order ("1/1 + 3/4", "1 + 2"), the first two (Succeeded) or four
    (Active, Failed) followed by "…" beyond. They sort by that text.
  - The Restarts column and the restarts problem leave out the Jobs' own `jobRestartsCountTowardsMax` (the RestartJob
    strategy); the details count them.
  - A JobSet counts as Running from the active or ready Jobs of its first 13 replicated jobs.
  - One restart before a limit over 19 (over 11 for a controller without `restartsCountTowardsMax`) is not a problem
    until the limit is reached; the built-in rule notified again on each new count of restarts, the rules once.
  - Suspended is drawn in the neutral colour in the table (the built-in table muted it).
  - The details are a titled section (the built-in one had no title of its own); its blocks are always open when
    shown (the built-in panel remembered closed blocks), and the Jobs and pods are watched while the section shows,
    open or closed, with no cap (the built-in view read at most 500 of each and said when a list was cut).
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
