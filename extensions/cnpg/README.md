# CloudNativePG

Views of [CloudNativePG](https://cloudnative-pg.io/) PostgreSQL clusters, in every language Sextant has. It lists
Clusters, Backups, ScheduledBackups and Poolers in a sidebar section of their own with Sextant's tables, tells a
Cluster's state in words (healthy, hibernated, switchover, failing over, progressing, unhealthy), its instances with
their roles and health, its primary and a primary change in progress, its backups and continuous archiving, and
counts unhealthy Clusters, failing archiving or backups and failed Backups as problems. It is read-only. It replaces
Sextant's former built-in CloudNativePG view (ADR-0100) with the same behaviour. Its id is `sextant.cnpg`. Why it is
built this way: ADR-0100 (the readings and the problems), ADR-0139 (Sextant's own extensions), ADR-0140
(translations), ADR-0152 (kinds in a section of its own, a kind's conditions), ADR-0153 (computed columns), ADR-0160
(the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths picking a list item, notification
groups, hidden details sections), ADR-0163 (a problem's reason from the object), ADR-0164 (case tooltips, deeper
conditions), ADR-0165 (a kind's own "Only problems") and ADR-0167 (the counter's label by plural form).

## At a glance

| | |
|---|---|
| Id | `sextant.cnpg` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `cnpg-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → CloudNativePG |
| Checked against | CloudNativePG's `postgresql.cnpg.io/v1` objects as the operator writes them (`api/v1/cluster_types.go`, `backup_types.go`, `pkg/reconciler/hibernation`) |

## What it adds

**A sidebar section "CloudNativePG"** (`cnpg`), shown while the cluster serves one of its kinds, with the built-in
section's icon, right after Sealed Secrets' section: Clusters, Backups, Scheduled Backups and Poolers, each with
Sextant's own table, filters, selection bar and details. The section's counter shows how many objects need attention
(the problems below). "Only problems" shows the Clusters with a problem (without the five-minute grace) and every
failed Backup, recent or not, as the built-in tables did.

**Columns**, after Name and Namespace, in place of the CRDs' own printer columns (left out, as the built-in view did):
- Clusters: **Status** (`cluster-status`: Healthy, Hibernated, Hibernating, Switchover, Failing over, Progressing or
  Unhealthy, coloured; the operator's phase and its reason on hover), **Instances** (`cluster-instances`: ready of
  desired, `status.readyInstances` of `spec.instances`), **Primary** (`cluster-primary`: `status.currentPrimary`) and
  **Phase** (`cluster-phase`: the operator's phase).
- Backups: **Status** (`backup-status`: Completed, Failed, Running or Pending, coloured; the error on hover),
  **Cluster** (`backup-cluster`), **Method** (`backup-method`: `barmanObjectStore` when none is set) and **Started**
  (`backup-started`: the age of `status.startedAt`).
- Scheduled Backups: **Cluster** (`scheduled-cluster`), **Schedule** (`scheduled-schedule`), **Suspended**
  (`scheduled-suspended`: True or False) and **Last backup** (`scheduled-last-backup`: the age of its last run).
- Poolers: **Cluster** (`pooler-cluster`), **Type** (`pooler-type`: `rw` when none is set), **Instances**
  (`pooler-instances`) and **Pool mode** (`pooler-pool-mode`: PgBouncer's).

**Details** (`cnpg`, one section titled "CloudNativePG" on the four kinds, where the built-in section was):
- **Cluster**: a note on a switchover ("The primary is moving from … to …") or a failover, the reason of an unhealthy
  phase, a word on hibernation (the annotation `cnpg.io/hibernation: "on"`) or on a replica cluster; its state in
  words, phase, ready instances, the current and target primary (links to the pods), image and storage size; its
  **Instances** (each pod linked, its role, its health from `status.instancesStatus` and its timeline); its
  **Backups** (continuous archiving working or failing, the last backup, the last successful and failed backup, the
  first recoverability point, "No backup is set up" when there is none, and the failing conditions' messages).
- **Backup**: its state, its Cluster (a link), method, target, start and stop, backup id, destination, and the error of
  a failed one.
- **ScheduledBackup**: its Cluster (a link), schedule, whether suspended, method, last and next run.
- **Pooler**: its Cluster (a link), type, instances and pool mode.

The details are drawn with the SDK's UI kit, in the classes of Sextant's own details panel. Edit and Delete are
Sextant's own actions on every kind of the section; the extension adds no action.

## Permissions

- **Read** Clusters, Backups, ScheduledBackups and Poolers (the details read the shown object), in every namespace of
  every cluster.
- Nothing is changed or deleted, and no log is read. Pods are only linked to, never read by the extension.
- Its problem rules judge Clusters and Backups; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

On Clusters and Backups, from Sextant's own watches of the whole objects. A problem's reason is the built-in one:
`FailingOver`, the Ready condition's reason (`ClusterIsNotReady`), `ClusterNotReady`, the archiving or backup
condition's reason, or `BackupFailed`. Every problem may notify.

A Cluster is **not ready** when it is not being deleted, is not hibernating (hibernation, the annotation
`cnpg.io/hibernation: "on"`, is a steady state the user asked for, never a problem, unless the operator waits for a
healthy cluster before it starts), and its Ready condition is False, or fewer instances are ready than wanted while it
is not healthy (its phase is not "Cluster in healthy state", or the primary is changing). It counts five minutes after
its Ready condition last changed. Its reason is `FailingOver` while it fails over (the phase "Failing over", or a
pending target primary), else the Ready condition's reason, else `ClusterNotReady`; its message is the phase's
reason, else the phase. Sextant nests a rule's conditions at most three deep, so this one built-in rule is twenty
rules, one per readiness branch (a: Ready False; b: instances not ready, phase not healthy; c: instances not ready,
primary changing with the healthy phase), reason (`fp` failing over by the phase, `fo` to a pending primary, `rr` the
Ready condition's reason, `nc` no Ready condition) and message (`-phase`: the phase, without a phase reason); they
never hold together, are one problem group (`not-ready`) and notify once per Cluster.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `cluster-not-ready-a-fp`, `cluster-not-ready-a-fp-phase` | Cluster | Not ready, Ready False, failing over by its phase | 5 min after Ready changed | No |
| `cluster-not-ready-a-fo`, `cluster-not-ready-a-fo-phase` | Cluster | Not ready, Ready False, the target primary pending | 5 min | No |
| `cluster-not-ready-a-rr`, `cluster-not-ready-a-rr-phase` | Cluster | Not ready, Ready False, not failing over | 5 min | No |
| `cluster-not-ready-b-fp`, `cluster-not-ready-b-fp-phase` | Cluster | Instances not ready, phase not healthy, failing over by its phase | 5 min | No |
| `cluster-not-ready-b-fo`, `cluster-not-ready-b-fo-phase` | Cluster | Instances not ready, phase not healthy, the target primary pending | 5 min | No |
| `cluster-not-ready-b-rr`, `cluster-not-ready-b-rr-phase` | Cluster | Instances not ready, phase not healthy, not failing over, with a Ready condition | 5 min | No |
| `cluster-not-ready-b-nc`, `cluster-not-ready-b-nc-phase` | Cluster | Instances not ready, phase not healthy, not failing over, no Ready condition yet | 5 min | No |
| `cluster-not-ready-c-fo`, `cluster-not-ready-c-fo-phase` | Cluster | Instances not ready, the primary changing, the target primary pending | 5 min | No |
| `cluster-not-ready-c-rr`, `cluster-not-ready-c-rr-phase` | Cluster | Instances not ready, the primary changing, not failing over, with a Ready condition | 5 min | No |
| `cluster-not-ready-c-nc`, `cluster-not-ready-c-nc-phase` | Cluster | Instances not ready, the primary changing, not failing over, no Ready condition yet | 5 min | No |
| `archiving-failing` | Cluster | Its `ContinuousArchiving` condition is False; from the condition's change, with its message | None | No |
| `last-backup-failed` | Cluster | Its `LastBackupSucceeded` condition is False; from the condition's change, with its message | None | No |
| `backup-failed` | Backup | Failed (`failed` or `walArchivingFailing`), less than a day after `status.stoppedAt`; its error as the message | None | No |
| `backup-failed-terminated` | Backup | The same without `stoppedAt` (as the operator's `SetAsFailed` leaves it), timed from `reconciliationTerminatedAt` | None | No |
| `backup-failed-started` | Backup | The same without either, from `startedAt` | None | No |
| `backup-failed-reconciling` | Backup | The same without those, from `reconciliationStartedAt` | None | No |
| `backup-failed-created` | Backup | The same without any of them, from the Backup's creation | None | No |

The five Backup rules are the built-in rule's one time ("the first time known of"), one rule per field; they are the
group `backup-failed` and notify once per Backup. A Cluster or Backup being deleted has none of these problems.

## Metrics

None.

## Commands

None.

## Changes it makes

None: it only reads. Edit and Delete are Sextant's own actions, asked and confirmed by Sextant as on any kind.

## What it does not do

- It does not switch over, promote, hibernate, fence, restart or back up a cluster, and does not run the `cnpg`
  kubectl plugin: change the objects with Sextant's editor or the plugin.
- It does not read the instances' pods, PostgreSQL itself or the backups' object store.
- It does not show Databases, Publications, Subscriptions or ImageCatalogs.

## Requirements and limits

- The CloudNativePG CRDs, and the operator for the status to say anything.
- The columns and problems are computed by Sextant from field paths (ADR-0153, ADR-0137), so where the built-in view
  computed a value they read it as closely as fields allow; the details always show the full reading. Tests compare
  them with the built-in reading over every combination of the fields it reads (4320 Clusters, every Backup phase and
  time field):
  - **Unhealthy** is the operator's phases the built-in words (unrecoverable, cannot, unable, waiting for user, error)
    named, listed: CloudNativePG's phases of today and the older "Cluster is in an unrecoverable state, needs manual
    intervention" and "… due to an unknown image catalog". A phase the operator adds later and the built-in words
    would have matched reads as Progressing.
  - A Backup's phase is matched in lower case, Capitalised or upper case ("failed", "Failed", "FAILED"); the built-in
    view ignored case altogether. The operator writes lower case.
  - A Cluster's Ready, ContinuousArchiving and LastBackupSucceeded conditions are `metav1.Condition`s, which the API
    server keeps with a reason: the built-in fallbacks for a False condition without one (`ClusterNotReady`,
    `ContinuousArchivingFailing`, `LastBackupFailed`) are not repeated.
  - "Ready of desired" counts `spec.instances`, which the CRD requires (at least 1, defaulted); the built-in fell back
    to `status.instances` without it.
  - "Only problems" leaves out one corner: a Cluster with the healthy phase and fewer ready instances whose
    `currentPrimary` or `targetPrimary` alone is set (the operator sets both together) is listed there; the problems
    themselves are exact.
  - The Hibernated, Hibernating and Pending status words are not greyed in the tables: a computed column's tones are
    ok, warning, error and neutral (the details still grey them).
  - The tables sort the status columns by their words in the UI language, and Instances by its ratio, where the
    built-in sorted by the state's name and by the text; the columns' widths are Sextant's defaults.
  - The details have a section title ("CloudNativePG"), which the built-in section did not.
  - A problem's message is empty where the built-in had none; a Cluster's not-ready problem is one of twenty rules
    (above), told and counted as one.
- Problems are kept as Sextant keeps every extension's (at most 2000 objects with problems per kind and cluster).
- Checked by tests on fixtures of the operator's objects (a Cluster in a switchover with a failed instance, failing
  archiving and backups; a failed Backup); not yet tried on a live cluster.

## Troubleshooting

- **No "CloudNativePG" section:** the cluster serves none of its kinds, or the extension is disabled.
- **"Sextant refused: …" in the details:** the extension's permissions do not cover the object. Check Settings →
  Extensions → CloudNativePG.
- **No counter or no problems:** the problem rules need their own consent (Settings → Extensions → CloudNativePG),
  and the category can be turned off on the Problems page.
- **A hibernated cluster shows no problem:** that is meant; it shows "Hibernated" and why in its details.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/cnpg        # → extensions/cnpg/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/cnpg
```

- `src/main.ts` starts the one view, `details.ts` (the details section, drawn with the SDK's `ui` kit).
- `model.ts` reads CloudNativePG's fields: the former built-in model, ported, with the built-in problem rules
  (`cnpgProblems`, `isProblem`) as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules, "Only problems" and columns with Sextant's own window engine
  (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model over every
  combination of the fields it reads and on the fixtures in `fixtures/`; `views.test.ts` drives the details through
  the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they are the built-in view's `cnpg` texts) and
  in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of Sextant's
  `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `cnpg` and the
     commit (add `cnpg` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
