# Cluster API

Read-only views of [Cluster API](https://cluster-api.sigs.k8s.io/) (`cluster.x-k8s.io`, `controlplane.cluster.x-k8s.io`,
`addons.cluster.x-k8s.io`), in every language Sextant has. It lists Clusters, ClusterClasses, KubeadmControlPlanes,
MachineDeployments, MachineSets, Machines, MachineHealthChecks and ClusterResourceSets in a sidebar section of their own
with Sextant's tables; tells each object's state from its own phase and conditions in both status shapes the API has
(v1beta2, and v1beta1 with or without `status.v1beta2`); follows the chain Cluster → control plane and infrastructure →
MachineDeployments → MachineSets → Machines → bootstrap and infrastructure objects → the Node in the workload cluster,
which opens when that cluster is one of Sextant's; and reports failed or unavailable Clusters and control planes, failed
or stuck Machines and blocked remediation. It replaces Sextant's former built-in Cluster API view (ADR-0113) with the
same behaviour. Its id is `sextant.cluster-api`. Why it is built this way: ADR-0113 (the readings, the chain and the
problems), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of its own, `not`
in rules), ADR-0153 (computed columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns
left out, paths picking an item, notification groups), ADR-0163 (field values in texts), ADR-0164 (case tooltips,
deeper conditions) and ADR-0167 (the counter's own label, more rules, column widths and sort values, tooltip fallbacks,
text conditions, every match of a list, a rule's literal reason and since fallbacks, progress stamps, a named object
with its own condition, details sections without a heading, capped watches, blocks in Sextant's memory, opening a
workload cluster).

## At a glance

