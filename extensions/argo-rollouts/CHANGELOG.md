# Changes of Argo Rollouts

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
