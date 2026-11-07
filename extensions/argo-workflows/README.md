# Argo Workflows

Views and actions for [Argo Workflows](https://argoproj.github.io/workflows/), in every language Sextant has. It
lists Workflows, CronWorkflows, WorkflowTemplates and ClusterWorkflowTemplates in a sidebar section of their own with
Sextant's tables, reads a Workflow the way the Argo Workflows UI reads it (phase, progress, duration, the step that
failed and its message, the step tree with each pod and its logs), and suspends, resumes, stops and terminates a
Workflow with exactly the patches the `argo` CLI sends, shown first. It replaces Sextant's former built-in Argo
Workflows view (ADR-0097) with the same behaviour. Its id is `sextant.argo-workflows`. Why it is built this way:
ADR-0097 (the readings and patches), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in
a section of its own, rules narrowed to a label-selected source), ADR-0153 (computed columns), ADR-0154 (action
conditions and buttons), ADR-0156 (Sextant's logs tab), ADR-0160 (the section's icon and place, the UI kit), ADR-0161
(printer columns left out, paths picking an item, notification groups, hidden details sections), ADR-0163 (field
values in texts, a problem's reason from the object), ADR-0164 (case tooltips, deeper conditions) and ADR-0165 (map
entries by their fields, `enteredWithin`, `notifyAs`, list cells, a kind's own "Only problems").

## At a glance

| | |
|---|---|
| Id | `sextant.argo-workflows` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `argo-workflows-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Argo Workflows |
| Checked against | Argo Workflows v3.x objects as the controller writes them (`argoproj.io/v1alpha1`); the patches follow `workflow/util/util.go` of the `argo` CLI |

## What it adds

**A sidebar section "Argo Workflows"** (`argoWorkflows`), shown while the cluster serves one of its kinds, with the
built-in section's icon, right after Velero's section: Workflows, Cron Workflows, Workflow Templates and Cluster
Workflow Templates, each with Sextant's own table, filters, selection bar and details. The section's counter shows
how many Workflows failed recently (the problems below). "Only problems" on the Workflows table shows every Failed or
Errored Workflow, recent or not, as the built-in table did.

**Columns**, after Name and Namespace (Name for cluster templates), in place of the CRDs' own printer columns (left
out, as the built-in view did):
- Workflows: **Phase** (`workflow-phase`: Pending, Running, Succeeded, Failed or Error, coloured), **Progress**
  (`workflow-progress`: `status.progress`, pods done of all), **Duration** (`workflow-duration`: from the start to
  the finish, to now while it runs) and **Failed step** (`workflow-failed-step`: of a Failed or Errored Workflow, the
  step that failed and its message, "C: Error (exit code 1)", else the Workflow's own message; the same text on
  hover).
- Cron Workflows: **Schedule** (`cron-schedule`: `spec.schedules`, else the older `spec.schedule`), **Suspended**
  (`cron-suspended`: "Yes" while suspended), **Active** (`cron-active`: the Workflows it runs now) and **Last
  scheduled** (`cron-last-scheduled`: the age of its last run).
- Workflow Templates: **Entrypoint** (`template-entrypoint`) and **Templates** (`template-templates`: how many);
  Cluster Workflow Templates the same (`cluster-template-entrypoint`, `cluster-template-templates`).

**Details:**
- **Workflow** (`workflow`, a section of a Workflow): its phase, progress, start, finish and duration (ticking while
  it runs), its message, the failed step and its message, the CronWorkflow and the (Cluster)WorkflowTemplate it came
  from (links), and for a failed one how to retry it with `argo retry`. Below, its **Steps**: the node tree from the
  root, collapsed below it, with each step's type, phase, duration (ticking every few seconds) and message; "Show the
  failed step" opens the tree down to it, "Collapse all" closes it again. A pod's step links to its pod (named as the
  controller names it, by `workflows.argoproj.io/pod-name-format`, v1 or v2, a container set's containers by their
  pod) and opens its logs in Sextant's logs tab with "Logs" (saying so beside it when the pod is gone). At most 500
  steps are drawn. When the controller keeps the steps in its database (offloaded) or compressed, it says so.
- **Schedule** (`cron-workflow`, a section of a CronWorkflow): its schedules, time zone, concurrency policy, whether
  it is suspended, its last run (time and age), the Workflows it runs now (links), its succeeded and failed counts and
  its entry template.
- **Template** (`template`, on WorkflowTemplates and ClusterWorkflowTemplates): the entry template and every
  template's name; hidden, title included, for a template with neither.

The details are drawn with the SDK's UI kit, in the classes of Sextant's own details panel.

**Actions on a Workflow**, each offered only where it applies; the selection bar says why not elsewhere:
- **Suspend** (`suspend`, a button): no new steps start until it is resumed, as `argo suspend`. Offered while the
  Workflow has not finished and is not suspended.
- **Resume** (`resume`, a button): lifts the suspension and marks every waiting suspend step Succeeded, a supplied
  output taking its default, as `argo resume`. Offered while it is suspended or a suspend step waits.
- **Stop** (`stop`, a button, marked dangerous): running steps stop, exit handlers still run, as `argo stop`.
- **Terminate** (`terminate`, in "Actions", marked dangerous): running steps stop and nothing else runs, exit
  handlers included, as `argo terminate`.

Edit and Delete are Sextant's own actions on every kind of the section. Retry is not offered (see below).

## Permissions

- **Read** Workflows, CronWorkflows, WorkflowTemplates and ClusterWorkflowTemplates (the details and the actions'
  fresh reads), in every namespace of every cluster.
- **Modify** Workflows: the actions' patches. Sextant does not ask again (`confirm: false`): each action's window
  lists the exact patch and is the one question, as in the built-in view.
- **Logs** of Pods: "Logs" in the step tree opens Sextant's logs tab on the step's pod; the tab reads them as your
  own logs tab does. Pods are otherwise only linked to, never read by the extension.
- Nothing is deleted. Workflows have no status subresource, so no status patch is asked for.
- Its problem rules judge Workflows; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

Both on Workflows, from one metadata-only watch of the failed and errored ones (`source.labelSelector`
`workflows.argoproj.io/phase in (Failed,Error)`: the label the controller keeps equal to the phase; a failed Workflow's
status can be megabytes). A problem's reason is the phase, Failed or Error; its message says the failed step is in the
details. Both may notify and are in the group `failed`, and the runs of one CronWorkflow notify as one
(`notifyAs` its `workflows.argoproj.io/cron-workflow` label), as the built-in view did. Together they count a failure
for a day from when it happened, as well as Sextant can tell from metadata: from the moment Sextant saw the Workflow
enter the failed list while watching, else from its creation.

| Id | When it holds | Grace | Told by another object |
|---|---|---|---|
| `failed` | The Workflow entered the failed list while Sextant watched it, less than a day ago (`enteredWithin`); it counts from then | None | No |
| `failed-earlier` | The Workflow was already in the failed list when Sextant first read it, and was created less than a day ago; it counts from its creation | None | No |

## Metrics

None.

## Commands

None.

## Changes it makes

Only the four actions change anything, and only the Workflow they run on. Each opens a window that reads the
Workflow, says what the action does, and lists the one JSON merge patch it will send, as `workflow/util/util.go`
builds it: Suspend `spec.suspend: true`, Resume `spec.suspend: null` and the waiting suspend steps marked Succeeded
(with their `finishedAt` the time of sending), Stop `spec.shutdown: "Stop"`, Terminate `spec.shutdown: "Terminate"`.
Sextant has no Argo identity, so, as the CLI without claims does, Suspend and Resume remove the actor labels that are
there. Suspend and Resume carry the Workflow's resourceVersion: the one shown is that of the window's read, and the
one sent is read again right before sending, so the API server refuses the change if the Workflow changed in between.
On confirm the Workflow is read again: if the patch would differ from the one shown, nothing is sent and the window
shows the new one to confirm. The patch is sent once, to the Workflow itself; nothing is retried. The window is the
only question; Sextant does not ask again (the Modify rule's `confirm: false`), but still checks the patch against
the extension's grants and journals it. An action with nothing to change, or refused (Suspend of a completed
Workflow, Stop of a finished one, Resume of steps kept outside the object or waiting for an output without a default),
cannot be confirmed and says why.

## What it does not do

- It does not retry a Workflow: a retry resets the failed steps and deletes their pods, which the Argo server does.
  The details say to run `argo retry <name> -n <namespace>`.
- It does not resubmit, submit or create Workflows, and does not run a CronWorkflow now: Sextant's editor creates
  objects.
- It does not resume one step by name or set a suspend step's output (`argo node set`).
- It does not talk to the Argo server or its database: steps offloaded there, or archived Workflows, are not shown.
- It does not show Argo CD or Argo Rollouts, which share the group `argoproj.io`.

## Requirements and limits

- The Argo Workflows CRDs, and the controller for anything to happen after an action.
- The table's columns are computed by Sextant from field paths (ADR-0153), so where the former built-in view
  computed a value they read it as closely as fields allow; the details always show the full reading:
  - **Progress** is `status.progress`; a controller older than v3.0, which writes none, leaves it blank (the built-in
    column counted the pod steps; the details still do).
  - **Failed step** is the first failed or errored container step, then pod step (not the root of a one-pod
    Workflow), then HTTP or plugin step, each in the order of the steps' ids, not the one that finished first as the
    built-in column chose when several failed; another kind of failed step is told by the Workflow's message. A pod step
    without a message shows the Workflow's message after its name, as before; one with neither leaves the cell
    blank (the built-in column showed its name). The details name the failed step exactly as before.
  - **Schedule** joins several schedules as a list in the UI language ("0 2 * * * and 0 14 * * *"); the built-in
    column joined them with commas.
  - **Suspended** and **Failed step** are shown only by their cases: their path, read as a list, is never one.
- The section's counter says how many Workflows have a problem in Sextant's words for every extension, not "N
  workflows failed recently".
- Problems are kept as Sextant keeps every extension's (at most 2000 Workflows with problems per cluster, the source
  at most 5000 failed Workflows); the built-in view kept the 500 most recent failures. A problem's message is new: the
  built-in problems had none.
- Checked by tests on fixtures of the controller's objects (a DAG, a container set, a suspended Workflow, a
  CronWorkflow) and against the patches of `workflow/util/util.go`; not yet tried on a live cluster.

## Troubleshooting

- **No "Argo Workflows" section:** the cluster serves none of its kinds, or the extension is disabled.
- **"Sextant refused: …" in an action's window, or beside "Logs":** the extension's permissions do not cover the
  Workflow or the pod. Check Settings → Extensions → Argo Workflows.
- **"The workflow changed while this dialog was open":** the Workflow moved on between reading and sending; check the
  new patch and confirm again.
- **"Logs" says the pod is not found:** Argo's pod garbage collection deleted it; Sextant's logs of gone pods (Loki)
  may still have its lines.
- **The steps are not shown:** the controller offloads or compresses them; the details say which.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/argo-workflows        # → extensions/argo-workflows/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts extensions/argo-workflows
```

- `src/main.ts` picks the view by the frame's context: `details.ts` (the three details sections, drawn with the SDK's
  `ui` kit) or `actions.ts` (the action windows).
- `model.ts` reads Argo Workflows' fields (the node tree, the failed step, pod names with `fnv32a`); `patches.ts`
  builds every patch and says exactly when each action applies. Both are the former built-in view's, ported.
- `model.test.ts` judges the manifest's problem rules, action conditions and columns with Sextant's own window engine
  (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model, on the fixtures
  in `fixtures/`; `views.test.ts` drives the details and the windows through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; most come from the built-in view's
  `argoworkflows` texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every
  language of Sextant's `src/locales/`. The failed step's cases are written in each language's form of
  "step: message" ("step : message" in French).
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `argo-workflows`
     and the commit (add `argo-workflows` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
