# Changes of Argo Rollouts

## 1.4.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4), with `atLeast`, a column's `lookup` and `valueText` of ADR-0164 (#386, #387).

- **Weight** is the set weight again, exactly as the built-in column showed it (`GetCurrentSetWeight`): the
  `setWeight` of the current step or of the nearest earlier one (0 before any), 0 after an abort, and the maximum
  traffic weight (100 unless `maxTrafficWeight` says otherwise) once every step is done or without steps; written
  "20%", in each language's form ("20 %" in French and German, "%20" in Turkish); blank for blue-green. It sorts and
  filters by the number, "0%" after an abort and "100%" once every step is done included. The weight the
  traffic router reports stays in the details as the actual weight.
- **Status** and the `degraded` rule count the newest spec as observed when `status.observedGeneration` is at least
  `metadata.generation` (it was: equal to), as the built-in view did; v0.9's hash still counts as observed.
- No new permission or problem kind: updating asks for no consent again.

## 1.3.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4), with the deeper conditions and case tooltips of ADR-0164 (#385).

- **Problems:** Degraded is one rule again, `degraded`, judged exactly as the built-in view judged it for every
  controller: Argo Rollouts v1.0 and newer by `status.phase`, older ones by their InvalidSpec, RolloutAborted or
  ProgressDeadlineExceeded condition, and never while the controller has not observed the newest spec (v0.9's hash
  in `observedGeneration` counts as observed). `degraded-older-controller` is gone: an older controller that has not
  observed the newest spec is no longer shown Degraded. The rules still judge only Rollouts, so updating asks for no
  consent again.
- **Status** of a Rollout whose newest spec the controller has not observed yet says so on hover: "The controller has
  not seen the latest spec yet.", in every language, as the built-in view did.
- No new permission.

## 1.2.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4). The last differences from Sextant's former built-in view (#377).

- **Status** of a Rollout whose newest spec the controller has not observed yet (`status.observedGeneration` behind
  `metadata.generation`) is Progressing, whatever the old phase says; such a Rollout is not Degraded either. Argo
  Rollouts v0.9's hash in `observedGeneration` counts as observed, as before.
- **Problems:** Degraded of a controller older than v1.0 (which writes no `status.phase`) is a rule of its own,
  `degraded-older-controller`, titled "Degraded (before Argo Rollouts v1.0)" on the consent screen; its problems still
  read "Degraded" (its `reason`), and it is in the same notification group.
- **Step** shows 0/n before the controller writes the step index, as `kubectl argo rollouts` does.
- **One question per action:** the action's window, which lists the exact patches, is the only one; Sextant no
  longer asks again (the Modify rule's `confirm: false`). Updating to 1.2.0 asks to agree to the changed grant once.
- **Argo Rollouts v0.9** (no status subresource): Sextant refuses the status patch before anything is sent or
  asked, and the extension then sends the unified patch the plugin sends instead, once, with no second question.
  (1.1.0 fell back only when the status patch itself failed, and showed Sextant's refusal as an error.)
- **Weight** stays the weight the traffic router reports, as `kubectl argo rollouts get` shows it; the set weight is
  in the details.

## 1.1.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4). Closer to Sextant's former built-in view, with what the extension API gained
(ADR-0160, ADR-0161).

- **The section** has the built-in section's icon and its place after Argo CD's, where the built-in section was (`contributes.sections`, ADR-0162).
- **The tables** show only the extension's columns, as the built-in view did: the CRDs' own printer columns
  (Desired, Current, Up-to-date, Available, Status) are left out, and the columns follow Name and Namespace in the
  built-in order (Status, Strategy, Step, Weight, Ready; Phase, Rollout, Message).
- **Step** shows "i/n", the current step of the number of steps.
- **Status** of a Rollout whose template comes from a workload not observed yet is Progressing, and an older
  controller's update under way is Progressing too; the case texts keep their tones in every language.
- **Rollout** of an AnalysisRun or Experiment is the owner that is a Rollout, not the first owner; **Message** of an
  AnalysisRun is its own message, else the failed, errored or inconclusive metric's (or its measurement's), never a
  successful metric's.
- **Abort** is offered only while the current template is not the stable one, exactly as before the move.
- **One confirmation per action:** the status and the spec patch go together (`resources.patchMany`); Promote of a
  Rollout paused by hand asks once, not twice.
- **Problems** share one notification group, so an analysis that fails and aborts the update notifies once;
  Degraded follows the phase reading exactly (a stale condition beside a phase, an unpause or a workload not
  observed yet is not Degraded).
- **Details** use Sextant's own blocks, fields, tables and links (the SDK's UI kit), and a Metrics section of a
  template without metrics is hidden.
- No new permission.

## 1.0.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in Argo Rollouts view as an extension.

- **A sidebar section "Argo Rollouts"** with Rollouts, Analysis Runs, Analysis Templates, Cluster Analysis Templates
  and Experiments in Sextant's own tables, with a counter of the Rollouts that need attention.
- **Columns:** a Rollout's status, strategy, step, weight and readiness; an AnalysisRun's or Experiment's phase,
  Rollout and message; a template's first metric.
- **Details:** a Rollout's status in plain words, canary steps, set and actual weight, Services, ReplicaSets by role
  and analysis runs; an AnalysisRun's metrics with the failing measurement; an Experiment's templates and analyses;
  a template's metrics.
- **Promote, Promote fully, Abort, Retry, Pause and Resume**, each offered where it applies, sending exactly the
  patches of `kubectl argo rollouts` after showing them, with the v0.9 fallback.
- **Problems:** Degraded and aborted Rollouts and failed or errored analyses, which may notify.
- Installing it asks to read the Argo Rollouts kinds and ReplicaSets, to modify Rollouts (confirmed every time) and
  to patch their status, and for its problem rules on Rollouts.
