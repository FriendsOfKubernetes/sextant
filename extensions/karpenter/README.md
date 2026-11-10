# Karpenter

Read-only views of [Karpenter](https://karpenter.sh/) (`karpenter.sh`, with AWS's `karpenter.k8s.aws` and Azure's
`karpenter.azure.com` node classes), in every language Sextant has. It lists NodePools, NodeClaims, EC2NodeClasses and
AKSNodeClasses in a sidebar section of their own with Sextant's tables; tells a NodePool's usage against its limits, its
disruption settings and budgets and the recent disruptions of its NodeClaims; and tells whether a NodeClaim launched,
registered and initialized, which node it became and why Karpenter disrupts it (or may not). It replaces the Karpenter
part of Sextant's former built-in autoscaling view (ADR-0080) with the same behaviour where the extension API can say it
(see "Requirements and limits"); a node's own "Autoscaling" block (its NodePool, NodeClaim and disruption) stays in
Sextant. Its id is `sextant.karpenter`. Why it is built this way: ADR-0080 (the readings), ADR-0139 (Sextant's own
extensions), ADR-0140 (translations), ADR-0152 (kinds in a section of their own, `problemWhen`), ADR-0153 (computed
columns), ADR-0160 (the section's icon and place, the UI kit), ADR-0161 (printer columns left out, paths picking an
item), ADR-0163 (field values in texts) and ADR-0167 (column widths and sort values, map entries, counts and literal
fallbacks in placeholders and conditions, Kubernetes quantities compared and written as Sextant writes them, non-empty
texts, match fields with `!=`, details sections without a heading, blocks in Sextant's memory).

## At a glance

| | |
|---|---|
| Id | `sextant.karpenter` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `karpenter-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → Karpenter |
| Checked against | Karpenter's objects as kubernetes-sigs/karpenter writes them (`karpenter.sh/v1`, and `v1beta1` where fields moved: `pkg/apis/v1/nodepool.go`, `nodeclaim.go`, `nodeclaim_status.go`, `pkg/controllers/disruption`, `pkg/events`) and the providers' node classes (`karpenter.k8s.aws/v1` EC2NodeClass, `karpenter.azure.com/v1beta1` AKSNodeClass) |

## What it adds

**A sidebar section "Karpenter"** (`karpenter`), shown while the cluster serves Karpenter's kinds, with the built-in
section's icon, right after KEDA's: Node Pools, Node Claims, EC2 Node Classes and AKS Node Classes, each with its own
icon, Sextant's own table, filters, selection bar and details, and Edit and Delete as on every kind.

**"Only problems"** on every kind, as the built-in tables had it: the `Ready` condition False, or — on NodePools — a
resource in use at or over its limit (it launches no more nodes).

**Columns**, in the built-in columns' places and widths, the CRDs' own printer columns left out:

| Kind | Column | Id | What it shows |
|---|---|---|---|
| NodePool | Node class | `np-node-class` | The node class's name (`spec.template.spec.nodeClassRef.name`) |
| NodePool | Nodes | `np-nodes` | `status.resources.nodes` |
| NodePool | Usage / limits | `np-limits` | Each limited resource as `cpu 3920m/4, memory 45.9GiB/1000GiB` (in use, 0 when not reported, over the limit; cpu in cores or millicores, memory and storage in binary units), red when one is reached |
| NodePool | Consolidation | `np-consolidation` | `spec.disruption.consolidationPolicy` |
| NodePool | Ready | `np-ready` | The `Ready` condition's status: True green, False red, anything else yellow |
| NodeClaim | NodePool | `nc-node-pool` | The `karpenter.sh/nodepool` label (older `karpenter.sh/provisioner-name`) |
| NodeClaim | Instance type | `nc-instance-type` | The `node.kubernetes.io/instance-type` label |
| NodeClaim | Capacity | `nc-capacity-type` | The `karpenter.sh/capacity-type` label |
| NodeClaim | Zone | `nc-zone` | The `topology.kubernetes.io/zone` label |
| NodeClaim | Node | `nc-node` | `status.nodeName` |
| NodeClaim | State | `nc-state` | The reason (or status) of the first of `Launched`, `Registered`, `Initialized` that is not True; blank while launching or when all are done |
| NodeClaim | Ready | `nc-ready` | As on NodePools |
| EC2NodeClass | Role | `ec2-role` | `spec.role`, else `spec.instanceProfile` |
| EC2NodeClass | Ready | `ec2-ready` | As on NodePools |
| AKSNodeClass | Role | `aks-role` | As on EC2NodeClasses |
| AKSNodeClass | Ready | `aks-ready` | As on NodePools |

**Details of a NodePool** (`node-pool`, in place of the generic fields, without a heading of its own): the block
**Limits and disruption** — whether it is at its limit and for which resources, its node class (a link), consolidation
policy and delay, `expireAfter` (from the template, or `disruption` in v1beta1) and disruption budgets one per line
(nodes, reasons, schedule and duration); a table of each limited resource in use against its limit, the reached ones in
red, or that it has none; and the block **Recent disruptions of its NodeClaims**: the newest 10 of Karpenter's
disruption events about NodeClaims named `<nodepool>-…`, each with the claim and the cause (drift, consolidation,
emptiness, expiration or other), reason, message and age — the reasons for nodes already gone.

**Details of a NodeClaim** (`node-claim`): the block **Launch and disruption** — launching, not launched, launched but
not registered, registered but not initialized (with the reason), or launched, registered and initialized; its node
and NodePool (links), capacity type, instance type and zone; why Karpenter disrupts it or may not — being deleted,
drifted, consolidatable (with its NodePool's policy), empty, expired, kept by `karpenter.sh/do-not-disrupt` — and when it
expires (its own `expireAfter`, else its NodePool's, from its creation, in the UI language); and the block **Disruption
events**, the newest 10 of its disruption events with their cause, shown only when there are some (or when they could
not be read).

The blocks open and close as the built-in panel's did, in Sextant's own memory of details sections, so "Expand all",
"Collapse all" and Settings → Appearance apply to them. What a block lists is watched as the built-in block watched it:
every NodeClaim's events (`involvedObject.kind=NodeClaim`) while a NodePool's disruptions block is open; the NodePools
(where the cluster serves them) while a NodeClaim's block is open, and its own events while their block is open — or
once while it is closed, to know whether to show it. Conditions, events and YAML are Sextant's own sections. The
tables' columns resize (drag a header's right edge) and Sextant remembers their widths, as the built-in view's did;
the same columns keep to one line, the others wrap between words.

## Permissions

- **Read** NodePools, NodeClaims, EC2NodeClasses and AKSNodeClasses: each section reads the object it shows; a
  NodeClaim's details list the NodePools.
- **Read** Events in every namespace: the disruption blocks list Karpenter's events about NodeClaims.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

None, as the built-in view had none: "Only problems" filters the tables, and Sextant's problems page and notifications
have no Karpenter category.

## Metrics

None.

## Commands

None.

## Changes it makes

None: it only reads.

## What it does not do

- It does not create, scale, cordon, drain or delete nodes or NodeClaims, and does not change a NodePool's limits or
  budgets.
- It does not judge whether a disruption budget allows a disruption now: the budgets are shown as written.
- A node's own Karpenter and Cluster Autoscaler block, a pending pod's scheduling check and the agents'
  `get_autoscaling_status` stay in Sextant.

## Requirements and limits

- Karpenter's CRDs (`karpenter.sh/v1`, or `v1beta1`); the section shows only where the cluster serves them.
- Where it differs from the former built-in view, because the extension API cannot say it yet:
  - **Usage / limits** writes the nine usual sets of limits — one or two of cpu, memory, nodes and `nvidia.com/gpu` —
    as the built-in column did, and any other set (three resources or more, or another resource) as its limits alone
    in key order (`cpu=100, memory=400Gi, nodes=20`), without what is in use and never red: a case's text holds at most
    five placeholders, and a map's keys cannot be gone through. (A list column over a map's entries, with the entry's
    key and its value at another path in the item's text, would close it.)
  - **"Only problems"** compares, as Kubernetes quantities, the limits of cpu, memory, nodes, pods, ephemeral storage,
    `nvidia.com/gpu`, `amd.com/gpu` and `aws.amazon.com/neuron`; the built-in filter compared every limited resource.
    (The same going through a map's keys, in `atLeast`, would close it.)
  - A NodeClaim's disruption events that could not be read say "The list could not be read." with the cluster's
    message; the built-in block titled the error by its kind.
- Checked by tests on fixtures of Karpenter's objects against the built-in readings (ported unchanged); not yet tried on
  a live cluster.

## Troubleshooting

- **No "Karpenter" section:** the cluster does not serve Karpenter's kinds, or the extension is disabled.
- **No disruption events:** Karpenter reports them as Events, which the cluster keeps for an hour by default.
- **"The list could not be read." in a block:** the extension may not read Events, or the cluster refused your
  credentials.
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → Karpenter.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/karpenter        # → extensions/karpenter/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/karpenter
```

- `src/main.ts` starts the details sections; `details.ts` draws them with the SDK's `ui` kit and holds their watches.
- `model.ts` reads Karpenter's fields and events; it is the former built-in view's `karpenter.ts`, ported unchanged,
  with its "Only problems" filter (`isProblem`) and column texts (`limitsText`, `claimState`) kept as the reference the
  manifest is tested against.
- `model.test.ts` judges the manifest's "Only problems" and columns with Sextant's own window engine
  (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`) and compares them with the model on the fixtures in
  `fixtures/` and variants of them; `views.test.ts` drives the details through the SDK's test host.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `autoscaling`
  texts) and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of
  Sextant's `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `karpenter` and the
     commit (add `karpenter` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
