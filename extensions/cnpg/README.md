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
conditions), ADR-0165 (a kind's own "Only problems") and ADR-0167 (the counter's label by plural form, and its
amendments: reason and time fallbacks, text conditions, deeper rules, column widths, muted tones and sort values, a
case's tooltip fallbacks, an untitled details section, blocks in Sextant's own memory, case-blind comparisons and
non-empty texts, a source's cap).

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
  Unhealthy, coloured, Hibernated and Hibernating greyed; the operator's phase and its reason on hover), **Instances**
  (`cluster-instances`: ready of desired, `status.readyInstances` of `spec.instances`, else of `status.instances`),
  **Primary** (`cluster-primary`: `status.currentPrimary`) and **Phase** (`cluster-phase`: the operator's phase).
- Backups: **Status** (`backup-status`: Completed, Failed, Running or Pending, coloured, Pending greyed; the error on
  hover),
  **Cluster** (`backup-cluster`), **Method** (`backup-method`: `barmanObjectStore` when none is set) and **Started**
  (`backup-started`: the age of `status.startedAt`).
- Scheduled Backups: **Cluster** (`scheduled-cluster`), **Schedule** (`scheduled-schedule`), **Suspended**
  (`scheduled-suspended`: True or False) and **Last backup** (`scheduled-last-backup`: the age of its last run).
- Poolers: **Cluster** (`pooler-cluster`), **Type** (`pooler-type`: `rw` when none is set), **Instances**
  (`pooler-instances`) and **Pool mode** (`pooler-pool-mode`: PgBouncer's).

The columns have the built-in widths; the status columns sort and filter by the state's name (`failover`, `healthy`,
…, the same in every language) and Instances by its text, as the built-in tables did.

**Details** (`cnpg`, one section on the four kinds where the built-in section was, without a heading as it had none;
"CloudNativePG" is its accessible name):
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

The blocks (Instances, Backups, a Backup's Error) open and close with their titles, kept in Sextant's own memory of
details sections as the built-in blocks were: per kind as Settings → Appearance says, with the panel's "Expand all"
and "Collapse all". The details are drawn with the
SDK's UI kit, in the classes of Sextant's own details panel. Edit and Delete are
Sextant's own actions on every kind of the section; the extension adds no action.

## Permissions

- **Read** Clusters, Backups, ScheduledBackups and Poolers (the details read the shown object), in every namespace of
  every cluster.
- Nothing is changed or deleted, and no log is read. Pods are only linked to, never read by the extension.
- Its problem rules judge Clusters and Backups; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

On Clusters and Backups, from Sextant's own watches of the whole objects (at most 20 000 of each per cluster). A
problem's reason is the built-in one: `FailingOver`, the Ready condition's reason, else `ClusterNotReady`; the
archiving or backup condition's reason, else `ContinuousArchivingFailing` or `LastBackupFailed`; or `BackupFailed`.
Every problem may notify.

A Cluster is **not ready** when it is not being deleted, is not hibernating (hibernation, the annotation
`cnpg.io/hibernation: "on"`, is a steady state the user asked for, never a problem, unless the operator waits for a
healthy cluster before it starts), and its Ready condition is False, or fewer instances are ready than wanted
(`readyInstances`, 0 when left out, below `spec.instances`, else `status.instances`) while it is not healthy (its
phase is not "Cluster in healthy state", or the primary is changing). It counts five minutes after its Ready condition
last changed. Its reason is `FailingOver` while it fails over (the phase "Failing over", or a pending target primary),
else the Ready condition's reason, else `ClusterNotReady`; its message is the phase's reason, else the phase. A rule
has one reason and one message template, so this one built-in rule is four rules, one per reason and message; they
never hold together, are one problem group (`not-ready`) and notify once per Cluster.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `cluster-failing-over` | Cluster | Not ready while failing over, with a phase reason (its message) | 5 min after Ready changed | No |
| `cluster-failing-over-phase` | Cluster | The same without a phase reason (the phase as its message) | 5 min | No |
| `cluster-not-ready` | Cluster | Not ready, not failing over, with a phase reason (its message) | 5 min | No |
| `cluster-not-ready-phase` | Cluster | The same without a phase reason (the phase as its message) | 5 min | No |
| `archiving-failing` | Cluster | Its `ContinuousArchiving` condition is False; from the condition's change, with its message | None | No |
| `last-backup-failed` | Cluster | Its `LastBackupSucceeded` condition is False; from the condition's change, with its message | None | No |
| `backup-failed` | Backup | Failed (`failed` or `walArchivingFailing`, in any case), less than a day after it stopped: the first time known of `status.stoppedAt`, `reconciliationTerminatedAt` (the operator's `SetAsFailed` leaves only that), `startedAt`, `reconciliationStartedAt` and the creation; for good without any; its error as the message | None | No |

A Cluster or Backup being deleted has none of these problems.

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
- The columns and problems are computed by Sextant from field paths (ADR-0153, ADR-0137). Tests compare them with the
  built-in reading over every combination of the fields it reads (25 984 Clusters, every Backup phase in any case and
  every time field) and match it. What remains:
  - A Backup's time that is there but not a time is skipped for its start (`sinceOr`) but not for its day; the API
    server accepts only RFC 3339 times in these fields, so it does not happen.
  - A primary's name or a phase's reason of blanks only counts as none (`exists` with `nonEmpty` takes a blank text for
    nothing); the built-in took any text but an empty one. Pod names cannot be blank and the operator writes no blank
    reason; telling them apart would take more than a rule's 40 conditions.
- Sextant watches at most 20 000 Clusters and 20 000 Backups per cluster for the problems (the most a rule's source
  may ask); the built-in watched them without a cap.
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
  the SDK's test host, the blocks' memory included.
- The texts are in `src/locales/<lang>.json` (English is the source; they are the built-in view's `cnpg` texts) and
  in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of Sextant's
  `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `cnpg` and the
     commit (add `cnpg` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
