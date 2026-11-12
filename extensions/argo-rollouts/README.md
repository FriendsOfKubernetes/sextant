# Argo Rollouts

Views and actions for [Argo Rollouts](https://argoproj.github.io/rollouts/), in every language Sextant has. It
lists Rollouts, AnalysisRuns, AnalysisTemplates, ClusterAnalysisTemplates and Experiments in a sidebar section of
their own with Sextant's tables, reads a Rollout the way `kubectl argo rollouts get rollout` reads it (status, canary
steps and weights, blue-green Services, ReplicaSets by role, analysis runs with the failing measurement), and
promotes, aborts, retries, pauses and resumes a Rollout with exactly the plugin's patches, shown first. It replaces
Sextant's former built-in Argo Rollouts view (ADR-0097) with the same behaviour. Since 1.5.0 it also tells whether a
canary's traffic really reaches the canary, how safe its checks are set up (opt-in), which Rollout a Deployment serves,
and gives AI agents one read-only tool that diagnoses a Rollout whole (#341, ADR-0171). Its id is
`sextant.argo-rollouts`.
Why it is built this way: ADR-0097 (the readings and patches), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0152 (kinds in a section of its own), ADR-0153 (computed columns), ADR-0154 (action conditions
and buttons), ADR-0155 (status patches), ADR-0160 (the section's icon and place, the UI kit) and ADR-0161 (printer
columns left out, paths picking a list item, conditions comparing two fields, one confirmation for several patches,
notification groups, hidden details sections), ADR-0159 (tools for agents), ADR-0168 (problem judges) and ADR-0171
(what it reads of a Rollout's traffic and checks, and the agent tool).

## At a glance

| | |
|---|---|
| Id | `sextant.argo-rollouts` |
| Version | 1.5.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `argo-rollouts-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Argo Rollouts |
| Checked against | Argo Rollouts v1.x objects as the controller writes them (`argoproj.io/v1alpha1`); the patches follow `kubectl argo rollouts`; the traffic and analysis readings follow the controller's source of v1.10.2 |

## What it adds

**A sidebar section "Argo Rollouts"** (`argoRollouts`), shown while the cluster serves one of its kinds, with the
built-in section's icon, right after Argo CD's section: Rollouts, Analysis Runs, Analysis Templates, Cluster Analysis
Templates and Experiments, each with Sextant's own table, filters, selection bar and details. The section's counter
shows how many Rollouts have a problem of the rules below. "Only problems" on the Rollouts table shows the same
Rollouts.

**Columns**, after Name and Namespace, in place of the CRDs' own printer columns (left out, as the built-in view did):
- Rollouts: **Status** (`rollout-status`: Healthy, Progressing, Paused or Degraded, coloured, the controller's
  message on hover; Progressing while the controller has not observed the newest spec, with "The controller has not
  seen the latest spec yet." on hover), **Strategy**
  (`rollout-strategy`: Canary or BlueGreen), **Step** (`rollout-step`: "i/n", the current step of the canary's steps,
  0 before the controller writes one), **Weight** (`rollout-weight`: the canary's set weight, as the built-in view and
  `GetCurrentSetWeight` read it — the `setWeight` of the current step or of the nearest earlier one, 0 before any,
  0 after an abort, the maximum traffic weight (100 unless `maxTrafficWeight` says otherwise) once every step is done
  or without steps — written "20%" in each language's form, blank for blue-green) and **Ready** (`rollout-ready`: ready of desired replicas).
- Analysis Runs: **Phase** (`run-phase`), **Rollout** (`run-rollout`: the owner that is a Rollout) and **Message**
  (`run-message`: why it failed).
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
- **Metrics** (`template-metrics`, on AnalysisTemplates and ClusterAnalysisTemplates): each metric and its provider;
  hidden, title included, for a template without metrics.

The details are drawn with the SDK's UI kit, in the classes of Sextant's own details panel. The columns of their
tables resize as the built-in view's did, and Sextant remembers their widths (Settings → Appearance resets them with
every table's); words stay whole and names, phases and counts keep to one line, as there.

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

**A section on Deployments** "Argo Rollout" (`managed-by-rollout`), shown only on a Deployment a Rollout of its
namespace takes its pod template from (`spec.workloadRef`): the Rollout (a link), its phase, its `scaleDown`, and what
the Deployment's replica count means — its pods run in the Rollout's ReplicaSets; 0 replicas are expected where the
controller scales it down (`onsuccess`, `progressively`) or it was scaled down by hand (`never`); with `never` and
replicas of its own, its pods run beside the Rollout's. The controller scales the Deployment down only while the
Rollout's first revision rolls out (a one-time migration), so replicas of its own under a later revision stay until
it is scaled down by hand, and the section says so.

**A tool for AI agents**, `diagnose-rollout` ("Diagnose a rollout", read only), offered to agents only after you
turn it on in Settings → AI agents (MCP) → tools of extensions. One call reads a Rollout (by name, or by the
Deployment it takes its template from) and what it depends on: the Deployment, its ReplicaSets and their template
hashes, the Istio VirtualServices and DestinationRule and the canary and stable Services it names, its newest 5
analysis runs with their failing measurements, the analysis templates its strategy names, and its events. It answers
the Rollout's state, findings judged in context (the same template hash for stable and canary is a problem only
while an update runs and the canary has weight; 0 replicas of a Deployment the Rollout scales down are normal), each
`problem`, `warning`, `info` or `normal`, a timeline of conditions, pauses, analyses, failing measurements and events,
and `notChecked`: every read that was refused or failed, and traffic routers other than Istio. Each read is decided by
Sextant for the extension and for the agent both (ADR-0159): an agent gets nothing it could not read itself.

**A backend** (`backend.wasm`), which runs only the agent tool and the two problem judges below; it reaches no network.

## Permissions

- **Read** Rollouts, AnalysisRuns, AnalysisTemplates, ClusterAnalysisTemplates and Experiments (the details and the
  actions' fresh reads) and ReplicaSets (a Rollout's ReplicaSets and its actual canary weight), in every namespace
  of every cluster; since 1.5.0 also Deployments (the Deployment section and the agent tool), Services (the canary
  and stable Services' selectors), Events (the agent tool's timeline) and Istio's VirtualServices and
  DestinationRules (where the canary's traffic goes).
- **Modify** Rollouts: the actions' patches. Sextant does not ask again (`confirm: false`): each action's window
  lists the exact patches and is the one question, as in the built-in view.
- **Status patches** (`permissions.statusPatches`) of Rollouts: Promote, Promote fully, Abort, Retry and Resume
  write part of their patch to the status subresource, as the plugin does (ADR-0155).
- Nothing is deleted. Services, VirtualServices and DestinationRules are only read, never changed.
- Its problem rules judge Rollouts, AnalysisTemplates and ClusterAnalysisTemplates, and look up Deployments,
  VirtualServices, DestinationRules and Services; Sextant asks for that separately at install.
- **Agent tool** `diagnose-rollout`: listed at install, reaching agents only once you turn it on in Settings → AI
  agents (MCP).
- An update asks for consent again when it needs a new kind, action or status patch, or changes a grant (1.2.0
  turned Sextant's confirmation of Modify off, so updating to it asks once). Changed or removed problem rules of the
  same kind ask nothing: Sextant agrees to the kinds the rules judge. 1.5.0 asks once: it reads new kinds, has a
  backend and an agent tool, and its rules judge and look up new kinds.

## Problems

The extension's main category (on by default): all on Rollouts, none watches AnalysisRuns. All may notify, and all
are in the group `rollout`: whatever of them holds on one Rollout notifies once (an analysis that fails and aborts the
update), as the built-in view did. The six of 1.0.0 come from the Rollout's own status, as the built-in category's;
since 1.5.0 the `traffic-*` rules are decided by the backend's judge `traffic` from the Rollout's strategy and status,
the VirtualServices' HTTP routes, the DestinationRules' subsets and the Services' selectors (a list not read in a
namespace makes them "cannot tell", never a problem), and `workload-missing` looks the Deployment up.

| Id | When it holds | Grace | Told by another object |
|---|---|---|---|
| `degraded` | The update was not aborted, the Rollout is Degraded and the controller has observed the newest spec and is not lifting its pause or waiting to observe the workload the template comes from — the built-in view's reading, for every controller: `status.phase` is Degraded, or, from a controller older than v1.0 (no known `status.phase`), an InvalidSpec condition or one of reason RolloutAborted or ProgressDeadlineExceeded; the spec counts as observed when `status.observedGeneration` is at least `metadata.generation`, when either is missing, or when it is not a number (Argo Rollouts v0.9's hash) | 1 minute | No |
| `aborted` | `status.abort` is true | None | No |
| `step-analysis-failed` | The current canary step's analysis run is Failed or Error | None | No |
| `background-analysis-failed` | The canary's background analysis run is Failed or Error | None | No |
| `pre-promotion-analysis-failed` | The blue-green pre-promotion analysis run is Failed or Error | None | No |
| `post-promotion-analysis-failed` | The blue-green post-promotion analysis run is Failed or Error | None | No |
| `paused-long` | The update was not aborted and the Rollout's first pause condition started more than a day ago, whatever paused it (a step, a person, an inconclusive analysis) | None | No |
| `analysis-inconclusive` | A pause condition InconclusiveAnalysisRun or InconclusiveExperiment: it waits for a person to promote or abort | None | No |
| `workload-missing` | `spec.workloadRef` names a Deployment that is not in the Rollout's namespace | 2 minutes | No |
| `traffic-virtual-service-missing` | A VirtualService the Istio routing names (`name`, `name.namespace`, as the controller reads it) is not there | 5 minutes | No |
| `traffic-route-missing` | A VirtualService has no HTTP route of a name `virtualService.routes` gives | 5 minutes | No |
| `traffic-route-not-chosen` | No route is named and the VirtualService has several HTTP routes outside the managed ones (or none without a name), so the controller cannot choose | 5 minutes | No |
| `traffic-route-without-canary` | A route the controller edits has no destination of the canary subset (with a DestinationRule) or the canary Service's host | 5 minutes | No |
| `traffic-route-without-stable` | The same for the stable subset or the stable Service | 5 minutes | No |
| `traffic-destination-rule-missing` | The DestinationRule the Istio routing names is not there | 5 minutes | No |
| `traffic-subset-missing` | The DestinationRule has no subset of the canary's or the stable's name | 5 minutes | No |
| `traffic-same-hash` | An update runs (the current template is not the stable one), the canary has weight (the router's reported weight, else the route's, else the step's), and the DestinationRule's canary and stable subsets — or the canary and stable Services' selectors — carry the same `rollouts-pod-template-hash`: the canary's traffic goes to the stable pods | 5 minutes | No |

**Canary safety** (`canary-safety`, opt-in: off until you turn it on with the category's switch on the Problems page
or in Settings → Notifications; never given to agents, whose tool tells the same as warnings). Decided by the
backend's judge `safety` from the templates' metrics and dry-run rules and the Rollouts' strategy. They point at how a
pipeline is set up, not at something broken, so none of them is on by default:

| Id | When it holds | Grace | Told by another object |
|---|---|---|---|
| `template-metric-always-passes`, `cluster-template-metric-always-passes` | A metric (not of a `job`, `kayenta` or plugin provider, which decide themselves) has neither a successCondition nor a failureCondition: every measurement is a success | None | No |
| `template-metric-nan-passes`, `cluster-template-metric-nan-passes` | A metric has only a failureCondition that does not test isNaN/isInf (a NaN, as 0/0 without traffic, makes the comparison false, so the measurement succeeds), or its successCondition accepts isNaN/isInf with `\|\|` | None | No |
| `template-metric-no-data-passes`, `cluster-template-metric-no-data-passes` | A metric's successCondition accepts an empty result (`len(result) == 0 \|\|`) or reads a `default(…)` | None | No |
| `template-metric-cannot-fail`, `cluster-template-metric-cannot-fail` | Without a consecutiveSuccessLimit, a metric's failureLimit is negative, or at least its count | None | No |
| `template-metric-dry-run`, `cluster-template-metric-dry-run` | A `dryRun` rule's regular expression covers the metric | None | No |
| `rollout-promoted-on-time` | A canary with traffic steps and no analysis step, experiment, pause without a duration or background analysis; or a blue-green with auto-promotion and neither pre- nor post-promotion analysis | None | No |
| `rollout-weights-without-check` | Without background analysis, the canary goes to a higher weight with no pause, analysis or experiment after the previous weight | None | No |
| `rollout-first-step-full` | The first traffic step sends the maximum traffic weight (100 unless `maxTrafficWeight` says otherwise) | None | No |
| `rollout-all-pods-unavailable` | The canary's maxUnavailable is "100%", or a number at least the replicas (with more than one) | None | No |

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
patch goes first and the spec patch second, each once, together in one `resources.patchMany`: the first that fails
stops the rest. The window is the only question; Sextant does not ask again (the Modify rule's `confirm: false`), but
still checks every patch against the extension's grants and journals it. Where the status subresource is missing,
Sextant refuses the status patch before sending anything, and the unified patch is sent instead, once, with no
further question. An action that has nothing to change (Pause of a Rollout already paused by hand) cannot be
confirmed.

## What it does not do

- It does not run `kubectl argo rollouts` or talk to the Argo Rollouts dashboard: everything goes through the
  Kubernetes API.
- It does not set an image, edit steps or create Rollouts: Sextant's editor does that.
- It does not restart: Sextant's own Restart action does.
- It does not show Argo Workflows or Argo CD, which share the group `argoproj.io`.
- It does not query Prometheus or any other metric provider: the agent tool tells the measurements the AnalysisRuns
  recorded, and the safety checks read the templates as written. Whether a threshold suits an environment (prod or
  test) is not judged: nothing in the objects says which environment a cluster is.
- Its agent tool changes nothing and runs no command.

## Requirements and limits

- The Argo Rollouts CRDs, and the controller for anything to happen after an action.
- The table's columns are computed by Sextant from field paths (ADR-0153), so where the former built-in view
  computed a value they show the closest field:
  - **Status** is `status.phase`, with a spec the controller has not observed yet, its not-yet-observed unpause and
    a referenced workload not yet observed shown as Progressing, as before the move. On hover it shows the
    controller's message, and for a spec not observed yet the built-in view's explanation ("The controller has not
    seen the latest spec yet."); the other computed states have no explanation on hover, which the details give. Of
    an older controller's computed phase only Degraded, Paused and an update under way (Progressing) are shown; its
    Healthy and its other Progressing (from replica counts) are left blank. The details always show the full reading.
  - **Weight** is the set weight, as the built-in column; the weight the router reports (the actual weight) is in
    the details.
  - **Message** of an AnalysisRun is its own message, else the message of a failed, errored or inconclusive metric
    (in that order, not the metrics' order), else of its first measurement of that phase (the oldest, not the
    newest). The templates' **Metric** is the first metric only. The details list all of them.
- Promote and Promote fully are offered a little more widely than they apply: "an update is under way" (the current
  template is not the stable one) is one of several alternatives of theirs, and Sextant's conditions do not nest that
  deep, so they stand on the phase there. Their windows check exactly and say why when they do not apply. Abort,
  Retry, Pause and Resume are offered exactly where they apply.
- A Degraded problem of a controller older than v1.0 reads "The rollout is Degraded: " with `status.message`, blank
  where the controller writes none; the built-in view named the condition there ("ProgressDeadlineExceeded: …"). The
  details show the condition.
- A problem and the failed analysis that caused it are listed as separate problems, but notify once.
- An Analysis Run or Experiment that failed is not marked under "Only problems": no problem rule watches them.
- Checked against the patches of `kubectl argo rollouts`, including v0.9's fallback, by tests; not tried on a
  cluster running Argo Rollouts v0.9.
- Traffic is checked for Istio (VirtualServices' HTTP routes and the DestinationRule's subsets) and the canary and
  stable Services; TLS and TCP routes are not read, and the other routers (NGINX, ALB, SMI, Ambassador, App Mesh,
  Traefik, APISIX, plugins) are named in the agent tool's `notChecked`, not judged. A route's destination host is
  compared up to its first dot, as the controller does.
- The judges get at most 5000 objects of a kind; past that (or where a list is not read in full) they cannot tell
  and give no problem.
- The canary-safety checks recognise the common forms of a condition that passes without data or on NaN; a condition
  written otherwise is not caught. They are hints about intent, which is why they are opt-in.
- `traffic-same-hash` is not judged during the short moment the controller waits for the new ReplicaSet before it
  switches the canary subset: it sets no weight before that, and the rule waits 5 minutes.

## Troubleshooting

- **No "Argo Rollouts" section:** the cluster serves none of its kinds, or the extension is disabled.
- **"Sextant refused: …" in an action's window:** the extension's permissions do not cover the Rollout, or you
  declined Sextant's confirmation. Check Settings → Extensions → Argo Rollouts.
- **"The rollout changed while this dialog was open":** the Rollout moved on between reading and sending; check the
  new patches and confirm again.
- **No ReplicaSets or analysis runs in the details:** your credentials may not list them in the Rollout's namespace;
  the section says the cluster refused.
- **An agent does not see `diagnose-rollout`:** turn the extension on under tools of extensions in Settings → AI
  agents (MCP). Its problems reach `get_problems` only when you let agents get the extension's problems there too;
  `get_problems` names an extension whose problems you keep from agents in `notShared`.
- **The agent tool's `notChecked` names a read:** your credentials or the agent's access in Sextant do not cover that
  kind there; the rest of the answer stands.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/argo-rollouts        # → extensions/argo-rollouts/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts extensions/argo-rollouts
```

- `src/main.ts` picks the view by the frame's context: `details.ts` (the four details sections, drawn with the SDK's
  `ui` kit, `live.ts` for a Rollout's lists) or `actions.ts` (the action windows).
- `model.ts` reads Argo Rollouts' fields; `patches.ts` builds every patch and says exactly when each action applies.
- `traffic.ts` (where a canary's traffic goes) and `safety.ts` (how safe its checks are set up) are pure readings
  shared by `judges.ts` (the backend's problem judges, over the fields Sextant sends) and `diagnose.ts` (the agent
  tool, over a `Reader`); `agentTools.ts` reads the tool's arguments; `backend/main.ts` wires both to `host`;
  `workload.ts` is the Deployment section. `diagnose.test.ts` tests them.
- `model.test.ts` judges the manifest's problem rules, action conditions and column cases with Sextant's own window
  engine (`src/extensions/problemRules.ts`) and compares them with the model, on the fixtures in `fixtures/`.
- The texts are in `src/locales/<lang>.json` (English is the source) and in the manifest's `translations`.
  `src/locales.test.ts` keeps both complete in every language of Sextant's `src/locales/`. The column cases are the
  API's own words (Healthy, Paused, Canary, …), shown as written beside the `status.phase` values: their translations
  are the English words, and each case carries its own tone.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `argo-rollouts`
     and the commit.
  3. The catalog's index picks the release up.