| | |
|---|---|
| Id | `sextant.cluster-api` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `cluster-api-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Cluster API |
| Checked against | Cluster API's objects as kubernetes-sigs/cluster-api writes them (`api/core/v1beta2`, `api/core/v1beta1`, `controlplane/kubeadm/api`, `util/conditions`, `util/annotations`) |

## What it adds

**A sidebar section "Cluster API"** (`clusterApi`), shown while the cluster serves Cluster API's kinds, with the
built-in section's icon, right after Prometheus Operator's: Clusters, Cluster Classes, Kubeadm Control Planes, Machine
Deployments, Machine Sets, Machines, Machine Health Checks and Cluster Resource Sets, each with its own icon, Sextant's
own table, filters, selection bar and details, and Edit and Delete as on every kind. The section's counter shows how
many objects need attention (the problems below). The kinds are read in the version the cluster serves.

**"Only problems"** on Clusters, Kubeadm Control Planes, Machines and Machine Health Checks, as the built-in tables had
it, from the problem rules with their grace periods.

**Columns**, after Name and Namespace, in place of the CRDs' own printer columns (left out, as the built-in view did),
in the built-in columns' widths:
- Cluster: **Status** (`c-status`: Available, Provisioned, Provisioning, Not available, Failed, Deleting, Paused or
  Unknown, coloured, sorted and filtered by the state's name, the phase and the failing condition on hover),
  **Phase** (`c-phase`), **Class** (`c-class`), **Version** (`c-version`), **Control plane** (`c-control-plane`) and
  **Workers** (`c-workers`) as "ready/desired".
- Machine: **Status** (`m-status`: Running, Not ready, Provisioning, Updating, Deleting, Failed, Paused or Unknown),
  **Phase** (`m-phase`), **Cluster** (`m-cluster`), **Node** (`m-node`), **Version** (`m-version`).
- MachineDeployment, MachineSet and KubeadmControlPlane: **Status** (`md-status`, `ms-status`, `k-status`: Available,
  Provisioning (a control plane not initialized), Rolling out, Scaling, Not available, Failed, Deleting, Paused or
  Unknown), **Cluster** (`md-cluster`, `ms-cluster`, `k-cluster`), **Ready** (`md-ready`, `ms-ready`, `k-ready`,
  "ready/desired"), **Up to date** (`md-up-to-date`, `ms-up-to-date`, `k-up-to-date`), **Available** (`md-available`,
  `ms-available`, `k-available`), **Version** (`md-version`, `ms-version`, `k-version`). The counts are the v1beta2
  meaning (`status.v1beta2` of a v1beta1 object); a v1beta1 object without any new count gives its old ones.
- MachineHealthCheck: **Status** (`h-status`: Healthy, Remediating or Remediation blocked), **Cluster** (`h-cluster`),
  **Healthy** (`h-healthy`, healthy of expected), **Remediations allowed** (`h-remediations-allowed`).
- ClusterResourceSet: **Strategy** (`crs-strategy`, ApplyOnce when unset).

**A details section "Cluster API"** (`cluster-api`), drawn with the SDK's UI kit in the classes of Sextant's own
details panel, without a heading of its own as the built-in section had none; its blocks open and close as the
built-in panel's did, remembered in Sextant's own memory of details sections (Settings → Appearance, "Expand all",
"Collapse all"):
- Cluster: what its state means and the cluster's message; its state, phase, ClusterClass, Kubernetes version, control
  plane endpoint, the control plane and infrastructure objects (read by name: a link, ready, not ready, missing, could
  not be read or not served, and a provider's terminal error), the control plane and worker machine counts, and the
  workload cluster: a button for each of Sextant's clusters whose API server is the control plane endpoint, else "No
  cluster in Sextant has the API server …"; then **Machines**, the chain: the control plane's Machines, each
  MachineDeployment → MachineSet → Machines, MachineSets of no MachineDeployment, then any other Machines (at most 50,
  the rest counted).
- Machine: what its state means, whether its Cluster is paused (or could not be read while the Machine says nothing of
  it), phase, Cluster, owner, version, provider ID, failure domain, Node (with "Open Node … in …" where Sextant has the
  workload cluster), addresses, the bootstrap config and its data Secret, the infrastructure machine with a few fields
  of Docker, AWS, Azure and vSphere machines, and when its phase changed.
- MachineDeployment and MachineSet: their state, counts, version, rollout strategy and templates; KubeadmControlPlane:
  its state, whether its Cluster is paused, initialization, counts, template and last remediation; each with
  **Machines**, the Machines its controller's selector picks (at most 50).
- MachineHealthCheck: why remediation is blocked, the selector, expected and healthy machines, remediations allowed,
  its limits, node startup timeout, the unhealthy Node and machine conditions and the checked machines.

What a block reads is read only while it is open, as the built-in view's: the objects a reference names (at most 50,
again when the object shown changes, never of a kind the cluster does not serve) while the first block is open; the
Cluster's MachineDeployments, MachineSets and Machines, or an owner's Machines, by label in the object's namespace (at
most 5000 each, saying when a list was cut) while "Machines" is open. Every object named is a link to its details in
Sextant's panel. A workload cluster is opened only on a click, connected then if it is not.

## Permissions

- **Read** Cluster API's kinds (each section reads the object it shows and the objects it names; a Cluster's details
  list its MachineDeployments, MachineSets and Machines, an owner's details its Machines), in every namespace of every
  cluster.
- **Read** the provider objects a Cluster or Machine names, of the providers most installations use: the control planes
  of `controlplane.cluster.x-k8s.io` (KubeadmControlPlane, AWSManagedControlPlane, ROSAControlPlane,
  KThreesControlPlane, RKE2ControlPlane, TalosControlPlane, K0sControlPlane, K0smotronControlPlane,
  MicroK8sControlPlane, NestedControlPlane), the infrastructure clusters and machines of
  `infrastructure.cluster.x-k8s.io` (Docker, AWS, Azure, GCP, vSphere, VCD, OpenStack, Metal3, Hetzner, Proxmox,
  Nutanix, IBM Cloud, KubeVirt, OCI, Equinix Metal, Tinkerbell, CloudStack, MAAS, Linode, BYOH, Scaleway, Outscale) and
  the bootstrap configs of `bootstrap.cluster.x-k8s.io` (KubeadmConfig, EKSConfig, KThreesConfig, RKE2Config,
  TalosConfig, K0sWorkerConfig, K0sControllerConfig, MicroK8sConfig): the details read each by name to tell whether it
  is ready.
- It lists Sextant's clusters (names and API server addresses) to offer the workload cluster's button; opening one is
  Sextant's own dialog, every time.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge Clusters, KubeadmControlPlanes, Machines and MachineHealthChecks, and look up a Machine's
  Cluster; Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

One category, the extension's own ("Cluster API"), on by default and never given to agents, as the built-in
`clusterApi` was. Every rule may notify; the rules of one reason notify as one (`failed`, `not-available`,
`provisioning`, `remediation-blocked`). The reasons are the built-in ones: `Failed`, `NotAvailable`,
`ProvisioningStuck`, `RemediationBlocked`; a rule's title is its kind and reason. Nothing is a problem of an object
being deleted or paused (`spec.paused`, the `cluster.x-k8s.io/paused` annotation or the Paused condition). Machines and
KubeadmControlPlanes with new conditions are judged by their own Paused condition, which Cluster API since 1.9 writes
from their Cluster's pause; those with only old conditions by their Cluster, as the built-in view judged both. A
not-available problem counts from its condition's `lastTransitionTime`; a stuck Machine from `status.lastUpdated` (its
creation without it), and again whenever its phase changes. "New conditions" are `status.conditions` of a v1beta2
object or `status.v1beta2.conditions` of a v1beta1 one; "old" are `status.conditions` of a v1beta1 object or
`status.deprecated.v1beta1.conditions` of a v1beta2 one, read only when it has no new ones, a False of severity Info or
Warning deciding nothing.

| Id | Kind | When it holds | Grace | Told by another object |
|---|---|---|---|---|
| `c-failed` | Cluster | `failureReason`/`failureMessage` in the v1beta1 status, or the Failed phase; the message is the failure's | None | No |
| `c-na-new` | Cluster | Available False (new conditions), past Pending and Provisioning, control plane initialized (`status.initialization`, the ControlPlaneInitialized condition, else `controlPlaneReady`) or not said | 5 min | No |
| `c-na-new-p` | Cluster | The same while Pending or Provisioning or before the control plane is initialized | 30 min | No |
| `c-na-oa`, `c-na-oa-p` | Cluster | The same by the old Available condition | 5 / 30 min | No |
| `c-na-or`, `c-na-or-p` | Cluster | The same by the old Ready condition (no old Available) | 5 / 30 min | No |
| `k-failed` | KubeadmControlPlane | A terminal failure in the v1beta1 status (new conditions; its own Paused condition not True) | None | No |
| `k-failed-o`, `k-failed-o-x`, `k-failed-o-n` | KubeadmControlPlane | The same with only old conditions: its Cluster (the `cluster.x-k8s.io/cluster-name` label) there and not paused, not there, or not named | None | Yes: a paused Cluster leaves it out |
| `k-na-new` | KubeadmControlPlane | Available False (new conditions) | 5 min, 30 before it is initialized | No |
| `k-na-oa`, `k-na-oa-x`, `k-na-oa-n` | KubeadmControlPlane | Old Available False, its Cluster there and not paused, not there, or not named | 5 min, 30 before it is initialized | Yes: a paused Cluster leaves it out |
| `k-na-or`, `k-na-or-x`, `k-na-or-n` | KubeadmControlPlane | The same by the old Ready condition (no old Available) | 5 min, 30 before it is initialized | Yes: a paused Cluster leaves it out |
| `m-failed` | Machine | A terminal failure or the Failed phase (new conditions; its own Paused condition not True) | None | No |
| `m-failed-o`, `m-failed-o-x` | Machine | The same with only old conditions, its Cluster not paused, or not there | None | Yes: a paused Cluster leaves it out |
| `m-p-v2-bi`, `m-p-v2-n`, `m-p-v2-r` | Machine | Pending, Provisioning or Provisioned (new conditions in `status.v1beta2`), the message of the first of BootstrapConfigReady, InfrastructureReady (`bi`), NodeReady, NodeHealthy (`n`), Ready (`r`) that is not True, else the phase | 30 min | No |
| `m-p-c-bi`, `m-p-c-n`, `m-p-c-r` | Machine | The same of a v1beta2 Machine | 30 min | No |
| `m-p-o-in`, `m-p-o-r` | Machine | The same by the old conditions of a v1beta1 Machine (InfrastructureReady, NodeHealthy; Ready), its Cluster not paused | 30 min | Yes: a paused Cluster leaves it out |
| `m-p-o-in-x`, `m-p-o-r-x` | Machine | The same, its Cluster not there | 30 min | Yes |
| `m-p-d-i`, `m-p-d-n`, `m-p-d-r` | Machine | The same by the deprecated conditions of a v1beta2 Machine without new ones (InfrastructureReady; NodeHealthy; Ready), its Cluster not paused | 30 min | Yes: a paused Cluster leaves it out |
| `m-p-d-i-x`, `m-p-d-n-x`, `m-p-d-r-x` | Machine | The same, its Cluster not there | 30 min | Yes |
| `h-blocked` | MachineHealthCheck | RemediationAllowed False (new conditions): more Machines unhealthy than it allows | 2 min | No |
| `h-blocked-o` | MachineHealthCheck | The same by the old condition | 2 min | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0113).

## What it does not do

- It does not create, scale, pause, resume, upgrade or delete anything; it never runs `clusterctl`.
- It does not explain provider-specific statuses beyond the few fields named above; a provider's own failure shows
  through the Machine's conditions and the infrastructure object's readiness and `failureMessage`.
- It never connects a workload cluster without a click; an endpoint reached through a rewritten address (a port mapped
  to 127.0.0.1, a proxy) is not recognised.

## Requirements and limits

- Cluster API's CRDs (any of v1beta2, v1beta1 with or without `status.v1beta2`); the section shows only where the
  cluster serves them. MachinePools are no kind of the section; their Machines appear under "Other machines".
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - **The state columns' hover** is the built-in one — the phase and the first False condition but those whose False is
    good news (with the types Cluster API gives each kind where all seven do not fit a hover template: Clusters and
    MachineDeployments without Updating, Machines with Deleting, Paused and Updating), its message, else its reason —
    but for two shapes the hover's paths cannot tell apart: a v1beta1 object with `status.v1beta2` and no failing new
    condition shows its first old one of severity Error (the built-in view showed none), as does a v1beta2
    MachineSet, KubeadmControlPlane or MachineHealthCheck with no failing new condition and a failing deprecated one;
    and a v1beta2 Cluster, Machine or MachineDeployment with only deprecated conditions shows its phase alone.
  - **Provider objects of kinds not listed under Permissions** are shown as "Could not be read": a permission names
    kinds one by one (a kind `*` matches none; a group-wide read was deferred, as it touches the extension security
    model), where the built-in view read any kind with your own access.
  - **A paused Cluster's objects with only old conditions** (Cluster API before 1.9) are judged by that Cluster, which
    Sextant must have read in full: while it cannot (a Cluster list the extension or you may not read), their problems
    stay out, where the built-in view kept them. Their "Only problems" leaves them out while their Cluster is paused,
    where the built-in filter, which knew no pause, listed them.
  - **The workload cluster's buttons** open Sextant's own dialog naming the matching clusters (`ui.openCluster`), where
    the built-in buttons opened the cluster at once; Sextant's clusters and served kinds are read when the details
    open, where the built-in view followed them while open.
  - Notification groups are named in lowercase (`not-available`, `remediation-blocked`); they group as the built-in
    ones did. The first block's open or closed state is the extension's own, where the built-in one shared Sextant's
    fields block's.
- Readings that rest on what the API server keeps and Cluster API writes: the new Paused condition is looked for in
  `status.conditions` without the version (v1beta1's old conditions have none); a KubeadmControlPlane has no phase or
  `spec.paused`, and tells its initialization in `status.initialized` (v1beta1) or `status.initialization` (v1beta2); old conditions have no BootstrapConfigReady or NodeReady and carry a severity when False and a reason
  when not True; a condition's `lastTransitionTime` is always there (one without it starts no grace).
- Checked by tests on fixtures of Cluster API's objects (copied from the built-in view) and on generated objects of
  every status shape against the built-in readings and rules; not yet tried on a live cluster.

## Troubleshooting

- **No "Cluster API" section:** the cluster does not serve Cluster API's kinds, or the extension is disabled.
- **"Could not be read" beside an infrastructure or bootstrap object:** its kind is not among the provider kinds the
  extension may read, or your credentials may not read it.
- **"The machines could not be listed.":** the cluster does not serve Machines, or the extension may not read them
  there.
- **"Sextant refused: …" in the section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Cluster API.
- **"No cluster in Sextant has the API server …":** add the workload cluster's kubeconfig to Sextant (`clusterctl get
  kubeconfig`); an address rewritten on the way (a mapped port, a proxy) is not recognised.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/cluster-api        # → extensions/cluster-api/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/cluster-api
```

- `src/main.ts` starts the details section; `details.ts` draws it with the SDK's `ui` kit and holds its reads and
  watches; `permitted.ts` lists the kinds the manifest lets it read.
- `model.ts` and `chain.ts` read Cluster API's fields: the former built-in view's model, ported, with its problem
  detector (`capiProblems`) and filter (`isProblem`) kept as the reference the manifest is tested against.
- `model.test.ts` judges the manifest's problem rules (which also make "Only problems") and the columns with Sextant's
  own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on
  the fixtures in `fixtures/` and on generated objects of both status shapes; `views.test.ts` drives the details
  through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `clusterapi`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `cluster-api` and
     the commit (add `cluster-api` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
