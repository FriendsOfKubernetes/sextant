# NVIDIA GPU Operator

Read-only views of the [NVIDIA GPU Operator](https://github.com/NVIDIA/gpu-operator) (`nvidia.com`), in every
language Sextant has. It lists ClusterPolicies and NVIDIADrivers in a sidebar section of their own with Sextant's
tables; tells their state with the operator's message, where the operands run, the MIG strategy, each component of a
ClusterPolicy (enabled or not, by the spec or the operator's default, its DaemonSet rolled out or not) and the
DaemonSets an NVIDIADriver owns; adds a "GPU" block to the details of GPU nodes and a "GPU nodes" page. It reports
objects the operator says are not ready, component DaemonSets not rolled out and nodes whose MIG configuration failed.
It replaces Sextant's former built-in NVIDIA GPU Operator view (ADR-0116) with the same behaviour; the few places where
the extension API cannot say it yet are listed under "Requirements and limits". Its id is `sextant.gpu-operator`. Why it is built this way: ADR-0116 (the readings and problems),
ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of their own, rule sources
with a label selector, `not`), ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the UI kit),
ADR-0161 (printer columns left out, paths picking an item, notification groups), ADR-0163 (field values in texts, a
problem's reason), ADR-0164 (`atLeast`, deeper conditions), ADR-0165 (a kind's own "Only problems") and ADR-0167 (the
counter's own label, more rules, details sections by condition and without a heading, a problem about another object,
progress that restarts a grace, a named object with its own condition, capped watches, blocks in Sextant's memory,
column widths, sort values and map entries).

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
kept, with a note when more match), each a link, with the GPU product and count GPU Feature Discovery labels, `nvidia.com/gpu` allocatable of
capacity, the MIG resources (allocatable/capacity), the MIG configuration and its state, coloured. The nodes are
watched while the page shows, selected on the API server by the label.

**"Only problems"**, as the built-in tables had it: ClusterPolicies and NVIDIADrivers whose `status.state` is
`notReady`.

**Columns**, after Name, in place of the CRDs' own printer columns (left out, as the built-in view did), in the
built-in widths:
- ClusterPolicies: **State** (`policy-state`: Ready, Not ready, Ignored, Disabled or No state yet, coloured — Ignored,
  Disabled and No state yet muted —, sorted and filtered by the state's name as the built-in column was; on hover the
  message of the Error condition when it is True, else of a False Ready condition), **Operand namespace**
  (`policy-namespace`, `status.namespace`) and **MIG strategy** (`policy-mig-strategy`, `spec.mig.strategy` as the
  API writes it).
- NVIDIADrivers: **State** (`driver-state`, as above), **Driver type** (`driver-type`, `gpu` when not set),
  **Version** (`driver-version`) and **Node selector** (`driver-node-selector`, `key=value, …`).

**Details**, drawn with the SDK's UI kit in the classes of Sextant's own details panel, without a heading of their own
as the built-in sections had none; each block opens and closes in Sextant's own memory of details sections (as
Settings → Appearance says, with "Expand all" and "Collapse all"):
- a section **NVIDIA GPU Operator** (`gpu-operator`) on ClusterPolicies: the state with the operator's message and
  what the state means, the operand namespace, the MIG strategy ("Not set" when it is left to the device plugin),
  whether the driver is managed by NVIDIADriver objects; and a block **Components**: each component (driver, container
  toolkit, device plugin, DCGM, DCGM exporter, GPU Feature Discovery, MIG manager, node status exporter, validator, and
  the sandbox components where sandbox workloads are on) with whether the policy turns it on (its `enabled`, else the
  operator's `IsEnabled()` default), its DaemonSet in the operand namespace (the driver's matched by its name's
  prefix) and how many of its pods are ready and updated, or "Not deployed yet", "Not deployed", "See NVIDIADriver";
- the same section on NVIDIADrivers: the state and message, the driver type and version, the node selector, the
  operand namespace, and a block **DaemonSets** with the DaemonSets it owns (by its uid) and their rollout;
- a section with a block **GPU** (`gpu-node`) on Nodes, shown only on nodes with GPUs (GPU labels or `nvidia.com/gpu`
  capacity): the GPU product, count and memory per GPU, the MIG configuration and its state (coloured), why the MIG manager
  failed when it did, and the `nvidia.com/gpu` and MIG resources' capacity and allocatable.

The operand namespace's DaemonSets are watched while the Components or DaemonSets block is open (at most 1000 kept,
with a note when more match), as the built-in view watched them. Every DaemonSet and node named is a link to its details
in Sextant's panel.

The tables' columns, on the page and in the details, resize (drag a header's right edge) and Sextant remembers their
widths, as the built-in view's did; the same columns keep to one line, the others wrap between words.

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
`ComponentNotReady`, `MigConfigFailed`. A ClusterPolicy or NVIDIADriver being deleted is not judged, nor are its
components; one the operator reports ignored or disabled is never a problem, nor are its components. The message of a
not-ready object is the operator's Error condition's when it is True, else the False Ready condition's, else "The
NVIDIA GPU Operator reports it not ready." (two rules, since that last text is no field of the object).

