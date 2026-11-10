# Vertical Pod Autoscaler

Read-only views of the [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
(`autoscaling.k8s.io`), in every language Sextant has. It lists VerticalPodAutoscalers and their checkpoints in a
sidebar section of their own with Sextant's tables; tells a VPA's state from the recommender's conditions, its update
mode in words, and its recommendation per container against the target template's requests and limits with what the
admission controller would set on a pod created now (limits scaled as it scales them); finds the recommender, updater
and admission controller in the cluster and says what a missing one means; and gives every workload a VPA can target a
"Vertical Pod Autoscaler" block with the VPAs that target it. It reports VPAs the recommender cannot use, VPAs that
match no pod and VPAs that fight an HPA over the same resource. It replaces Sextant's former built-in Vertical Pod
Autoscaler view (ADR-0111) with the same behaviour where the extension API can say it (see "Requirements and limits").
Its id is `sextant.vpa`. Why it is built this way: ADR-0111 (the readings, the admission computation and the
problems), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of its own, `not`
in rules), ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns
left out, paths picking an item), ADR-0163 (field values in texts, a problem's reason) and ADR-0167 (the counter's own
label, more rules, column widths and sort values, quantity and date-and-time formats, match fields with dots and `!=`, placeholder fallbacks, text
conditions, `relatedBy`, details sections without a heading or hidden until shown, blocks in Sextant's memory).

## At a glance

| | |
|---|---|
| Id | `sextant.vpa` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `vpa-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Vertical Pod Autoscaler |
| Checked against | The VPA's objects as kubernetes/autoscaler's vertical-pod-autoscaler writes and reads them (`autoscaling.k8s.io/v1`: `pkg/apis/autoscaling.k8s.io/v1/types.go`, `pkg/utils/vpa/api.go`, `pkg/utils/vpa/capping.go`, `pkg/utils/vpa/limit_and_request_scaling.go`, `pkg/admission-controller/resource/pod/recommendation`, `pkg/recommender/model/vpa.go`) and its install manifests and charts |

## What it adds

**A sidebar section "Vertical Pod Autoscaler"** (`vpa`), shown while the cluster serves the VPA's kinds, with the
built-in section's icon, right after Karpenter's: VerticalPodAutoscalers and Checkpoints, each with its own icon,
Sextant's own table, filters, selection bar and details, and Edit and Delete as on every kind. The section's counter
shows how many VPAs have a problem (the problems below).

**"Only problems"** on VerticalPodAutoscalers, as the built-in table had it: a configuration the recommender cannot
use, or no pods matched without a recommendation — not in mode Off and not for a Job or CronJob target.

**Columns**, in the built-in columns' places and widths, the CRDs' own printer columns left out:

| Kind | Column | Id | What it shows |
|---|---|---|---|
| VerticalPodAutoscaler | Target | `vpa-target` | `Kind/name` of `spec.targetRef` |
| VerticalPodAutoscaler | Mode | `vpa-mode` | The update mode, `Recreate` when unset |
| VerticalPodAutoscaler | Status | `vpa-status` | The state from the conditions in the recommender's order (Unsupported, Low confidence, Loading history, Recommending, No pods matched, No recommendation, Waiting) in its tone, the deciding condition's message on hover; sorted and filtered by the state |
| VerticalPodAutoscaler | CPU | `vpa-cpu` | The first container's CPU target in cores or millicores (`587m`, `2`), sorted and filtered by the amount |
| VerticalPodAutoscaler | Memory | `vpa-memory` | The first container's memory target in binary units (`250MiB`), sorted and filtered by the amount |
| VerticalPodAutoscalerCheckpoint | VPA | `cp-vpa` | The VPA it keeps the recommender's histograms for |
| VerticalPodAutoscalerCheckpoint | Container | `cp-container` | Its container |
| VerticalPodAutoscalerCheckpoint | Samples | `cp-samples` | `status.totalSamplesCount` |
| VerticalPodAutoscalerCheckpoint | Last saved | `cp-last-update` | `status.lastUpdateTime` as a date and time in the UI language, sorted by the time |

**Details of a VerticalPodAutoscaler** (`vpa`, in place of the generic fields, without a heading of its own): its
state with the recommender's message and what it means (with notes for no pods right now and a deprecated
configuration), since when, a link to the target, the update mode (marked "default" when unset) and what it does, the
replicas needed to evict, the recommender; an HPA of the namespace that fights it (a danger line) or scales on an
AverageValue of a resource it changes (a note); the block **"Recommendation and the next pods"**: per container of the
target's pod template the template's request and limit, the recommended range, the target (uncapped, raised to
`minAllowed`, lowered to `maxAllowed` or kept at the limit), and what a pod created now would get, computed as the
admission controller computes it (the target as the request, the limit scaled to the template's ratio in whole
millicores and bytes, `RequestsOnly` capped at the limit); and the block **"VPA components"**: the recommender,
updater and admission controller found as the manifests' Deployments in kube-system or by the charts' labels, ready or
not, and what a missing one means in this VPA's mode.

**A "Vertical Pod Autoscaler" block** (`workload`) on Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs and
CronJobs, right after right-sizing: the VPAs of the namespace that target the workload, each with its state, mode, an
HPA that fights it and its recommendation against this workload's template. It is not drawn where the cluster serves
no VPAs or no VPA targets the workload.

The blocks open and close as the built-in panel's did, in Sextant's own memory of details sections, so "Expand all",
"Collapse all" and Settings → Appearance apply to them; the choices remembered for the built-in blocks carry over
(Sextant moves them once to the sections `vpa` and `workload`, the built-in `vpaWorkload`). The sections follow the
cluster's kinds while shown, as the built-in ones followed discovery: the VPA installed or removed meanwhile shows at
once. Conditions, events and YAML are Sextant's own sections. The
tables' columns resize (drag a header's right edge) and Sextant remembers their widths, as the built-in view's did;
the same columns keep to one line, the others wrap between words.

## Permissions

- **Read** VerticalPodAutoscalers and their checkpoints, in every namespace of every cluster.
- **Read** HorizontalPodAutoscalers: a VPA's details and a workload's block list the namespace's HPAs to tell a fight;
  the problem rules look up the HPAs that scale a VPA's target.
- **Read** Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs and CronJobs: a VPA's details read its target by
  name for its pod template; the workload block reads the workload it is shown on; the components are Deployments.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge VerticalPodAutoscalers and look up HorizontalPodAutoscalers; Sextant asks for that
  separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

The rules are in the extension's own category, **"Vertical Pod Autoscaler"**, on by default, as the built-in category
`vpa` was; it is never given to agents. A problem's reason is `ConfigUnsupported`, `NoPodsMatched` or `HpaConflict`,
as the built-in problems named them, and each reason notifies once per VPA. A grace counts from the condition's
`lastTransitionTime` (from when Sextant first saw it without one); a fight's from when Sextant first saw it.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `config-unsupported` | VerticalPodAutoscaler | `ConfigUnsupported` True, not being deleted, with the recommender's message | 2 min | No |
| `no-pods-matched` | VerticalPodAutoscaler | `NoPodsMatched` True without a recommendation (`RecommendationProvided` not True, and none written by an older recommender), not `ConfigUnsupported`, not in mode Off, the target not a Job or CronJob; listed, never notified | 10 min | No |
| `hpa-conflict-cpu-memory`, `hpa-conflict-cpu`, `hpa-conflict-memory`, `hpa-conflict-cpu-only`, `hpa-conflict-memory-only` | VerticalPodAutoscaler | A VPA with container policies, in a mode that changes running pods (Recreate, Auto, InPlaceOrRecreate, InPlace, unset), and an HPA of its namespace scaling its target (the same name, kind and apiVersion, whatever the HPA is called) on the utilization of a resource the VPA controls; one rule per outcome, so the message names exactly the resources both act on (cpu, memory, or both) | 2 min | No |
| `hpa-conflict-every-cpu-memory`, `hpa-conflict-every-cpu`, `hpa-conflict-every-memory` | VerticalPodAutoscaler | The same for a VPA without container policies, which controls cpu and memory of every container: a per-container (`ContainerResource`) metric fights too | 2 min | No |

Whether the VPA controls a resource is read from its policies alone, as the built-in problems read it: no policies, or a
policy not Off that controls it (its `controlledResources`, cpu and memory when unset). An HPA's resource is a `Resource`
metric with a `Utilization` target (an HPA without metrics is the API's default CPU); an AverageValue or Value target
does not fight. A fight is judged only while the HPAs of the VPA's namespace are read in full. The message says "An HPA": the
rules cannot name the HPA they found.

## Metrics

None.

## Commands

None.

## Changes it makes

None: it only reads.

## What it does not do

- It does not install or configure the VPA components, and does not change a VPA, an HPA or a workload.
- It does not model a LimitRange of the namespace, containers other webhooks add, or the startup CPU boost in what a
  new pod would get, and says so under the table, as the built-in view did.

## Requirements and limits

- The VPA's CRDs (`autoscaling.k8s.io/v1`); the section shows only where the cluster serves them. The recommender,
  updater and admission controller run in the cluster or as a managed add-on (GKE).
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - **No pods matched** is listed and never notifies, and a VPA whose target is scaled to zero is listed too; the
    built-in problem read the target's replica count from a list another view held, then left out a target scaled to
    zero and notified when it wanted pods. (A `related` lookup of the kind the object names — `apiVersionPath` and
    `kindPath`, as `about` reads it — read by name rather than through a watch of every workload, and a rule's
    notification decided by a condition, would close it.)
  - **A fight with an HPA** is told as "An HPA scales the same workload on …", once per VPA and outcome; the built-in
    problem named the HPA, and told each fighting HPA apart (two HPAs on one target, which the HPA controller itself
    refuses as ambiguous). (The found object's name in a message, and a problem per found object, would close it.)
  - The rules compare the target's whole `apiVersion` (an HPA on `apps/v1beta2` of an `apps/v1` VPA target is not
    found) and need both to name one; the built-in problem compared the group. (A placeholder filter for an
    apiVersion's group in `relatedBy` pairs would close it.)
  - A per-container (`ContainerResource`) metric is judged by the rules only for a VPA without container policies; with
    policies the built-in problem also judged it where the container's own or the wildcard policy decides (the details
    still do). (A `relatedBy` comparison of the HPA's container name against the VPA's policies would close it.)
  - A policy with an empty `controlledResources` list (or one of other resources only) counts as the default (cpu and
    memory) in the rules; the built-in problem counted no resource. (A match step that tells a missing field from a
    present one would close it.)
  - The rules' HPAs are listed only in the namespaces of the VPAs a fight rule judges up to the HPA lookup
    (`narrowLookups`: not being deleted, in a mode that changes running pods, and with no container policies or one not
    Off), within those the extension may read, and not at all where no VPA is served; the built-in held the HPAs of the
    namespaces of every VPA in such a mode, also one whose policies are all Off, which cannot fight, so no problem
    differs. Past 40 such namespaces the extension lists HPAs in every namespace it may read (at most 5000, beyond that
    it cannot tell); the built-in judged no fight then.
  - A VPA's target of a kind outside the six above (a custom workload such as an Argo Rollout) is not read, so its
    details say "The target has not been read"; the built-in view read any kind the cluster serves. (Reading every
    kind would need a permission on all kinds.)
- Checked by tests on fixtures of the VPA's objects (copied from the built-in view) against the built-in readings and
  problem provider; not yet tried on a live cluster.

## Troubleshooting

- **No "Vertical Pod Autoscaler" section:** the cluster does not serve the VPA's kinds, or the extension is disabled.
- **"The target has not been read":** the target does not exist, the extension may not read its kind, or the cluster
  refused your credentials.
- **"Cannot tell" for a component:** one of the Deployment lists could not be read.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Vertical Pod Autoscaler.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/vpa        # → extensions/vpa/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/vpa
```

- `src/main.ts` starts the details sections; `details.ts` draws them with the SDK's `ui` kit and holds their watches.
- `model.ts` reads the VPA's fields, `admission.ts` computes what a new pod would get (proportional limits in BigInt),
  `conflicts.ts` judges a fight with an HPA, `components.ts` finds the components, `format.ts` writes amounts; they
  are the former built-in view's, ported unchanged, and the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules (which also make "Only problems") and the columns with Sextant's
  own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model
  and a port of the built-in problem provider on the fixtures in `fixtures/` and variants of them;
  `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `vpa` texts)
  and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of Sextant's
  `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `vpa` and the
     commit (add `vpa` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
