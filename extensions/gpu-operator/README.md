# NVIDIA GPU Operator

Read-only views of the [NVIDIA GPU Operator](https://github.com/NVIDIA/gpu-operator) (`nvidia.com`), in every
language Sextant has. It lists ClusterPolicies and NVIDIADrivers in a sidebar section of their own with Sextant's
tables; tells their state with the operator's message, where the operands run, the MIG strategy, each component of a
ClusterPolicy (enabled or not, by the spec or the operator's default, its DaemonSet rolled out or not) and the
DaemonSets an NVIDIADriver owns; adds a "GPU" block to the details of GPU nodes and a "GPU nodes" page. It reports
objects the operator says are not ready, component DaemonSets not rolled out and nodes whose MIG configuration failed.
It replaces Sextant's former built-in NVIDIA GPU Operator view (ADR-0116) with the same behaviour where the extension
API can say it. Its id is `sextant.gpu-operator`. Why it is built this way: ADR-0116 (the readings and problems),
ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of their own, rule sources
with a label selector, `not`), ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the UI kit),
ADR-0161 (printer columns left out, paths picking an item, notification groups), ADR-0163 (field values in texts, a
problem's reason), ADR-0164 (`atLeast`, deeper conditions), ADR-0165 (a kind's own "Only problems") and ADR-0167 (the
counter's own label, more rules, details sections by condition).

## At a glance

| | |
|---|---|
| Id | `sextant.gpu-operator` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `gpu-operator-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → NVIDIA GPU Operator |
| Checked against | The operator's own types and manifests (`api/nvidia/v1/clusterpolicy_types.go`, `api/nvidia/v1alpha1/nvidiadriver_types.go`, `assets/state-*`, `controllers/state_manager.go` v26.7.2) |

## What it adds

**A sidebar section "NVIDIA GPU Operator"** (`gpuOperator`), shown while the cluster serves ClusterPolicies or
NVIDIADrivers, with the built-in section's icon and place: Cluster Policies and NVIDIA Drivers, with Sextant's own
table, filters, selection bar and details, and Edit and Delete as on every kind. The section's counter shows how many
objects need attention (the problems below).

**A page "GPU nodes"** (`gpu-nodes`) in that section: the nodes labelled `nvidia.com/gpu.present=true` (at most 500
used), each a link, with the GPU product and count GPU Feature Discovery labels, `nvidia.com/gpu` allocatable of
capacity, the MIG resources (allocatable/capacity), the MIG configuration and its state, coloured. The nodes are
watched while the page shows, selected on the API server by the label.

**"Only problems"**, as the built-in tables had it: ClusterPolicies and NVIDIADrivers whose `status.state` is
`notReady`.

**Columns**, after Name, in place of the CRDs' own printer columns (left out, as the built-in view did):
- ClusterPolicies: **State** (`policy-state`: Ready, Not ready, Ignored, Disabled or No state yet, coloured, the
  operator's Error or Ready message on hover), **Operand namespace** (`policy-namespace`, `status.namespace`) and
  **MIG strategy** (`policy-mig-strategy`, `spec.mig.strategy` as the API writes it).
- NVIDIADrivers: **State** (`driver-state`, as above), **Driver type** (`driver-type`, `gpu` when not set),
  **Version** (`driver-version`) and **Node selector** (`driver-node-selector`).

**Details**, drawn with the SDK's UI kit in the classes of Sextant's own details panel:
- a section **NVIDIA GPU Operator** (`gpu-operator`) on ClusterPolicies: the state with the operator's message and
  what the state means, the operand namespace, the MIG strategy ("Not set" when it is left to the device plugin),
  whether the driver is managed by NVIDIADriver objects; and a block **Components**: each component (driver, container
  toolkit, device plugin, DCGM, DCGM exporter, GPU Feature Discovery, MIG manager, node status exporter, validator, and
  the sandbox components where sandbox workloads are on) with whether the policy turns it on (its `enabled`, else the
  operator's `IsEnabled()` default), its DaemonSet in the operand namespace (the driver's matched by its name's
  prefix) and how many of its pods are ready and updated, or "Not deployed yet", "Not deployed", "See NVIDIADriver";
- the same section on NVIDIADrivers: the state and message, the driver type and version, the node selector, the
  operand namespace, and a block **DaemonSets** with the DaemonSets it owns (by its uid) and their rollout;
- a section **GPU** (`gpu-node`) on Nodes, shown only on nodes with GPUs (GPU labels or `nvidia.com/gpu` capacity):
  the GPU product, count and memory per GPU, the MIG configuration and its state (coloured), why the MIG manager
  failed when it did, and the `nvidia.com/gpu` and MIG resources' capacity and allocatable.

The operand namespace's DaemonSets are watched while a ClusterPolicy's or NVIDIADriver's section shows (at most 1000
used, with a note when the list is cut). Every DaemonSet and node named is a link to its details in Sextant's panel.

## Permissions

- **Read** ClusterPolicies and NVIDIADrivers (each section reads the object it shows), DaemonSets (the operand
  namespace's, for the components, and every DaemonSet for the rule below) and Nodes (the GPU block, the page and the
  MIG rule), in every namespace of every cluster.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge ClusterPolicies, NVIDIADrivers, DaemonSets and Nodes; Sextant asks for that separately at
  install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `gpuOperator`, on by default. Every rule may notify, one notification group per problem
(`not-ready`, `component-not-ready`, `mig-config-failed`); the reasons are the built-in ones: `NotReady`,
`ComponentNotReady`, `MigConfigFailed`. A ClusterPolicy or NVIDIADriver being deleted is not judged; one the operator
reports ignored or disabled is never a problem. The message of a not-ready object is the operator's Error condition's
when it is True, else the False Ready condition's, else "The NVIDIA GPU Operator reports it not ready."; because a
message is one template, each case is a rule of its own.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `policy-not-ready` | ClusterPolicy | `status.state` is `notReady` and the Error condition is True with a message | 10 min from the False Ready condition's time, else from when it is first seen | No |
| `policy-not-ready-condition` | ClusterPolicy | The same, the Error condition not True, the Ready condition False with a message | As above | No |
| `policy-not-ready-plain` | ClusterPolicy | The same with neither message | As above | No |
| `driver-not-ready` | NVIDIADriver | As `policy-not-ready` | As above | No |
| `driver-not-ready-condition` | NVIDIADriver | As `policy-not-ready-condition` | As above | No |
| `driver-not-ready-plain` | NVIDIADriver | As `policy-not-ready-plain` | As above | No |
| `component-not-rolled-out` | DaemonSet | Controlled by a ClusterPolicy or an NVIDIADriver, pods scheduled, and fewer ready or updated than scheduled | 10 min from when it is first seen | No |
| `component-not-rolled-out-none-updated` | DaemonSet | The same with no pod updated (the field left out) | As above | No |
| `mig-config-failed` | Node | `nvidia.com/mig.config.state=failed` (nodes picked by that label on the API server, metadata only) | 2 min from when it is first seen | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0116).

## What it does not do

- It does not change a ClusterPolicy or NVIDIADriver, turn components on or off, or apply a MIG configuration.
- It does not install or upgrade the operator.
- It does not recompute what the operator decides: every state shown is the operator's own from its objects; whether
  a component is on is read from the spec with the operator's defaults.
- It does not show DRA devices: that is the Dynamic Resource Allocation view.

## Requirements and limits

- The GPU Operator's CRDs (`nvidia.com/v1` ClusterPolicy; `nvidia.com/v1alpha1` NVIDIADriver where served); the
  section shows only where the cluster serves them. The GPU block and page read node labels written by GPU Feature
  Discovery and the MIG manager.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - A component that is not rolled out is a problem of its DaemonSet, not of the ClusterPolicy or NVIDIADriver (a rule
    cannot report a problem about another object, #405), so the section's counter counts the DaemonSets. The rule
    judges every DaemonSet a ClusterPolicy or NVIDIADriver controls (the operator sets itself as the controller of each
    operand), in any namespace, whether or not the policy turns its component on and whatever the policy's own state;
    the built-in rule judged only the enabled components' DaemonSets, by name, in the operand namespace, and none of an
    ignored or disabled ClusterPolicy.
  - Its 10 minutes count from when the DaemonSet is first seen behind; the built-in rule started them again whenever
    its counts moved, so a rollout that progresses stayed quiet (a grace that restarts, #405).
  - A not-ready object's "since" is its Ready condition's time only while that condition is False.
  - The GPU block's condition cannot pick a resource name by prefix: a node with nothing but `nvidia.com/mig-*`
    resources (no GPU label, no `nvidia.com/gpu`) shows no GPU block (a pattern condition, #405).
  - The Node selector column writes the selector as JSON (`{"nvidia.com/gpu.present":"true"}`); the built-in column
    wrote `key=value, …` (a projection of a map's entries, #404).
  - Ignored, Disabled and No state yet are drawn in the neutral colour in the table (the built-in table muted them,
    #403); the tables sort the State column by its text.
  - The details of ClusterPolicies and NVIDIADrivers are a titled section (the built-in one had no title of its own);
    their blocks are always open when shown (the built-in panel remembered closed blocks), and the DaemonSets are
    watched while the section shows, open or closed; the lists are read in full and only the first 1000 DaemonSets or
    500 nodes are used (the built-in view asked the cluster for no more, #406).
- Checked by tests on fixtures of the operator's objects (copied from the built-in view) against the built-in readings
  and rules; not yet tried on a live cluster.

## Troubleshooting

- **No "NVIDIA GPU Operator" section:** the cluster does not serve ClusterPolicies, or the extension is disabled.
- **"The operator has not reported its operand namespace yet" under Components:** the operator has not reconciled the
  ClusterPolicy yet; its DaemonSets cannot be found before it does.
- **"The DaemonSets of namespace … could not be read.":** the extension may not read DaemonSets there, or the cluster
  refused your credentials.
- **No GPU block on a GPU node:** the node carries neither GPU Feature Discovery's labels nor `nvidia.com/gpu`; check
  that the device plugin and GFD run on it.
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → NVIDIA GPU Operator.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/gpu-operator        # → extensions/gpu-operator/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/gpu-operator
```

- `src/main.ts` starts the details sections and the page; `details.ts` draws the sections with the SDK's `ui` kit and
  holds the watch of the operand namespace's DaemonSets; `page.ts` draws "GPU nodes".
- `model.ts` reads the operator's fields; it is the former built-in view's model, ported, with its problem detector
  (`gpuProblems`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules, the kinds' "Only problems", the GPU block's condition and the
  columns with Sextant's own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`,
  `src/resources/jsonpath.ts`) and compares them with the model on the fixtures in `fixtures/`; `views.test.ts` drives
  the details and the page through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's
  `gpuoperator` texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every
  language of Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `gpu-operator` and
     the commit (add `gpu-operator` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