A component that is not rolled out is a problem **about its ClusterPolicy or NVIDIADriver**, as the built-in one was,
naming the DaemonSet in its message and notifying once for the object; its 10 minutes start again whenever the
DaemonSet's ready, updated or scheduled count moves, so a rollout that progresses stays quiet. The DaemonSet's owner is
looked up by name among the ClusterPolicies or NVIDIADrivers Sextant watches for the rules above ("cannot tell", so no
problem, until they are read). Because Kubernetes leaves `updatedNumberScheduled` out when it is 0 and a message is one
template, each component rule has a twin for "0 updated".

| Id | Kind judged | Problem about | When it holds | Grace | Told by another object |
|---|---|---|---|---|---|
| `policy-not-ready` | ClusterPolicy | Itself | `status.state` is `notReady` and the Error condition is True with a message, or not True and the Ready condition False with a message | 10 min from the False Ready condition's time, else from when it is first seen | No |
| `policy-not-ready-plain` | ClusterPolicy | Itself | The same with neither message | As above | No |
| `driver-not-ready` | NVIDIADriver | Itself | As `policy-not-ready` | As above | No |
| `driver-not-ready-plain` | NVIDIADriver | Itself | As `policy-not-ready-plain` | As above | No |
| `component-not-rolled-out`, `component-not-rolled-out-none-updated` | DaemonSet | Its ClusterPolicy | Named as a component's DaemonSet in the operator's manifests (every component but the driver and the retired Kata manager), controlled by a ClusterPolicy that is not ignored, disabled or being deleted, pods scheduled, and fewer ready or updated than scheduled (the twin: none updated) | 10 min from when its counts last moved | No |
| `policy-driver-rollout`, `policy-driver-rollout-none-updated` | DaemonSet | Its ClusterPolicy | The driver's DaemonSet (`nvidia-driver-daemonset`, or with its kernel and OS suffix) of a ClusterPolicy as above that turns the driver on and does not leave it to NVIDIADriver objects, not rolled out as above | As above | No |
| `driver-rollout`, `driver-rollout-none-updated` | DaemonSet | Its NVIDIADriver | Controlled by an NVIDIADriver that is not ignored, disabled or being deleted, not rolled out as above | As above | No |
| `mig-config-failed` | Node | Itself | `nvidia.com/mig.config.state=failed` (nodes picked by that label on the API server, metadata only) | 2 min from when it is first seen | No |

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
- Where it still differs from the former built-in view, because the extension API cannot say it yet:
  - A component rule cannot tell whether the policy turns that component on: a rule of a DaemonSet can ask its
    ClusterPolicy only one fixed condition (a `related` condition cannot sit inside `any`), and one rule per component
    with its twin for "0 updated" would make 39 rules where a manifest may have 30. So a DaemonSet of a component the
    policy turns off is judged too (the operator deletes such a DaemonSet when it next reconciles; the built-in rule
    left it alone). A placeholder's literal fallback (`{{.status.updatedNumberScheduled ?? 0}}`) or `related` inside
    `any` would close it.
  - A component's DaemonSet is found by its controller, the ClusterPolicy or NVIDIADriver, in any namespace; the
    built-in rule found the policy's by name in the operand namespace, even one the operator did not own (a condition
    of the named object cannot compare it with the judged one's namespace).
  - The section's counter counts a component's problem by its DaemonSet, the built-in one by its ClusterPolicy or
    NVIDIADriver (the counter counts the judged objects, not the objects a problem is about).
  - A not-ready object's "since" is its Ready condition's time only while that condition is False; the built-in
    problem showed that time whatever the condition's status (a rule has one time for the grace and the age).
  - The State column is searched by the words shown ("Not ready"), the built-in one by the state's name ("notReady");
    sorting and the column filter go by the name as before.
  - The Node selector column joins its entries with the UI language's list separator ("、" in Japanese and Chinese,
    ", " elsewhere, as the built-in column in every language), and a selector with no entries sorts with the empty
    cells (the `entries` format).
  - The GPU block's condition cannot pick a resource name by prefix: a node with nothing but `nvidia.com/mig-*`
    resources (no GPU label, no `nvidia.com/gpu`) shows no GPU block (no condition reads a map's keys).
  - The rules watch every DaemonSet of the cluster (up to Sextant's 5000 for a rule's source), the built-in category
    only those of the operand namespaces (up to 1000).
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

- `src/main.ts` starts the details sections and the page; `details.ts` draws the sections with the SDK's `ui` kit,
  keeps their blocks in Sextant's memory and holds the watch of the operand namespace's DaemonSets while its block is
  open; `page.ts` draws "GPU nodes".
- `model.ts` reads the operator's fields; it is the former built-in view's model, ported, with its problem detector
  (`gpuProblems`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules (their `related` lookups as `src/extensions/problemsAcross.ts`
  does, their `about` and `stamp`), the kinds' "Only problems", the GPU block's condition and the columns with
  Sextant's own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with
  the model on the fixtures in `fixtures/`; `views.test.ts` drives the details and the page through the SDK's test
  host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's
  `gpuoperator` texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every
  language of Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `gpu-operator` and
     the commit (add `gpu-operator` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
