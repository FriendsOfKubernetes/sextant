# KServe

Read-only views of [KServe](https://kserve.github.io/website/), in every language Sextant has. It lists KServe's
InferenceServices, ServingRuntimes, ClusterServingRuntimes, InferenceGraphs and TrainedModels (`serving.kserve.io`) in
a sidebar section of their own with Sextant's tables; tells an InferenceService's state from its conditions and model
status, its components, revisions and traffic split, what KServe made for it, and the serving runtime KServe chooses
for its predictor, computed as KServe chooses it; and reports models that failed to load, specs KServe cannot serve and
InferenceServices that are not ready. Every URI it shows loses its credentials, query and fragment. It replaces
Sextant's former built-in KServe view (ADR-0115) with the same behaviour; the few places where the extension API still
cannot say exactly the same are in "Requirements and limits". Its id is `sextant.kserve`. Why it is built this way: ADR-0115 (the readings, the runtime
choice, URIs without credentials, the problems), ADR-0139 (Sextant's own extensions), ADR-0140 (translations),
ADR-0152 (kinds in a section of its own, `not`), ADR-0153 (computed columns), ADR-0160 (the section's icon and place,
the UI kit), ADR-0161 (printer columns left out, paths picking an item, notification groups), ADR-0163 (field values in
texts, a problem's reason from the object), ADR-0164 (case tooltips, deeper conditions), ADR-0165 (a kind's own "Only
problems") and ADR-0167 (the counter's own label, column widths and sort keys, tooltip fallbacks, a rule's literal
reason, untitled details sections, capped watches, details blocks in Sextant's own memory).

## At a glance

| | |
|---|---|
| Id | `sextant.kserve` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `kserve-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → KServe |
| Checked against | KServe's objects as `pkg/apis/serving/v1beta1` and `v1alpha1` write them, with both deployment-mode names (`Serverless`/`Knative`, `RawDeployment`/`Standard`) and the old framework fields of a predictor |

## What it adds

**A sidebar section "KServe"** (`kserve`), shown while the cluster serves one of its kinds, with the built-in section's
icon and place: Inference Services, Serving Runtimes, Cluster Serving Runtimes, Inference Graphs and Trained Models,
each with Sextant's own table, filters, selection bar and details, and Edit and Delete as on every kind. The section's
counter shows how many InferenceServices need attention (the problems below).

**"Only problems"** on Inference Services, as the built-in table had it (no grace): those whose spec KServe cannot
serve, whose model failed to load, or whose `Ready` is False; never a stopped or deleted one.

**Columns**, after Name and Namespace (Name for Cluster Serving Runtimes), in place of the CRDs' own printer columns
(left out, as the built-in view did):
Each with the built-in column's width, sort order and filter (states by their name in every language, counts as
numbers).
- Inference Services: **Status** (`isvc-status`: Stopped (muted), Failed, Ready, Not ready or Progressing, coloured,
  sorted by the state; on hover what explains it: the model's failure, else the most basic False condition in KServe's
  order — its message, else its reason — else `Ready`'s), **URL** (`isvc-url`, without credentials or a query),
  **Model format** (`isvc-model-format`: the predictor's `modelFormat` with its version, or the old framework field's
  name), **Runtime** (`isvc-runtime`: named in the spec, else the one KServe recorded, namespaced first; an empty name
  goes on to the next), **Mode** (`isvc-mode`: the deployment mode as recorded, else as annotated) and **Canary %**
  (`isvc-canary`: with two or more traffic entries of the predictor, the percent of those on the latest revision).
- Serving Runtimes and Cluster Serving Runtimes: **Model formats** (`sr-formats`, `csr-formats`: every name, joined
  with ", "), **Protocols** (`sr-protocols`, `csr-protocols`: every one), **Disabled** (`sr-disabled`, `csr-disabled`)
  and **Multi-model** (`sr-multi-model`, `csr-multi-model`).
- Inference Graphs: **Status** (`graph-status`: Ready, Not ready or Progressing from `Ready`, its message, else its
  reason, on hover), **URL** (`graph-url`) and **Nodes** (`graph-nodes`: how many nodes the graph has).
- Trained Models: **Status** (`trained-model-status`), **InferenceService** (`trained-model-inference-service`) and
  **Framework** (`trained-model-framework`).

**Details**, an untitled section per kind as the built-in one was, drawn with the SDK's UI kit in the classes of
Sextant's own details panel. Its blocks open and close with their titles and are remembered in Sextant's own memory of
details sections (Settings → Appearance), with the panel's "Expand all" and "Collapse all", as the built-in blocks
were:
- **InferenceService** (`inference-service`): why it failed or is not ready (the model's last failure, else the most
  basic False condition: components before configurations, the latest deployment, routes and the ingress), its state,
  URL, address, deployment mode ("the cluster's default" when neither the status nor the annotation says) and the
  runtime KServe recorded; a block per component (predictor, transformer, explainer) with its model format, runtime,
  storage URI, protocol, images, replicas, canary traffic, multi-node, URL, revisions, traffic split and what KServe
  made for it — the Knative Services, Deployments and Services of its namespace labelled
  `serving.kserve.io/inferenceservice=<name>` (watched metadata only, at most 100 of each kind, by their `component`
  label, while a component's block is open); the model status with the last failure; and **Serving runtime**: the
  runtime KServe chooses now for the predictor, the other candidates in KServe's order, why none fits, and a note when
  it differs from what KServe recorded. The choice reads the namespace's ServingRuntimes and the
  ClusterServingRuntimes, watched while its block is open, only where the cluster serves them, each list kept to 500 by
  Sextant; a list it cannot read or that holds more makes it "cannot be told", never a guess.
- **ServingRuntime** (`serving-runtime`) and **ClusterServingRuntime** (`cluster-serving-runtime`): protocols, disabled,
  multi-model, multi-node, images, and its model formats with version, auto-select and priority.
- **InferenceGraph** (`inference-graph`): readiness, URL, deployment mode, and a block per node (the root first) with
  its router type and steps (a node, an InferenceService or a URL, weight, condition, dependency); the nodes' blocks
  open and close together, as the built-in ones did.
- **TrainedModel** (`trained-model`): readiness, InferenceService, framework, storage URI, memory and URL.

Every URI shown (storage URIs, also from `storageUris` and a container's `STORAGE_URI`, status URLs and addresses,
component and step URLs) loses its userinfo, query and fragment, with "credentials and query hidden" where anything
was; condition and failure messages have every URI in them cleaned the same way. Every object named is a link to its
details in Sextant's panel.

## Permissions

- **Read** InferenceServices, ServingRuntimes, ClusterServingRuntimes, InferenceGraphs and TrainedModels (each section
  reads the object it shows; an InferenceService's section reads the runtimes for the choice), and Knative Services
  (`serving.knative.dev`), Deployments and Services (what KServe made for an InferenceService, metadata only), in every
  namespace of every cluster.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge InferenceServices; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `kserve`, on by default. A stopped InferenceService (the `serving.kserve.io/stop: "true"`
annotation or the `Stopped` condition) and one being deleted have none. Every rule may notify; the rules of one group
notify once per object. A rule's reason is the object's own, else the built-in fallback reason named below. Of the
`not-ready-*` rules exactly one holds: the one of the first False condition in KServe's order (`PredictorReady`,
`TransformerReady`, `ExplainerReady`, the three `*ConfigurationReady`, `LatestDeploymentReady`, `CanaryPredictorReady`,
`PredictorRouteReady`, `TransformerRouteReady`, `ExplainerRoutesReady`, `RoutesReady`, `IngressReady`), else of a False
condition of another type (`Ready` and `Stopped` aside), else `not-ready`; its message is that condition's.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `invalid-spec` | InferenceService | `modelStatus.transitionStatus` is InvalidSpec (no runtime, a disabled one, a protocol or format it lacks), with the failure's reason, else "InvalidSpec" | 2 min from `lastFailureInfo.time`, else from when Sextant first saw it | No |
| `model-load-failed` | InferenceService | The model failed to load (`FailedToLoad` active or target state, or `BlockedByFailedLoad`), not an invalid spec, with the failure's reason, else "FailedToLoad" | None | No |
| `not-ready-predictor` | InferenceService | `Ready` is False and `PredictorReady` is False, with its reason, else "PredictorReadyFalse" | 10 min from `Ready`'s change | No |
| `not-ready-transformer` | InferenceService | `Ready` False, `TransformerReady` False, nothing earlier False; its reason, else "TransformerReadyFalse" | 10 min | No |
| `not-ready-explainer` | InferenceService | … `ExplainerReady` (and so on: the type and `False`) | 10 min | No |
| `not-ready-predictor-config` | InferenceService | … `PredictorConfigurationReady` | 10 min | No |
| `not-ready-transformer-config` | InferenceService | … `TransformerConfigurationReady` | 10 min | No |
| `not-ready-explainer-config` | InferenceService | … `ExplainerConfigurationReady` | 10 min | No |
| `not-ready-latest-deployment` | InferenceService | … `LatestDeploymentReady` | 10 min | No |
| `not-ready-canary-predictor` | InferenceService | … `CanaryPredictorReady` | 10 min | No |
| `not-ready-predictor-route` | InferenceService | … `PredictorRouteReady` | 10 min | No |
| `not-ready-transformer-route` | InferenceService | … `TransformerRouteReady` | 10 min | No |
| `not-ready-explainer-routes` | InferenceService | … `ExplainerRoutesReady` | 10 min | No |
| `not-ready-routes` | InferenceService | … `RoutesReady` | 10 min | No |
| `not-ready-ingress` | InferenceService | … `IngressReady` | 10 min | No |
| `not-ready-other` | InferenceService | `Ready` False, none of those False, a False condition of another type with a reason: the first in the object's list, with its reason | 10 min | No |
| `not-ready-other-unnamed` | InferenceService | The same without a reason: "`<type>`False" | 10 min | No |
| `not-ready` | InferenceService | `Ready` is False and no other condition is, with `Ready`'s reason, else "InferenceServiceNotReady" | 10 min | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own.

## What it does not do

- It does not read the cluster's KServe configuration (`inferenceservice-config`: the default deployment mode, the
  ingress domain, the storage initializer); a mode neither recorded nor annotated is "the cluster's default".
- It does not explain ModelMesh's own placement; a ModelMesh InferenceService's runtime is chosen among multi-model
  runtimes.
- It lists no ModelMesh or LLMInferenceService kinds.
- It never requests a URL it shows, and never shows a URI's credentials: the YAML section stays the deliberate place to
  see the stored object.

## Requirements and limits

- KServe's CRDs; the section shows only the kinds the cluster serves. What KServe made is shown where the cluster
  serves Knative Serving, Deployments and Services.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - The Status column's hover: a False condition with neither a reason nor a message gives way to the next one, else
    `Ready`'s (the built-in hover was empty): a placeholder's `??` skips empty values.
  - A cell holds 200 characters and a hover 1000, then "…" (the built-in URL and hover were not cut).
  - Canary % filters as text (the built-in one as a number): a `sum` column would show the share of a single traffic
    entry, which the built-in left blank, and a blank case there sorts first rather than last.
- Checked by tests on fixtures of KServe's objects (copied from the built-in view) against the built-in readings and
  rules; not yet tried on a live cluster.

## Troubleshooting

- **No "KServe" section:** the cluster serves none of KServe's kinds, or the extension is disabled.
- **"The serving runtimes cannot all be read, so the choice cannot be told.":** the extension may not list
  ServingRuntimes in the namespace or ClusterServingRuntimes, or one list holds more than 500.
- **No Knative Service, Deployment or Service in a component's block:** the cluster does not serve the kind, the
  extension may not read it there, or KServe has not made it yet.
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → KServe.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/kserve        # → extensions/kserve/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/kserve
```

- `src/main.ts` starts the details section the frame's context names: `details.ts` (InferenceService, and the watches
  it holds) or `views.ts` (the other kinds), drawn with the SDK's `ui` kit.
- `model.ts` reads KServe's fields and `runtimes.ts` chooses the runtime; they are the former built-in view's model,
  ported, with its problem detector (`kserveProblems`) and filter (`isProblem`) kept as the reference the manifest is
  tested against. `uri.ts` is Sextant's URI cleaner, ported.
- `model.test.ts` judges the manifest's problem rules, "Only problems" and the columns with Sextant's own window engine
  (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on the fixtures in
  `fixtures/`; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `kserve`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `kserve` and the
     commit (add `kserve` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
