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

**"Only problems"**, as the built-in tables had it: on Ray Clusters the failed ones and those whose head pod is not
ready, at once; on Ray Jobs the failed ones, however long ago; on Ray Services those with a problem below.

**Columns**, after Name and Namespace, in place of the CRDs' own printer columns (left out, as the built-in view did):
- Ray Clusters: **Status** (`cluster-status`: Ready, Provisioning, Head not ready, Suspending, Suspended or Failed,
  coloured, the operator's reason on hover), **Workers** (`cluster-workers`: ready worker pods of desired),
  **Head IP** (`cluster-head-ip`) and **Ray version** (`cluster-ray-version`).
- Ray Jobs: **Status** (`job-status`: Succeeded, Running, Pending, Retrying, Stopped, Suspended or Failed, coloured,
  KubeRay's message on hover), **Job status** (`job-job-status`, Ray's), **Deployment status**
  (`job-deployment-status`, KubeRay's), **Ray cluster** (`job-cluster`) and **Started** (`job-started`, an age).
- Ray Services: **Status** (`service-status`: Ready, Upgrading, Not ready, Suspended or Failed, coloured, why it is not
  ready on hover), **Applications** (`service-applications`: the active cluster's Serve applications that run),
  **Endpoints** (`service-endpoints`) and **Active cluster** (`service-active-cluster`).

**Details**, a section per kind, drawn with the SDK's UI kit in the classes of Sextant's own details panel:
- **RayCluster** (`ray-cluster`): why it failed or waits (the failing condition or `status.reason`), its state, Ray
  version, workers ready of desired and their bounds ("no upper limit" for the largest int32), the head pod, its IP,
  the head Service and its IP, the endpoints and the requested resources; the worker groups with their desired pods,
  replica bounds, ready pods and suspension; and the cluster's pods (watched by KubeRay's label
  `ray.io/cluster=<name>` in its namespace while the section shows; at most 50 listed, the rest counted) with
  **Head logs** (the head pod) and **Worker logs** (the pods `ray.io/cluster=<name>,ray.io/node-type=worker`) in
  Sextant's logs tab.
- **RayJob** (`ray-job`): KubeRay's message (cut at 20 000 characters), its state, Ray's job status, KubeRay's
  deployment status and reason, its RayCluster and cluster selector, the submission mode, the submitter Job (only in
  `K8sJobMode`: a Job of the RayJob's own name) with **Submitter logs** (`job-name=<job>`), the job id, the dashboard
  URL (without credentials or query), its times and attempts, and the entrypoint as text with secret-looking flags and
  variables masked and URIs cleaned.
- **RayService** (`ray-service`): why it is not ready (a failed Serve application's message, else the Ready
  condition's), its state, the serve Service and endpoints, the upgrade strategy and an upgrade or rollback in
  progress; the active cluster and, during an upgrade, the pending one, each with its traffic, target capacity and
  Serve applications (status, healthy deployments, messages); and `serveConfigV2` with every `env_vars` value and
  every secret-looking value masked and URIs cleaned, or not at all when it does not read as one YAML mapping.

Every object named is a link to its details in Sextant's panel. Messages from the cluster lose the credentials,
queries and fragments of the URIs in them.

## Permissions

- **Read** RayClusters, RayJobs and RayServices (each section reads the object it shows), and Pods (a RayCluster's
  pods, by label, for the pods table and the ready pods of each group), in every namespace of every cluster.
- **Logs** of Pods: "Head logs", "Worker logs" and "Submitter logs" open Sextant's logs tab, which reads them as your
  own logs tab does.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge RayClusters, RayJobs and RayServices; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `kuberay`, on by default. A suspended or deleted object is never a problem. Every rule may
notify; a rule's reason is the object's own (the condition's or the job's reason), and the `-unnamed` rules give the
built-in fallback reason when the object gives none. A RayService's rules are split by which Serve application failed
(the active cluster's, or the pending one's while there is no active cluster) and by its Ready condition (with a
reason, without one, or True: then the grace runs from when Sextant first saw the failure).

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `cluster-replica-failure` | RayCluster | `ReplicaFailure` is True: KubeRay cannot create or delete pods | 5 min from the condition's change | No |
| `cluster-replica-failure-unnamed` | RayCluster | The same without a reason (reason "ReplicaFailure") | 5 min | No |
| `cluster-failed` | RayCluster | `status.state: failed` (operators before 1.2) | None | No |
| `cluster-head-not-ready` | RayCluster | `HeadPodReady` is False, not failed | 5 min from the condition's change | No |
| `cluster-head-not-ready-unnamed` | RayCluster | The same without a reason (reason "HeadPodNotReady") | 5 min | No |
| `job-failed` | RayJob | Failed (`jobDeploymentStatus` Failed or ValidationFailed, or `jobStatus` FAILED; never while Retrying), for a day after its end (else its start, else its creation) | None | No |
| `job-validation-failed` | RayJob | The same without a reason, ValidationFailed (reason "ValidationFailed") | None | No |
| `job-failed-unnamed` | RayJob | The same without a reason otherwise (reason "RayJobFailed") | None | No |
| `service-failed` | RayService | `Ready` is False with reason ValidationFailed or InitializingTimeout | None | No |
| `service-app-failed` | RayService | An application of the active cluster is DEPLOY_FAILED, `Ready` False with a reason | 10 min from `Ready`'s change | No |
| `service-app-failed-unnamed` | RayService | The same, `Ready` not True and without a reason (reason "ServeApplicationFailed") | 10 min | No |
| `service-app-failed-while-ready` | RayService | The same, `Ready` True | 5 min from when Sextant first saw it | No |
| `service-app-unhealthy` | RayService | An application of the active cluster is UNHEALTHY (none DEPLOY_FAILED), `Ready` False with a reason | 10 min | No |
| `service-app-unhealthy-unnamed` | RayService | The same, `Ready` not True and without a reason | 10 min | No |
| `service-app-unhealthy-while-ready` | RayService | The same, `Ready` True | 5 min | No |
| `service-new-app-failed` | RayService | No active cluster yet, an application of the pending one is DEPLOY_FAILED, `Ready` False with a reason | 10 min | No |
| `service-new-app-failed-unnamed` | RayService | The same, `Ready` not True and without a reason | 10 min | No |
| `service-new-app-failed-while-ready` | RayService | The same, `Ready` True | 5 min | No |
| `service-new-app-unhealthy` | RayService | No active cluster yet, an application of the pending one is UNHEALTHY, `Ready` False with a reason | 10 min | No |
| `service-new-app-unhealthy-unnamed` | RayService | The same, `Ready` not True and without a reason | 10 min | No |
| `service-new-app-unhealthy-while-ready` | RayService | The same, `Ready` True | 5 min | No |
| `service-not-ready` | RayService | `Ready` is False with a reason, no application failed, no upgrade or rollback in progress | 10 min from `Ready`'s change | No |
| `service-not-ready-unnamed` | RayService | `Ready` is Unknown, or False without a reason (reason "RayServiceNotReady") | 10 min | No |
| `service-not-running` | RayService | No `Ready` condition (operators before 1.3) and `serviceStatus` is not Running | 10 min from when Sextant first saw it | No |

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
  - The Status columns sort by the text shown, not by the state; Suspending, Suspended, Stopped and Pending are drawn
    in the neutral colour (the built-in tables muted them), and the columns have Sextant's default widths (#403).
  - The Applications column counts the active cluster's running Serve applications; the built-in one wrote "running
    of all", which needs a path that counts a map's entries (#404).
  - The Workers column is empty for a RayCluster without `status.desiredWorkerReplicas` (very old operators); the
    built-in one summed the worker groups' replicas then.
  - A hover or problem message whose condition has an empty message shows nothing, where the built-in one gave the
    condition's reason (#404). A RayService that is upgrading or suspended has no hover (the built-in one showed a
    False Ready condition's message): a column takes at most 10 cases.
  - An invalid RayService (Ready False with ValidationFailed or InitializingTimeout) that also has a failed Serve
    application gives the Ready condition's message, not the application's; with applications both DEPLOY_FAILED and
    UNHEALTHY, the message is the first DEPLOY_FAILED one's, not the first by name (#405: a path step cannot match one
    of several values).
  - A failed RayJob without `status.endTime` counts from when Sextant first saw it (the built-in one took its start,
    else its creation); when it stops counting, a day after, is the same. A rule's `since` is one path.
  - Failed RayJobs are watched for problems without the built-in cap of 5000; RayCluster pods in the details are
    watched without the built-in cap of 2000 (#406).
  - "Only problems" on Ray Services shows the RayServices with an active problem of the rules, so a new one counts
    after its grace; the built-in filter had none. The condition limits (three levels of `all`, `any` and `not`, 30
    conditions) cannot say "not ready" without the rules.
  - A RayJob's problems notify once per object; the built-in ones notified again when the reason changed.
  - The details are a titled section per kind (the built-in one had no title of its own); its blocks are always open
    when shown (the built-in panel remembered closed blocks) (#406). The logs buttons are Sextant buttons in the Pods
    block, without the logs icon, and the worker logs tab is titled by its label selector (the built-in one by
    `raycluster/<name>`): `ui.openLogs` takes no title.
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
