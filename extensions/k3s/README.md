# k3s / RKE2

Read-only views of [k3s](https://k3s.io) and [RKE2](https://docs.rke2.io) clusters and their
[helm-controller](https://github.com/k3s-io/helm-controller), in every language Sextant has. It adds a "Distribution"
page (what the nodes tell of the distribution and version, the bundled components with a readable state, the Services
ServiceLB serves), lists k3s Addons and etcd snapshots and helm-controller's HelmCharts and HelmChartConfigs in sidebar
sections of their own with Sextant's tables, tells a HelmChart's state with its install Job and that Job's logs, and
adds a "k3s" / "RKE2" block to the details of k3s and RKE2 nodes. It reports HelmCharts whose install failed or keeps
failing and bundled components that are not available. It replaces Sextant's former built-in k3s / RKE2 view
(ADR-0123) with the same behaviour; what still differs is listed under "Requirements and limits". Its id is
`sextant.k3s`. Why it is built this way: ADR-0123 (the readings, the masking and
the problems), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in sections of their own,
rule sources with a label selector, `not`), ADR-0153 (computed columns), ADR-0160 (the sections' icons and places, the
UI kit), ADR-0161 (printer columns left out, paths picking an item, notification groups), ADR-0163 (field values in
texts), ADR-0164 (`atLeast`), ADR-0165 (a kind's own "Only problems") and ADR-0167 (the counters' own labels, more
rules, details sections by condition, without a heading and hidden until shown, a problem about another object, named
objects with their own condition, objects related by a field, capped watches, blocks in Sextant's memory, column
widths, sort values, text conditions, placeholder fallbacks and a merged logs tab's title) and ADR-0169 (the masked
copies of a node's arguments and a chart's values, the object a `relatedBy` finds — preferred, else the newest — with
its window, time and fields, lookups that decide nothing, `served`, `fits`, presence of a secret field and `|cut`).

## At a glance

| | |
|---|---|
| Id | `sextant.k3s` |
| Version | 1.1.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 5: Sextant 0.30.1 or newer; Sextant 0.30.0 is offered 1.0.0. Older Sextants show "needs a newer Sextant". |
| Released from | [FriendsOfKubernetes/sextant-extensions](https://github.com/FriendsOfKubernetes/sextant-extensions/releases), tags `k3s-v<version>`, signed with that repository's key |
| Install | Settings → Extensions → Catalog → k3s / RKE2 |
| Checked against | k3s's and RKE2's own code (`pkg/nodeconfig/nodeconfig.go`, `pkg/cloudprovider/instances.go` and `servicelb.go`, `pkg/deploy`, `manifests/`, RKE2's `charts/chart_versions.yaml`), helm-controller's types and chart controller (`pkg/apis/helm.cattle.io/v1/types.go`, `pkg/controllers/chart/chart.go`) and k3s-io/api's `k3s.cattle.io/v1` (Addon, ETCDSnapshotFile) |

## What it adds

**A sidebar section "k3s / RKE2"** (`k3s`), shown while the cluster serves k3s Addons or etcd snapshots (a k3s or RKE2
server), with the built-in section's icon and place: the page **Distribution** (`distribution`), Addons and etcd
Snapshots with Sextant's own table, filters, selection bar and details, and Edit and Delete as on every kind. Its
counter shows how many bundled components are not available (the problem `component-unavailable`).

**A sidebar section "helm-controller"** (`helmController`), shown while the cluster serves HelmCharts or
HelmChartConfigs: Helm Charts and Helm Chart Configs, the same way. Its counter shows how many HelmCharts failed or keep
failing (the rules of HelmCharts below), each chart once.

**The page "Distribution"** (`distribution`), as the built-in page drew it: the cluster (the distribution — k3s, RKE2,
or nodes of both —, the kubelet versions, how many nodes are recognised, servers and agents, embedded etcd or another
datastore), each recognised node with its distribution, version, role and role labels (servers first), the **bundled
components** of the distribution (k3s: CoreDNS, Traefik, Local Path Provisioner, metrics-server, ServiceLB; RKE2: its
`rke2-*` charts present) with their state (Ready, Not available, Installing, Install failed, No workload yet, Not found —
with the `--disable` flag that leaves it out), the Addon and HelmChart they come from and their Deployments and
DaemonSets in kube-system with how many pods are available, and **ServiceLB**: each Service ServiceLB serves (at most
50, a note when more) with its DaemonSet, how many of its pods are ready and the Service's load-balancer addresses.
The nodes (at most 1000), kube-system's Deployments, DaemonSets (1000 each) and Addons (500), the HelmCharts (500) and
the Jobs labelled `helmcharts.helm.cattle.io/chart` (1000, picked on the API server) are watched while the page shows,
with a note when a list is cut; the Services are read by name, again when a ServiceLB DaemonSet's counts move.

**"Only problems"**, as the built-in tables had it: HelmCharts whose `Failed` condition is True, etcd snapshots with
an error.

**Columns**, in place of the CRDs' own printer columns (left out, as the built-in view did), in the built-in widths:
- Helm Charts, after Namespace: **State** (`chart-state`: Failed, Deleting, Job created or No status, coloured, sorted
  and filtered by the state's name; on hover helm-controller's message, else its reason, while it failed), **Chart**
  (`chart-chart`, `spec.chart` without credentials), **Version** (`chart-version`), **Target namespace**
  (`chart-target-namespace`, `spec.targetNamespace`, else the chart's own) and **Addon** (`chart-addon`, the Addon that
  deployed it by wrangler's owner annotations).
- Helm Chart Configs: **HelmChart** (`config-chart`, the chart of the same name it overrides).
- Addons: **Manifest** (`addon-source`, the file) and **Checksum** (`addon-checksum`, its first 12 characters, cut
  silently).
- etcd Snapshots, after Name: **Node** (`snapshot-node`), **Storage** (`snapshot-storage`: S3 or Local), **Size**
  (`snapshot-size`, in Sextant's byte units, a size that is no quantity as it is, sorted by the text shown), **Created**
  (`snapshot-created`, an age) and **State** (`snapshot-state`: Ready, Failed with the error on hover, Not ready).

**Details**, drawn with the SDK's UI kit in the classes of Sextant's own details panel, without a heading of their own
as the built-in sections had none; each block opens and closes in Sextant's own memory of details sections (as
Settings → Appearance says, with "Expand all" and "Collapse all"):
- a section `k3s` on HelmCharts: helm-controller's message when it failed, or what its state means; the state (with
  its install Job's outcome), chart, repository without credentials, version, target namespace, whether it creates the
  namespace, bootstrap, failure policy, install attempts (backoff limit, 1000 by default), timeout, job image, the
  Secrets and ConfigMap of its repository credentials, CA and registry, the Addon that deployed it and its
  HelmChartConfig, each a link; a block **Install Job** with the Job, its state, failed pods and times and a **Logs**
  button that opens the logs of the pods labelled `helmcharts.helm.cattle.io/chart=<name>` in one merged tab titled
  with the Job's name; a block **Values from Secrets** (each Secret by name with the keys read from it, never a value);
  and a block **Values**: `valuesContent`, `values` and the `set` values, masked and folded, as the built-in view
  showed them (Sextant gives `valuesContent` and `set` masked, see "Permissions"), or a note that they cannot be read;
- the same section on HelmChartConfigs: the HelmChart it overrides (or a note that there is none), its failure policy,
  what it does, and its values;
- the same section on Addons: the manifest file and its checksum;
- the same section on etcd snapshots: the error, the state, snapshot name, node, storage, bucket, location without
  credentials, size, creation and error times;
- a section `k3s-node` on Nodes, shown only on nodes that tell k3s or RKE2 (its kubelet version, k3s's annotations,
  provider ID or instance-type label): a block **k3s** or **RKE2** with the distribution, version, role (server or
  agent — from its role labels or its `server` argument), role labels, what told the distribution, the host name and
  addresses k3s recorded and the etcd member, and a block **Arguments**: each flag with its value, a secret one shown
  as hidden, as the built-in view showed them (Sextant gives them masked).

A HelmChart's Jobs (at most 20, by the chart's label in its namespace) and its HelmChartConfig, and a HelmChartConfig's
HelmChart, are watched by name while the section shows, as the built-in view watched them. Every object named is a link
to its details in Sextant's panel.

The tables' columns, on the page and in the details, resize (drag a header's right edge) and Sextant remembers their
widths, as the built-in view's did; the same columns keep to one line, the others wrap between words.

## Permissions

- **Read** HelmCharts and HelmChartConfigs, Addons and etcd snapshots (the sections, the tables' details and the
  page), Jobs (a chart's install Job, the page's component states and the rules), Nodes (the node section and the page)
  and Services (ServiceLB's load-balancer addresses), in every namespace of every cluster.
- **Read** Deployments and DaemonSets in `kube-system` only: the bundled components and ServiceLB live there.
- **Logs** of Pods in every namespace: the install Job's "Logs" button.
- **Masked secret fields** of Nodes, HelmCharts and HelmChartConfigs (`permissions.maskedSecrets`, ADR-0169): Sextant
  gives a node's `k3s.io/node-args`/`rke2.io/node-args` with every secret value `********` (k3s's own secret flags,
  every flag whose name looks secret, every `*-arg` flag naming a secret-looking setting) and every other value cleaned
  of URI credentials, and a chart's `valuesContent` (as JSON text) and `set` with every value under a secret-looking key
  `<hidden>`, computed in Sextant before the object leaves it, by the rules the built-in view masked them with; what
  does not read is given empty. A node's `node-env` is never given. Agents never get these copies through the
  extension. The consent screen names the kinds.
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge HelmCharts and kube-system's Deployments, and look up Jobs (listed by helm-controller's
  label `helmcharts.helm.cattle.io/chart`, at most 1000, as the built-in category listed them); Sextant asks for that
  separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `k3s`, on by default. Every rule may notify; the reasons are the built-in ones:
`HelmChartFailed`, `HelmChartRetrying`, `ComponentUnavailable`, one notification group each (`helm-chart-failed`,
`helm-chart-retrying`, `component-unavailable`). A HelmChart being deleted is not judged. The values of a chart never
reach a problem.

A chart's **install Job** is the one helm-controller runs for it, found as the built-in view found it: among the Jobs
labelled `helmcharts.helm.cattle.io/chart=<name>` in its namespace, the one `status.jobName` names, else the one
helm-controller would name (`helm-install-<name>`), else the newest. A chart's install failed when that Job failed or
when helm-controller's own `Failed` condition holds; every problem is **about the HelmChart itself**, once per chart.
With its own `Failed` condition the message is helm-controller's (else its reason), counted from the Job's failure for
a day where the Job failed, and from when it is first seen otherwise — also while the Jobs cannot be read, as the
built-in category judged it. A failed Job of a chart that does not say so itself gives the Job's message, dated the
same. Because a message is one template, each has a twin for "no message" that says "The install Job … of this
HelmChart failed." with that Job's name, or none.

| Id | Kind judged | Problem about | When it holds | Grace | Told by another object |
|---|---|---|---|---|---|
| `chart-failed`, `chart-failed-plain` | HelmChart | Itself | `Failed` condition True, not being deleted (the twin: no message or reason); until a day after its install Job failed, where it failed | None | No |
| `chart-job-failed`, `chart-job-failed-plain` | HelmChart | Itself | Its own `Failed` condition does not hold, not being deleted, and its install Job's `Failed` condition is True, for a day from that condition's time (the twin: the Job has no message) | None | No |
| `chart-retrying` | HelmChart | Itself | Its own `Failed` condition does not hold, not being deleted, and its install Job is neither failed nor complete after 3 or more failed pods | 5 min from when it is first seen | No |
| `component-unavailable` | Deployment in kube-system | Itself | A bundled component's (`coredns`, `local-path-provisioner`, `metrics-server` by name; the `traefik` and `rke2-*` charts' by Helm's release annotation), where the cluster serves k3s Addons (a server), not being deleted, its `Available` condition False or fewer replicas available than wanted | 10 min from when `Available` went False, else from when it is first seen | No |

## Metrics

None.

## Commands

None.

## Changes it makes

None: the extension is read-only and has no action of its own (ADR-0123).

## What it does not do

- It does not change a HelmChart, HelmChartConfig or Addon, re-run an install Job, take or restore an etcd snapshot,
  or change a node's arguments.
- It does not read a HelmChart's `valuesSecrets` or `authSecret` Secrets: only their names and the key names are shown.
- It never shows a secret value: a node's arguments and a chart's values pass the built-in masking rules (ADR-0123),
  first in Sextant, which gives the extension only masked copies of them (and nothing of a node's environment), then
  again in the frame.

## Requirements and limits

- k3s or RKE2: the section "k3s / RKE2" shows only where the cluster serves `k3s.cattle.io/v1` Addons or
  ETCDSnapshotFiles, "helm-controller" only where it serves `helm.cattle.io/v1` HelmCharts or HelmChartConfigs.
- **What Sextant gives the extension.** Sextant hides inline secret material from every extension
  (`without_inline_secrets`, ADR-0123); this one asks for masked copies (`permissions.maskedSecrets`, ADR-0169): a
  node's `node-args`, a HelmChart's `valuesContent` and `set`, a HelmChartConfig's `valuesContent`, masked in Sextant
  by the built-in rules, named in `sextant.dev/values-masked`. A value Sextant cannot read safely (not k3s's JSON list,
  not one YAML mapping, a YAML tag, too long) is given empty, and the views say it cannot be read, as the built-in view
  did for what it could not read; Sextant reads a little more strictly than the built-in view (a YAML tag or a key
  that is no text is not read), so such a value is unreadable here where the built-in view showed it.
- Where it still differs from the former built-in view:
  - The ServiceLB Services are read in one `resources.getMany` instead of four at a time, so their addresses come at
    once; what is shown is the same.
  - Agents get the category only when the user lets them have the extension's problems (Settings → AI agents (MCP),
    off by default); the built-in category was never given to agents.
- Checked by tests on fixtures of k3s's, RKE2's and helm-controller's objects (copied from the built-in view) against
  the built-in readings and rules; not yet tried on a live cluster.

## Troubleshooting

- **No "k3s / RKE2" or "helm-controller" section:** the cluster does not serve k3s's or helm-controller's kinds (not a
  k3s or RKE2 server), or the extension is disabled.
- **"The nodes cannot be read." on the Distribution page:** the extension may not read Nodes, or the cluster refused
  your credentials.
- **"kube-system's Deployments or DaemonSets cannot be read.":** the cluster refused your credentials there.
- **"The arguments cannot be read." or "The values are not shown":** Sextant could not read them safely (they are not
  what k3s or helm-controller writes), so it gave the extension nothing of them; the YAML section shows them as they
  are.
- **"Sextant refused: …" in a section:** the extension's permissions do not cover the object. Check Settings →
  Extensions → k3s / RKE2.

## Development

From the Sextant repository:

```sh
npm run sdk:build -- extensions/k3s        # → extensions/k3s/dist, load it with "Load unpacked folder…"
npx vitest run --config sdk/vitest.config.ts ../extensions/k3s
```

- `src/main.ts` starts the details sections and the page; `details.ts` draws the sections with the SDK's `ui` kit,
  keeps their blocks in Sextant's memory and holds the watches of a chart's Jobs and HelmChartConfig; `page.ts` draws
  "Distribution".
- `model.ts` reads k3s's, RKE2's and helm-controller's fields and `mask.ts` hides secret values; both are the former
  built-in view's, ported, with its problem detector (`builtInProblems`) kept as the reference the manifest is tested
  against. `uri.ts` is Sextant's cleaner of URIs.
- `model.test.ts` judges the manifest's problem rules (their lookups by `src/extensions/problemsAcross.ts`'s own
  `judgeAcross`, on rows built as the problems store builds them), the kinds' "Only problems", the Node section's
  condition and the columns with Sextant's own window engine (`src/extensions/problemRules.ts`,
  `src/extensions/columns.tsx`) and compares them with the model on the fixtures in `fixtures/`, and the masking with
  Sextant's (`src/resources/masking-cases.json`); `views.test.ts` drives the details and the page through the SDK's
  test host, with objects as Sextant gives them to this extension (masked copies).
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `k3s` texts)
  and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of Sextant's
  `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `k3s` and the
     commit (add `k3s` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
