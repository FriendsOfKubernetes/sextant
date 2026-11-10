# KubeRay

Read-only views of [KubeRay](https://docs.ray.io/en/latest/cluster/kubernetes/index.html), the operator that runs
Ray on Kubernetes, in every language Sextant has. It lists KubeRay's RayClusters, RayJobs and RayServices
(`ray.io/v1`) in a sidebar section of their own with Sextant's tables; tells a RayCluster's state from its conditions
(or the deprecated `status.state`), its head pod, worker groups and pods with their logs, a RayJob's statuses, masked
entrypoint and submitter Job, and a RayService's readiness, Serve applications and masked serve configuration; and
reports failed clusters and jobs and services that are not ready. It replaces Sextant's former built-in KubeRay view
(ADR-0115) with the same behaviour. Its id is `sextant.kuberay`. Why it is built this way: ADR-0115 (the readings,
the masking, the problems), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a
section of its own, `not` around `olderThan`), ADR-0153 (computed columns), ADR-0156 (Sextant's logs tab), ADR-0160
(the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths picking an item, notification
groups), ADR-0163 (field values in texts, a problem's reason from the object), ADR-0164 (case tooltips, deeper
conditions), ADR-0165 (paths picking a map's value) and ADR-0167 (every match of a path, the counter's own label).

## At a glance

| | |
|---|---|
| Id | `sextant.kuberay` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `kuberay-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → KubeRay |
| Checked against | KubeRay's `ray.io/v1` objects as ray-operator/apis/ray/v1 writes them: the conditions of 1.2 and later, the deprecated `status.state` and `serviceStatus` of older operators |

## What it adds

**A sidebar section "KubeRay"** (`kuberay`), shown while the cluster serves one of its kinds, with the built-in
section's icon, in the built-in section's place: Ray Clusters, Ray Jobs and Ray Services, each with Sextant's own
table, filters, selection bar and details, and Edit and Delete as on every kind. The section's counter shows how many
KubeRay objects need attention (the problems below).

**"Only problems"**, as the built-in tables had it, at once (no grace): on Ray Clusters the failed ones and those whose
head pod is not ready; on Ray Jobs the failed ones, however long ago; on Ray Services the failed ones and those not
ready.

**Columns**, after Name and Namespace, in place of the CRDs' own printer columns (left out, as the built-in view did),
with the built-in widths:
- Ray Clusters: **Status** (`cluster-status`: Ready, Provisioning, Head not ready, Suspending, Suspended or Failed,
  coloured, Suspending and Suspended muted; on hover why it failed or waits: the failing condition's message or
  reason, else `status.reason`), **Workers** (`cluster-workers`: ready worker pods of desired, "1/3"; without
  `status.desiredWorkerReplicas` the replicas of the worker groups not suspended), **Head IP** (`cluster-head-ip`)
  and **Ray version** (`cluster-ray-version`).
- Ray Jobs: **Status** (`job-status`: Succeeded, Running, Pending, Retrying, Stopped, Suspended or Failed, coloured,
  Pending, Stopped and Suspended muted, KubeRay's message on hover), **Job status** (`job-job-status`, Ray's),
  **Deployment status** (`job-deployment-status`, KubeRay's), **Ray cluster** (`job-cluster`) and **Started**
  (`job-started`, an age).
- Ray Services: **Status** (`service-status`: Ready, Upgrading, Not ready, Suspended or Failed, coloured, Suspended
  muted; on hover the first failed Serve application's message, else a False Ready condition's message or reason),
  **Applications** (`service-applications`: the active cluster's Serve applications that run of all, "1/2"),
  **Endpoints** (`service-endpoints`) and **Active cluster** (`service-active-cluster`).

The Status columns sort and filter by the state, as the built-in ones (the same in every language); Workers and
Applications sort as their text.

**Details**, a section per kind without a heading of its own (as the built-in one), drawn with the SDK's UI kit in the
classes of Sextant's own details panel. Its blocks open and close with their titles and are remembered in Sextant's
own memory of details sections (Settings → Appearance), with the panel's "Expand all" and "Collapse all":
- **RayCluster** (`ray-cluster`): why it failed or waits (the failing condition or `status.reason`), its state, Ray
  version, workers ready of desired and their bounds ("no upper limit" for the largest int32), the head pod, its IP,
  the head Service and its IP, the endpoints and the requested resources; the worker groups with their desired pods,
  replica bounds, ready pods and suspension; and the cluster's pods (watched by KubeRay's label
  `ray.io/cluster=<name>` in its namespace while the section shows, at most 2000 kept, saying so when more match; at
  most 50 listed, the rest counted) with **Head logs** (the head pod) and **Worker logs** (the pods
  `ray.io/cluster=<name>,ray.io/node-type=worker`, a merged tab titled `raycluster/<name>`) in Sextant's logs tab,
  compact buttons with the logs icon in the Pods block's head.
- **RayJob** (`ray-job`): KubeRay's message (cut at 20 000 characters), its state, Ray's job status, KubeRay's
  deployment status and reason, its RayCluster and cluster selector, the submission mode, the submitter Job (only in
  `K8sJobMode`: a Job of the RayJob's own name) with **Submitter logs** (`job-name=<job>`, so titled), the job id, the dashboard
  URL (without credentials or query), its times and attempts, and the entrypoint as text with secret-looking flags and
  variables masked and URIs cleaned.
- **RayService** (`ray-service`): why it is not ready (a failed Serve application's message, else the Ready
  condition's), its state, the serve Service and endpoints, the upgrade strategy and an upgrade or rollback in
  progress; the active cluster and, during an upgrade, the pending one, each with its traffic, target capacity and
  Serve applications (status, healthy deployments, messages); and `serveConfigV2` with every `env_vars` value and
  every secret-looking value masked and URIs cleaned, or not at all when it does not read as one YAML mapping.

Every object named is a link to its details in Sextant's panel. Messages from the cluster lose the credentials,
queries and fragments of the URIs in them.
The tables' columns resize (drag a header's right edge) and Sextant remembers their widths, as the built-in view's
did; the same columns keep to one line, the others wrap between words.

## Permissions

- **Read** RayClusters, RayJobs and RayServices (each section reads the object it shows), and Pods (a RayCluster's
  pods, by label, for the pods table and the ready pods of each group), in every namespace of every cluster.
- **Logs** of Pods: "Head logs", "Worker logs" and "Submitter logs" open Sextant's logs tab, which reads them as your
  own logs tab does.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge RayClusters, RayJobs and RayServices; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `kuberay`, on by default, with the built-in reasons, messages, graces and notifications. A
suspended or deleted object is never a problem. Every rule may notify, once per object and state as the built-in
ones: a RayCluster's failure and its head not ready, a RayService's problems as one, and a RayJob's once per reason
(`notifyAgainOn` its `status.reason`). A rule's reason is the object's own (the condition's or the job's reason), else
the built-in fallback (`reasonOr`). The message is the one the built-in view gave: where a condition's message is
empty or missing its reason, and where it has neither the next one's words (placeholder paths tried in turn). The rules watch up to 20 000 RayClusters and RayServices and 5000 RayJobs.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `cluster-replica-failure` | RayCluster | `ReplicaFailure` is True: KubeRay cannot create or delete pods (reason the condition's, else "ReplicaFailure"; its message, else its reason, else a False `HeadPodReady`'s message or reason) | 5 min from the condition's change | No |
| `cluster-replica-failure-cluster` | RayCluster | The same, no condition with words: `status.reason` | 5 min from the condition's change | No |
| `cluster-failed` | RayCluster | `status.state: failed` (operators before 1.2; reason "RayClusterFailed", message a False `HeadPodReady`'s message or reason, else `status.reason`) | None | No |
| `cluster-head-not-ready` | RayCluster | `HeadPodReady` is False, not failed (reason the condition's, else "HeadPodNotReady") | 5 min from the condition's change | No |
| `job-failed` | RayJob | Failed (`jobDeploymentStatus` Failed, or `jobStatus` FAILED; never while Retrying), for a day after its end, else its start, else its creation (reason `status.reason`, else "RayJobFailed") | None | No |
| `job-validation-failed` | RayJob | The same, `jobDeploymentStatus` ValidationFailed (reason `status.reason`, else "ValidationFailed") | None | No |
| `service-failed` | RayService | `Ready` is False with reason ValidationFailed or InitializingTimeout (message the active cluster's failed application's, else `Ready`'s message or reason) | None | No |
| `service-failed-new-app` | RayService | The same with a failed application of the pending cluster and no active one yet (message that application's, else `Ready`'s) | None | No |
| `service-app-failed` | RayService | An application of the active cluster is DEPLOY_FAILED or UNHEALTHY, `Ready` not True (reason a False `Ready`'s, else "ServeApplicationFailed"; message the first failed application's by name, else a False `Ready`'s message or reason) | 10 min from `Ready`'s change | No |
| `service-new-app-failed` | RayService | No active cluster yet, an application of the pending one is DEPLOY_FAILED or UNHEALTHY, `Ready` not True | 10 min from `Ready`'s change | No |
| `service-app-failed-while-ready` | RayService | An application of the active cluster is DEPLOY_FAILED or UNHEALTHY, `Ready` True (reason "ServeApplicationFailed") | 5 min from when Sextant first saw it | No |
| `service-new-app-failed-while-ready` | RayService | The same of the pending cluster, no active one yet, `Ready` True | 5 min from when Sextant first saw it | No |
| `service-not-ready` | RayService | No application failed, no upgrade or rollback in progress, and `Ready` is not True (or, before KubeRay 1.3, no `Ready` and `serviceStatus` is not Running); reason a False `Ready`'s, else "RayServiceNotReady" | 10 min from `Ready`'s change, else from when Sextant first saw it | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only. It has no action of its own.

## What it does not do

- It does not create, scale, suspend or delete Ray clusters, jobs or services, or submit jobs.
- It does not talk to Ray: no dashboard, job or Serve API is requested; the dashboard URL is shown as text.
- It does not show a RayJob's entrypoint or a RayService's serve configuration unmasked: the YAML section of Sextant's
  details is the deliberate place to see the stored object.
- It reports no problems of RayCronJobs or other KubeRay kinds, as the built-in view did not.

## Requirements and limits

- KubeRay's CRDs; the section shows only the kinds the cluster serves.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - The failed Serve application whose message counts is the first by name whose status is none of NOT_STARTED,
    DEPLOYING, RUNNING and DELETING (a path step cannot match one of several values): an application without a status
    sorting before the failed one would give its (empty) message — KubeRay always copies Ray Serve's status, and Ray
    Serve has no other. Names sort by their characters (the built-in view compared them in the UI language), which
    differs only for names in mixed case.
  - The Workers column of a RayCluster without `status.desiredWorkerReplicas` (operators before it) is empty when a
    worker group not suspended has `numOfHosts` other than 1 or no `replicas`: a sum cannot multiply an item's values
    or fall back to its `minReplicas`, as the built-in one did (a list column's `items` writes items, it does not add
    them up).
  - The rules watch at most 20 000 RayClusters and 20 000 RayServices (the most a rule's source takes); the built-in
    problems had no cap there.
- Checked by tests on fixtures of KubeRay's objects (copied from the built-in view) against the built-in readings,
  masking and rules; not yet tried on a live cluster.

## Troubleshooting

- **No "KubeRay" section:** the cluster serves none of KubeRay's kinds, or the extension is disabled.
- **"The cluster's pods cannot be read." in a RayCluster's details:** the extension, or your credentials, may not list
  Pods in its namespace; the worker groups' ready pods are then left empty.
- **"Sextant refused: …" in a section, or a logs button does nothing:** the extension's permissions do not cover the
  object or its pods' logs. Check Settings → Extensions → KubeRay.
- **"Not shown: the serve configuration could not be read safely.":** `serveConfigV2` does not parse as one YAML
  mapping; Sextant's YAML section shows it as stored.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/kuberay        # → extensions/kuberay/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/kuberay
```

- `src/main.ts` starts the details section the frame's context names: `details.ts` (RayCluster, RayJob, RayService,
  and the pods watch), drawn with the SDK's `ui` kit.
- `model.ts` reads KubeRay's fields; it is the former built-in view's model, ported, with its problem detector
  (`rayProblems`) and filter (`isProblem`) kept as the reference the manifest is tested against. `mask.ts` masks the
  entrypoint and serve configuration (with the `yaml` package), `uri.ts` cleans URIs, both ported unchanged.
- `model.test.ts` judges the manifest's problem rules, the kinds' "Only problems" and the columns with Sextant's own
  window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on
  the fixtures in `fixtures/` and variants of them; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `kuberay`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `kuberay` and the
     commit (add `kuberay` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
