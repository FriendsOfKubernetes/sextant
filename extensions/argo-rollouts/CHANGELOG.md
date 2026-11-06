# Changes of Argo Rollouts

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
