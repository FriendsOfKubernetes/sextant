# Changes of Argo Workflows

## 1.0.0 — 2026-11-07

Needs Sextant 0.30 (`sextantApi` 4), with the map entries, `enteredWithin`, `notifyAs`, list cells and a kind's own
"Only problems" of ADR-0165 (#392–#396). The first release: Sextant's former built-in Argo Workflows view (ADR-0097)
as an extension (#397).

- **A sidebar section "Argo Workflows"** after Velero's, with Workflows, Cron Workflows, Workflow Templates and
  Cluster Workflow Templates in Sextant's tables, and the built-in columns: a Workflow's phase, progress, duration and
  failed step; a CronWorkflow's schedule, suspension, active runs and last run; a template's entrypoint and number of
  templates.
- **Details:** a Workflow's fields, its failed step and message, its CronWorkflow and template, how to retry it, and
  its step tree with each pod linked and its logs in Sextant's logs tab; a CronWorkflow's schedule and runs; a
  template's entrypoint and templates.
- **Actions:** Suspend, Resume, Stop and Terminate, each in a window that lists the exact patch `argo` sends and is the
  only question.
- **Problems:** Workflows that failed or errored within a day, counted on the section, a CronWorkflow's runs notifying
  as one.
- Installing asks for consent to read the four kinds, modify Workflows without a second question, open pods' logs,
  and judge Workflows in problem rules.
