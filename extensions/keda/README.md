# KEDA

Read-only views of [KEDA](https://keda.sh/) (`keda.sh`), in every language Sextant has. It lists ScaledObjects,
ScaledJobs, TriggerAuthentications and ClusterTriggerAuthentications in a sidebar section of their own with Sextant's
tables; tells a ScaledObject's or ScaledJob's state in plain words from KEDA's conditions and pause annotations, its
target, replica range and triggers with their health, and the HPA KEDA manages for a ScaledObject with that HPA's
verdict and metrics; and tells where a TriggerAuthentication takes its parameters from, by name only. It replaces the
KEDA part of Sextant's former built-in autoscaling view (ADR-0080) with the same behaviour where the extension API can
say it (see "Requirements and limits"). Its id is `sextant.keda`. Why it is built this way: ADR-0080 (the readings and
the HPA's estimate), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of
their own, `problemWhen`), ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161
(printer columns left out, paths picking an item), ADR-0163 (field values in texts) and ADR-0167 (column widths and
sort values, the muted tone, map keys and literal fallbacks in placeholders, text conditions and non-empty texts, lists of a field,
details sections without a heading, blocks in Sextant's memory).

## At a glance

| | |
|---|---|
| Id | `sextant.keda` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `keda-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → KEDA |
| Checked against | KEDA's objects as kedacore/keda writes them (`keda.sh/v1alpha1`: `apis/keda/v1alpha1/scaledobject_types.go`, `scaledjob_types.go`, `triggerauthentication_types.go`, `condition_types.go`) and the HPA it manages (`autoscaling/v2`, the HPA controller's `pkg/controller/podautoscaler`) |

## What it adds

**A sidebar section "KEDA"** (`keda`), shown while the cluster serves KEDA's kinds, with the built-in section's icon,
right after Trivy's: Scaled Objects, Scaled Jobs, Trigger Authentications and Cluster Trigger Authentications, each with
its own icon, Sextant's own table, filters, selection bar and details, and Edit and Delete as on every kind.

**"Only problems"** on every kind, as the built-in tables had it: the `Ready` condition False.

**Columns**, in the built-in columns' places and widths, the CRDs' own printer columns left out:

| Kind | Column | Id | What it shows |
|---|---|---|---|
| ScaledObject | Target | `so-target` | `Kind/name` of `spec.scaleTargetRef`, Deployment when the kind is not set |
| ScaledObject | Min | `so-min` | `spec.minReplicaCount`, 0 when unset |
| ScaledObject | Max | `so-max` | `spec.maxReplicaCount`, 100 when unset |
| ScaledObject | Triggers | `so-triggers` | The trigger types, each once, in the order written, joined with ", " |
| ScaledObject | Ready | `so-ready` | The `Ready` condition's status: True green, False red, anything else yellow (Unknown without one, blank when empty) |
| ScaledObject | State | `so-state` | The `Ready` reason (`NotReady` without one) when not ready, coloured as Sextant colours status words; else `Paused` (the `Paused` condition, `autoscaling.keda.sh/paused: "true"` or `autoscaling.keda.sh/paused-replicas`) or `Fallback` in yellow; else `Active` in green or `Inactive` muted, from the `Active` condition |
| ScaledJob | Max | `sj-max` | `spec.maxReplicaCount`, 100 when unset |
| ScaledJob | Triggers | `sj-triggers` | As on ScaledObjects |
| ScaledJob | Ready | `sj-ready` | As on ScaledObjects |
| ScaledJob | State | `sj-state` | As on ScaledObjects |
| TriggerAuthentication | Sources | `ta-sources` | Where the parameters come from, each once: Secret, ConfigMap, env, the secret providers (`hashiCorpVault`, `azureKeyVault`, `awsSecretManager`, `gcpSecretManager`, `boundServiceAccountToken`), then the pod identity's provider |
| ClusterTriggerAuthentication | Sources | `cta-sources` | As on TriggerAuthentications |

**Details of a ScaledObject** (`scaled-object`, in place of the generic fields, without a heading of its own): the block
**KEDA** with its state in plain words — not ready (with the reason), paused by an annotation (and the replica count
it holds), the fallback in use, each trigger that keeps failing, active (the HPA scales between the minimum, at least
1, and the maximum) or inactive (kept at the idle replica count or the minimum) — its target (a link), the replica
range, idle replicas, polling interval, cooldown period and fallback; the block **Triggers**: each trigger's type and
name, up to 8 of its metadata as chips, its (Cluster)TriggerAuthentication (a link) and the health KEDA reports with
its consecutive failures; and the block **The HPA KEDA manages**: that HPA (`status.hpaName`, the advanced
`horizontalPodAutoscalerConfig.name`, else `keda-hpa-<name>`) with a link, its replicas now and desired, its range, its
verdict and the causes read from its conditions (no metrics API, a container without a request, pods without metrics,
a metric not found), and each metric's current value against its target and the replicas it asks for — or that it is
not there.

**Details of a ScaledJob** (`scaled-job`): the block **KEDA** with its state (active: KEDA creates Jobs up to the
maximum; inactive: none), the maximum, the scaling strategy, the polling interval and the job's first image, and the
block **Triggers**.

**Details of a (Cluster)TriggerAuthentication** (`trigger-authentication`): the block **Where the parameters come
from** with the pod identity's provider and a table of each parameter, where it comes from, the Secret's, ConfigMap's,
variable's or secret path's name (a link to a Secret or ConfigMap of the namespace) and its key — or that there are
none. No value is ever read.

The blocks open and close as the built-in panel's did, in Sextant's own memory of details sections, so "Expand all",
"Collapse all" and Settings → Appearance apply to them. The managed HPA is watched by its name only while its block is
open, as the built-in block watched it. Conditions, events and YAML are Sextant's own sections. The tables' columns
resize (drag a header's right edge) and Sextant remembers their widths, as the built-in view's did; the same columns
keep to one line, the others wrap between words.

## Permissions

- **Read** ScaledObjects, ScaledJobs, TriggerAuthentications and ClusterTriggerAuthentications, in every namespace of
  every cluster: each section reads the object it shows.
- **Read** HorizontalPodAutoscalers: a ScaledObject's details read the HPA KEDA manages for it, by its name.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

None, as the built-in view had none: "Only problems" filters the tables, and Sextant's problems page and notifications
have no KEDA category.

## Metrics

None.

## Commands

None.

## Changes it makes

None: it only reads.

## What it does not do

- It does not pause, resume or change a ScaledObject or ScaledJob, and does not read a Secret or a secret provider.
- It does not ask KEDA's metrics server for the triggers' values: the managed HPA's status says what the HPA saw.
- The HPA's "asks for" is an estimate by the controller's formula (the replica count where the controller counts ready
  pods), as the built-in view's was.

## Requirements and limits

- KEDA's CRDs (`keda.sh/v1alpha1`); the section shows only where the cluster serves them.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - **Sources** writes exactly 19 sets of sources as the built-in column did — every source alone, Secret with
    ConfigMap or env, ConfigMap with env, Secret with ConfigMap and env, and the pod identity with Secret, env,
    `hashiCorpVault`, `azureKeyVault`, `awsSecretManager` or `gcpSecretManager` — and any other set by the names of its fields (`awsSecretManager, gcpSecretManager`), joined in the
    UI language. (A list column item's case limited to the path it came from, with a single object read as a list of
    one, or a case text built of parts each with its own condition, would close it.)
  - **Triggers** hovers its whole text, as every list column does; the built-in cell had no hover. (A way to leave a
    column's hover out would close it.)
- Checked by tests on fixtures of KEDA's objects against the built-in readings (ported unchanged with the HPA's
  analysis); not yet tried on a live cluster.

## Troubleshooting

- **No "KEDA" section:** the cluster does not serve KEDA's kinds, or the extension is disabled.
- **"The HPA keda-hpa-… that KEDA manages for this ScaledObject is not there.":** KEDA has not created it yet (the
  ScaledObject is not ready or paused), the cluster does not serve HPAs, or the extension may not read it.
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → KEDA.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/keda        # → extensions/keda/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/keda
```

- `src/main.ts` starts the details sections; `details.ts` draws them with the SDK's `ui` kit and holds the HPA's watch.
- `model.ts` reads KEDA's fields and `hpa.ts` the managed HPA; they are the former built-in view's `keda.ts` and
  `hpa.ts`, ported unchanged, with its state word and "Only problems" filter (`stateWord`, `isProblem`) kept as the
  reference the manifest is tested against.
- `model.test.ts` judges the manifest's "Only problems" and columns with Sextant's own window engine
  (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on the fixtures in
  `fixtures/` and variants of them (every set of sources among them); `views.test.ts` drives the details through the
  SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `autoscaling`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `keda` and the
     commit (add `keda` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
