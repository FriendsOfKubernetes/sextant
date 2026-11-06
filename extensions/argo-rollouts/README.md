# Argo Rollouts

Views and actions for [Argo Rollouts](https://argoproj.github.io/rollouts/), in every language Sextant has. It
lists Rollouts, AnalysisRuns, AnalysisTemplates, ClusterAnalysisTemplates and Experiments in a sidebar section of
their own with Sextant's tables, reads a Rollout the way `kubectl argo rollouts get rollout` reads it (status, canary
steps and weights, blue-green Services, ReplicaSets by role, analysis runs with the failing measurement), and
promotes, aborts, retries, pauses and resumes a Rollout with exactly the plugin's patches, shown first. It replaces
Sextant's former built-in Argo Rollouts view (ADR-0097) with the same behaviour. Its id is `sextant.argo-rollouts`.
Why it is built this way: ADR-0097 (the readings and patches), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0152 (kinds in a section of its own), ADR-0153 (computed columns), ADR-0154 (action conditions
and buttons) and ADR-0155 (status patches).

## At a glance

| | |
|---|---|
| Id | `sextant.argo-rollouts` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `argo-rollouts-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Argo Rollouts |
| Checked against | Argo Rollouts v1.x objects as the controller writes them (`argoproj.io/v1alpha1`); the patches follow `kubectl argo rollouts` |

## What it adds

**A sidebar section "Argo Rollouts"** (`argoRollouts`), shown while the cluster serves one of its kinds: Rollouts,
Analysis Runs, Analysis Templates, Cluster Analysis Templates and Experiments, each with Sextant's own table,
filters, selection bar and details. The section's counter shows how many Rollouts have a problem of the rules below.
"Only problems" on the Rollouts table shows the same Rollouts.

**Columns:**
- Rollouts: **Status** (`rollout-status`: Healthy, Progressing, Paused or Degraded, coloured, the controller's
  message on hover), **Strategy** (`rollout-strategy`: Canary or BlueGreen), **Step** (`rollout-step`: the current
  step index), **Weight** (`rollout-weight`: the canary weight the traffic router reports, 0 after an abort) and
  **Ready** (`rollout-ready`: ready of desired replicas). They follow the CRD's own Desired, Current, Up-to-date and
  Available columns.
- Analysis Runs: **Phase** (`run-phase`), **Rollout** (`run-rollout`) and **Message** (`run-message`: why it failed).
- Experiments: **Phase** (`experiment-phase`), **Rollout** (`experiment-rollout`) and **Message**
  (`experiment-message`).
- Analysis Templates and Cluster Analysis Templates: **Metric** (`template-metric`, `cluster-template-metric`: the
  first metric's name).

**Details:**
- **Rollout** (`rollout`, a section of a Rollout): the status with the controller's message or Sextant's own
  explanation (the spec not observed yet, waiting for an unpause, …), the strategy, step, set and actual weight,
  what paused it, the blue-green active and preview Services with the template each selects, the canary's stable and
  canary Services, and the stable and current templates; the canary **Steps** with the current one marked; its
  **ReplicaSets** by role (stable, canary, active, preview, old) with revision and available pods; its newest 20
  **Analysis runs** with phase, start and why they failed. Every object named is a link to its details.
- **AnalysisRun** (`analysis-run`): its phase, its Rollout, why it failed, and each metric's counts, last value and
  the failing measurement's message.
- **Experiment** (`experiment`): its phase, message and Rollout, its templates and its analysis runs.
- **Metrics** (`template-metrics`, on AnalysisTemplates and ClusterAnalysisTemplates): each metric and its provider.

**Actions on a Rollout**, each offered only where it applies; the selection bar says why not elsewhere:
- **Promote** (`promote`, a button): leaves the pause and goes on to the next step, as
  `kubectl argo rollouts promote`.
- **Promote fully** (`promote-full`, in "Actions"): skips the remaining steps, pauses and analysis, as
  `promote --full`.
- **Abort** (`abort`, a button, marked dangerous): sends all traffic back to the stable ReplicaSet, as
  `kubectl argo rollouts abort`.
- **Retry** (`retry`, in "Actions"): starts an aborted update again, as `kubectl argo rollouts retry`.
- **Pause** (`pause`, a button): pauses by hand (`spec.paused`), as `kubectl argo rollouts pause`.
- **Resume** (`resume`, a button): clears `spec.paused` and the pause conditions, as the plugin's former `resume`
  and Argo CD's Rollout action.

Restart (`spec.restartAt`) is Sextant's own generic Restart action and works on Rollouts without this extension.

## Permissions

- **Read** Rollouts, AnalysisRuns, AnalysisTemplates, ClusterAnalysisTemplates and Experiments (the details and the
  actions' fresh reads) and ReplicaSets (a Rollout's ReplicaSets and its actual canary weight), in every namespace
  of every cluster.
- **Modify** Rollouts, confirmed by Sextant every time: the actions' patches.
- **Status patches** (`permissions.statusPatches`) of Rollouts: Promote, Promote fully, Abort and Retry write part
  of their patch to the status subresource, as the plugin does (ADR-0155).
- Nothing is deleted. Services are only linked to, never read.
- Its problem rules judge Rollouts; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind, action or status patch.

## Problems

All on Rollouts, from the Rollout's own status; none watches AnalysisRuns. All may notify.

| Id | When it holds | Grace | Told by another object |
|---|---|---|---|
| `degraded` | `status.phase` is Degraded (or, from an older controller, the InvalidSpec or ProgressDeadlineExceeded condition), and the update was not aborted | 1 minute | No |
| `aborted` | `status.abort` is true | None | No |
| `step-analysis-failed` | The current canary step's analysis run is Failed or Error | None | No |
| `background-analysis-failed` | The canary's background analysis run is Failed or Error | None | No |
| `pre-promotion-analysis-failed` | The blue-green pre-promotion analysis run is Failed or Error | None | No |
| `post-promotion-analysis-failed` | The blue-green post-promotion analysis run is Failed or Error | None | No |

## Metrics

None.

## Commands

None.

## Changes it makes

Only the six actions change anything, and only the Rollout they run on. Each opens a window that reads the Rollout,
says what the action does, and lists the JSON merge patches it will send: the one to the status subresource, the
one to the Rollout itself, and the "unified" patch sent instead when the cluster's Argo Rollouts (v0.9) has no
status subresource. On confirm the Rollout is read again: if the action no longer applies, or the patches would
differ from the ones shown, nothing is sent and the window shows the new state to confirm again. Then the status
patch goes first and the spec patch second, each once, each after Sextant's own confirmation. An action that has
nothing to change (Pause of a Rollout already paused by hand) cannot be confirmed.

## What it does not do

- It does not run `kubectl argo rollouts` or talk to the Argo Rollouts dashboard: everything goes through the
  Kubernetes API.
- It does not set an image, edit steps or create Rollouts: Sextant's editor does that.
- It does not restart: Sextant's own Restart action does.
- It does not show Argo Workflows or Argo CD, which share the group `argoproj.io`.

## Requirements and limits

- The Argo Rollouts CRDs, and the controller for anything to happen after an action.
- The table's columns are computed by Sextant from field paths (ADR-0153), so where the former built-in view
  computed a value they show the closest field:
  - **Status** is `status.phase`, with the controller's not-yet-observed unpause shown as Progressing; the spec or a
    referenced workload not yet observed (a comparison of two fields) is not, and an older controller's Healthy and
    Progressing (computed from replica counts and hashes) are left blank. The details always show the full reading.
  - **Step** is the step index without the number of steps, and **Weight** the router's reported weight (blank
    without traffic routing). The details show "step i/n", the set weight and the actual weight.
  - **Message** of an AnalysisRun is its own message, else the first of its first three metrics that has one; the
    templates' **Metric** is the first metric only. The details list all of them.
  - **Rollout** of an AnalysisRun or Experiment is its first owner.
  - The columns are placed after the CRD's own "Available" or "Status" column; where a cluster's CRD has no such
    column they come last.
- Promote, Promote fully and Abort are offered a little more widely than they apply (Sextant's conditions cannot
  compare the current and stable templates); their windows check exactly and say why when they do not apply.
- A problem and the failed analysis that caused it are listed as separate problems, each of which may notify.
- An Analysis Run or Experiment that failed is not marked under "Only problems": no problem rule watches them.
- A Rollout with Sextant's confirmation asks once per patch: Promote of a Rollout paused by hand asks twice.

## Troubleshooting

- **No "Argo Rollouts" section:** the cluster serves none of its kinds, or the extension is disabled.
- **"Sextant refused: …" in an action's window:** the extension's permissions do not cover the Rollout, or you
  declined Sextant's confirmation. Check Settings → Extensions → Argo Rollouts.
- **"The rollout changed while this dialog was open":** the Rollout moved on between reading and sending; check the
  new patches and confirm again.
- **No ReplicaSets or analysis runs in the details:** your credentials may not list them in the Rollout's namespace;
  the section says the cluster refused.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/argo-rollouts        # → extensions/argo-rollouts/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts extensions/argo-rollouts
```

- `src/main.ts` picks the view by the frame's context: `details.ts` (the four details sections, `live.ts` for a
  Rollout's lists) or `actions.ts` (the action windows).
- `model.ts` reads Argo Rollouts' fields; `patches.ts` builds every patch and says exactly when each action applies.
- `model.test.ts` judges the manifest's problem rules, action conditions and column cases with Sextant's own window
  engine (`src/extensions/problemRules.ts`) and compares them with the model, on the fixtures in `fixtures/`.
- The texts are in `src/locales/<lang>.json` (English is the source) and in the manifest's `translations`.
  `src/locales.test.ts` keeps both complete in every language of Sextant's `src/locales/`. The column cases are the
  API's own words and stay English.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `argo-rollouts`
     and the commit.
  3. The catalog's index picks the release up.
