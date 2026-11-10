# Kueue

Read-only views of [Kueue](https://kueue.sigs.k8s.io/) (`kueue.x-k8s.io`), in every language Sextant has. It lists
ClusterQueues, LocalQueues, Workloads, ResourceFlavors, Cohorts, AdmissionChecks and WorkloadPriorityClasses in a sidebar
section of their own with Sextant's tables; tells a ClusterQueue's quota against what is reserved and in use per flavor
and resource, the LocalQueues pointing at it and the Workloads waiting in them with the reason each waits; tells why a
Workload waits, was evicted or deactivated and which job it belongs to; and gives every job Kueue queues a "Queue"
section with its Workload. It reports queues that admit nothing and, in an opt-in category, Workloads waiting too long,
not queueable or evicted repeatedly. It replaces Sextant's former built-in Kueue view (ADR-0114) with the same
behaviour. Its id is `sextant.kueue`. Why it is built this way: ADR-0114 (the readings and problems), ADR-0139
(Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of its own, `not` in rules), ADR-0153
(computed columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths
picking an item, notification groups, lists counted as lengths), ADR-0163 (field values in texts, a problem's reason
from the object), ADR-0164 (case tooltips, deeper conditions) and ADR-0167 (the counter's own label, more rules,
problem categories of its own, the muted tone, column widths and sort values, tooltip fallbacks, text conditions,
sums and map entries, a rule's literal reason and progress stamp, details sections without a heading or hidden until
shown, capped watches, blocks in Sextant's memory).

## At a glance

| | |
|---|---|
| Id | `sextant.kueue` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `kueue-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Kueue |
| Checked against | Kueue's objects as kubernetes-sigs/kueue writes them (`kueue.x-k8s.io/v1beta2` and `v1beta1`: `apis/kueue/v1beta2`, `pkg/scheduler`, `pkg/controller/core`, `pkg/workload`) |

## What it adds

**A sidebar section "Kueue"** (`kueue`), shown while the cluster serves Kueue's kinds, with the built-in section's
icon, right after Dynamic Resource Allocation's: Cluster Queues, Local Queues, Workloads, Resource Flavors, Cohorts,
Admission Checks and Workload Priority Classes, each with its own icon, Sextant's own table, filters, selection bar and
details, and Edit and Delete as on every kind. The section's counter shows how many queues need attention and, while
the opt-in category is on, how many Workloads (the problems below). The kinds are read in the version the cluster
serves, v1beta2 or v1beta1 (`cohortName`/`cohort`, `flavorsUsage`/`flavorUsage`, `priorityClassRef`/`priorityClassName`).

**"Only problems"**, as the built-in tables had it, from the problem rules (their grace periods included):
ClusterQueues and LocalQueues that admit nothing, Workloads waiting too long, not queueable, deactivated by Kueue or
evicted repeatedly.

**Columns**, after Name (and Namespace), in place of the CRDs' own printer columns (left out, as the built-in view did),
in the built-in columns' widths:
- ClusterQueue: **Status** (`cq-status`: Active, Stopped, Terminating, Inactive or Unknown from the `Active` condition,
  coloured, its reason and message on hover, sorted and filtered by the state's name), **Cohort** (`cq-cohort`),
  **Pending** (`cq-pending`), **Reserving** (`cq-reserving`), **Admitted** (`cq-admitted`) Workloads, **Strategy**
  (`cq-strategy`, BestEffortFIFO when unset).
- LocalQueue: **Status** (`lq-status`), **ClusterQueue** (`lq-cluster-queue`), **Pending** (`lq-pending`),
  **Reserving** (`lq-reserving`), **Admitted** (`lq-admitted`).
- Workload: **Status** (`wl-status`: Finished, Failed, Deactivated, Admitted, Evicted, Quota reserved, Inadmissible or
  Pending, coloured, the condition Kueue wrote on hover, sorted and filtered by the state's name; a Workload not
  queueable only because its queue is stopped or inactive is Pending, told through the queue), **LocalQueue**
  (`wl-queue`), **ClusterQueue** (`wl-cluster-queue`), **Owner** (`wl-owner`, `Kind/name` of the job: the controller
  owner reference, else the first, else a composed job's `kueue.x-k8s.io/job-owner-gvk`/`-name` annotations, the kind after the GVK's `, Kind=`),
  **Priority** (`wl-priority`), **Evictions** (`wl-evictions`: the eviction counts added up, else the requeue count).
- ResourceFlavor: **Node labels** (`rf-node-labels`, `key=value` in key order, joined with ", "), **Topology** (`rf-topology`). Cohort:
  **Parent** (`cohort-parent`). AdmissionCheck: **Status** (`ac-status`), **Controller** (`ac-controller`).
  WorkloadPriorityClass: **Value** (`pc-value`), **Description** (`pc-description`).

**Details**, drawn with the SDK's UI kit in the classes of Sextant's own details panel, without headings of their own
as the built-in sections had none; their blocks open and close as the built-in panel's did, remembered in Sextant's
own memory of details sections (Settings → Appearance, "Expand all", "Collapse all"):
- a section **Kueue** (`kueue`) on the Kueue kinds:
  - ClusterQueue: why it admits nothing (or that its stop policy stopped it); its state, cohort, queueing strategy, the
    namespaces it accepts, stop policy, preemption, admission checks and Workload counts; the quota table (flavor,
    resource, quota, reserved with its share of the quota and the borrowed part, in use, borrowing and lending limits);
    the LocalQueues pointing at it; the Workloads waiting in them (the oldest 50, with how long and why);
  - LocalQueue: its state, ClusterQueue, stop policy and counts, its usage per flavor and resource, and its waiting
    Workloads;
  - Workload: what its state means and the condition Kueue wrote, its job (a link), queues, priority and priority
    class, evictions, requeue time and maximum execution time; its pod sets (pods, requests, assigned flavors), its
    admission checks and its eviction counts;
  - ResourceFlavor (node labels, taints, tolerations, topology), Cohort (parent, quota) and AdmissionCheck (state,
    controller, parameters), each with the ClusterQueues that use it; WorkloadPriorityClass (value, description);
- a section **Queue** (`queue`), one block, on the jobs Kueue queues — Job, JobSet, RayJob, RayCluster, PyTorchJob,
  TFJob, XGBoostJob, PaddleJob, JAXJob, MPIJob, TrainJob, LeaderWorkerSet and AppWrapper — shown for a job with the
  `kueue.x-k8s.io/queue-name` label or a Workload of it (a job Kueue manages without the label too), where the cluster
  serves Workloads: its LocalQueue and its Workload, found in the job's namespace by the label Kueue puts on it
  (`kueue.x-k8s.io/job-uid=<uid>`) or the prebuilt Workload's name (`kueue.x-k8s.io/prebuilt-workload-name`,
  annotation or label), with the Workload's state, why it waits and its queues.

What a block lists is watched only while it is open, as the built-in view's: a ClusterQueue's LocalQueues while its
LocalQueues or waiting list is open, every Workload of the cluster (at most 5000, as the built-in problems source kept,
saying when there are more) while a queue's waiting list is open; a job's Workloads while its Queue block is open, or
once while it is closed to know whether to show it. Every object named is a link to its details in Sextant's panel.
The tables' columns resize (drag a header's right edge) and Sextant remembers their widths, as the built-in view's
did; the same columns keep to one line, the others wrap between words.

## Permissions

- **Read** the Kueue kinds (each section reads the object it shows; a ClusterQueue's details list every LocalQueue and
  Workload, a LocalQueue's every Workload, a flavor's, cohort's and check's every ClusterQueue), in every namespace of
  every cluster.
- **Read** the jobs it gives a Queue section to (Job, JobSet, RayJob, RayCluster, the Kubeflow jobs, TrainJob,
  LeaderWorkerSet, AppWrapper): the section reads the job it shows.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge ClusterQueues, LocalQueues and Workloads; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

Both categories are the extension's own, as the built-in ones were Sextant's own and never given to agents: the queue
rules are **"Kueue queues"** (`queues`, the built-in `kueue`), on by default; the Workload rules are **"Kueue Workloads
waiting or evicted"** (`workloads`, the built-in `kueueWorkloads`), off until it is turned on with the opt-in toggles
on the Problems page. Every rule may notify. The queue rules form one notification group, the two waiting rules one,
the deactivation rule one and the eviction rules one. A queue's reason is Kueue's own (`FlavorNotFound`,
`AdmissionCheckNotFound`, `CohortCycle`, …, "Inactive" when it gives none); a Workload's is `PendingQuota`,
`Inadmissible`, `Deactivated` or `EvictedRepeatedly`, as the built-in view named them. A grace counts from the
condition's `lastTransitionTime` (from when Sextant first saw it without one). A repeatedly evicted Workload counts as
first seen again whenever its eviction count changes, as the built-in problem did.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `cluster-queue-inactive` | ClusterQueue | `Active` False for a reason other than `Stopped` or `Terminating`, not being deleted; reason "Inactive" when Kueue gives none | 2 min | No |
| `local-queue-without-cluster-queue` | LocalQueue | `Active` False with `ClusterQueueDoesNotExist` (a LocalQueue of an inactive ClusterQueue is told through the ClusterQueue) | 2 min | No |
| `workload-pending-quota` | Workload | Not finished, active, not admitted or evicted, `QuotaReserved` False for one of the scheduler's waiting reasons (`Pending`, `WaitingForQuota`, `NoMatchingFlavor`, `ExceedsMaxQuota`, `TopologyPlacementFailed`, `WaitingForPreemptedWorkloads`, `WaitingForPodsReady`, `Waiting`), with its message | 30 min | No |
| `workload-inadmissible` | Workload | The same with `Inadmissible`, `Misconfigured` or `DRAResourcesUnresolved`, unless the message says the queue "is stopped" or "is inactive" | 5 min | Yes: a stopped or inactive queue, through the queue |
| `workload-deactivated` | Workload | Not finished, `spec.active` false, a failure in the Evicted or DeactivationTarget reason (the requeuing limit, the maximum execution time, an admission check), or — where the Evicted reason names no cause, as older Kueue writes it — in the cause of a `Deactivated`/`InactiveWorkload` eviction count | None | No |
| `workload-evicted-repeatedly` | Workload | Not finished, active, evicted 3 times or more by the eviction counts added up, while evicted and for an hour after the last eviction, with the Evicted condition's message | None | No |
| `workload-evicted-repeatedly-unexplained` | Workload | The same without the condition's message: "Evictions so far: N" | None | No |
| `workload-evicted-repeatedly-requeued` | Workload | The same without eviction counts, by the requeue count, with the condition's message | None | No |
| `workload-evicted-requeued-unexplained` | Workload | The same by the requeue count without the message: "Evictions so far: N" | None | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0114).

## What it does not do

- It does not create, stop, resume or delete queues, change quotas, or activate, deactivate or requeue Workloads.
- It does not recompute what Kueue decides: every state shown is Kueue's own from the objects; the quota shares are
  the reserved quantity over the nominal quota.
- It does not read Kueue's visibility API (pending positions); the waiting lists are the Workloads' own conditions.

## Requirements and limits

- Kueue's CRDs (`kueue.x-k8s.io`, v1beta2 or v1beta1); the section shows only where the cluster serves them.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - The Workloads' category has one title, "Kueue Workloads waiting or evicted", on the Problems page's toggle and in
    the lists; the built-in category was "Kueue Workloads" in the lists, with that text on its toggle only.
  - A stopped or inactive queue is read in a `QuotaReserved` message by " is stopped"/" is inactive" after a space or
    at the start of it, as Kueue writes it; the built-in view's word boundaries also took other punctuation before
    "is", and refused a letter after.
  - Where the Evicted reason names no cause (older Kueue), a deactivation's cause written inside a longer text is found
    in the first 6 eviction counts; further down only the causes Kueue writes (`RequeuingLimitExceeded`,
    `MaximumExecutionTimeExceeded`, `AdmissionCheck`) are, as they are. The built-in view searched every count.
  - The Queue section asks once per job whether the cluster serves Workloads; the built-in one followed discovery while
    open (Kueue installed meanwhile shows on reopening the details).
  - Waiting Workloads created in the same second are listed by namespace and name; the built-in list kept the order
    the watch gave.
- Checked by tests on fixtures of Kueue's objects (copied from the built-in view) against the built-in readings and
  rules; not yet tried on a live cluster.

## Troubleshooting

- **No "Kueue" section:** the cluster does not serve Kueue's kinds, or the extension is disabled.
- **No Workload problems:** the category "Kueue Workloads waiting or evicted" is opt-in; turn it on on the Problems page.
- **"The list could not be read." in a section:** the extension may not read that kind there, or the cluster refused
  your credentials.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Kueue.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/kueue        # → extensions/kueue/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/kueue
```

- `src/main.ts` starts the details sections; `details.ts` draws them with the SDK's `ui` kit and holds their watches.
- `model.ts` reads Kueue's fields; it is the former built-in view's model, ported, with its problem detectors
  (`queueProblems`, `workloadProblems`) and filter (`isProblem`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules (which also make "Only problems") and the columns with Sextant's
  own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model
  on the fixtures in `fixtures/` and variants of them; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `kueue` texts)
  and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of Sextant's
  `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `kueue` and the
     commit (add `kueue` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
