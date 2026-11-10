# k3s / RKE2

Read-only views of [k3s](https://k3s.io) and [RKE2](https://docs.rke2.io) clusters and their
[helm-controller](https://github.com/k3s-io/helm-controller), in every language Sextant has. It adds a "Distribution"
page (what the nodes tell of the distribution and version, the bundled components with a readable state, the Services
ServiceLB serves), lists k3s Addons and etcd snapshots and helm-controller's HelmCharts and HelmChartConfigs in sidebar
sections of their own with Sextant's tables, tells a HelmChart's state with its install Job and that Job's logs, and
adds a "k3s" / "RKE2" block to the details of k3s and RKE2 nodes. It reports HelmCharts whose install failed or keeps
failing and bundled components that are not available. It replaces Sextant's former built-in k3s / RKE2 view
(ADR-0123) with the same behaviour; the few places where the extension API cannot say it yet are listed under
"Requirements and limits". Its id is `sextant.k3s`. Why it is built this way: ADR-0123 (the readings, the masking and
the problems), ADR-0139 (Sextant's own extensions), ADR-0140 (translations), ADR-0152 (kinds in sections of their own,
rule sources with a label selector, `not`), ADR-0153 (computed columns), ADR-0160 (the sections' icons and places, the
UI kit), ADR-0161 (printer columns left out, paths picking an item, notification groups), ADR-0163 (field values in
texts), ADR-0164 (`atLeast`), ADR-0165 (a kind's own "Only problems") and ADR-0167 (the counters' own labels, more
rules, details sections by condition, without a heading and hidden until shown, a problem about another object, named
objects with their own condition, objects related by a field, capped watches, blocks in Sextant's memory, column
widths, sort values, text conditions, placeholder fallbacks and a merged logs tab's title).

## At a glance

| | |
|---|---|
| Id | `sextant.k3s` |
| Version | 1.0.0 ([changes](CHANGELOG.md)) |
| Extension API | `sextantApi` 4: Sextant 0.30 or newer. Older Sextants show "needs a newer Sextant". |
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
failing (the rules of HelmCharts and their Jobs below), each chart once.

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
- Addons: **Manifest** (`addon-source`, the file) and **Checksum** (`addon-checksum`, its first 12 characters).
- etcd Snapshots, after Name: **Node** (`snapshot-node`), **Storage** (`snapshot-storage`: S3 or Local), **Size**
  (`snapshot-size`, in Sextant's byte units), **Created** (`snapshot-created`, an age) and **State**
  (`snapshot-state`: Ready, Failed with the error on hover, Not ready).

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
  and a block **Values** (see "Requirements and limits" for what Sextant gives the extension of them);
- the same section on HelmChartConfigs: the HelmChart it overrides (or a note that there is none), its failure policy,
  what it does, and its values;
- the same section on Addons: the manifest file and its checksum;
- the same section on etcd snapshots: the error, the state, snapshot name, node, storage, bucket, location without
  credentials, size, creation and error times;
- a section `k3s-node` on Nodes, shown only on nodes that tell k3s or RKE2 (its kubelet version, k3s's annotations,
  provider ID or instance-type label): a block **k3s** or **RKE2** with the distribution, version, role (server or
  agent), role labels, what told the distribution, the host name and addresses k3s recorded and the etcd member, and a
  block **Arguments**.

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
- Nothing is changed or deleted by the extension; Edit and Delete are Sextant's own actions, under your own rules.
- Its problem rules judge HelmCharts, Jobs and kube-system's Deployments, and look up Jobs, HelmCharts and Addons;
  Sextant asks for that separately at install.
- An update asks for consent again when it needs a new kind or action, or changes a grant.

## Problems

As the built-in category `k3s`, on by default. Every rule may notify; the reasons are the built-in ones:
`HelmChartFailed`, `HelmChartRetrying`, `ComponentUnavailable`, one notification group each (`helm-chart-failed`,
`helm-chart-retrying`, `component-unavailable`). A HelmChart being deleted is not judged, nor are its Jobs. The values
of a chart never reach a problem.

A chart's install failed when its Job (`helm-install-<name>`) failed or when helm-controller's own `Failed` condition
holds. A failed Job is a problem **about its HelmChart**, counted from the Job's failure for a day, with the Job's
message; the chart's own condition counts while its Job did not fail (it is gone, is there and did not fail, or none is
named), with helm-controller's message, else its reason. Because a message is one template, each has a twin for "no
message" that says "The install Job … of this HelmChart failed.".

| Id | Kind judged | Problem about | When it holds | Grace | Told by another object |
|---|---|---|---|---|---|
| `chart-failed-job-missing`, `chart-failed-job-missing-plain` | HelmChart | Itself | `Failed` condition True, not being deleted, and the Job `status.jobName` names is not there (the twin: no message or reason) | None | No |
| `chart-failed-job-not-failed`, `chart-failed-job-not-failed-plain` | HelmChart | Itself | As above, and that Job is there and did not fail | None | No |
| `chart-failed-no-job`, `chart-failed-no-job-plain` | HelmChart | Itself | As above, and no Job is named | None | No |
| `job-failed`, `job-failed-plain` | Job (labelled `helmcharts.helm.cattle.io/chart`) | Its HelmChart | An install Job whose `Failed` condition is True, of a chart not being deleted, for a day from that condition's time (the twin: no message) | None | No |
| `job-retrying` | Job (as above) | Its HelmChart | An install Job neither failed nor complete after 3 or more failed pods, of a chart not being deleted whose own `Failed` condition does not hold | 5 min from when it is first seen | No |
| `component-unavailable` | Deployment in kube-system | Itself | A bundled component's (`coredns`, `local-path-provisioner`, `metrics-server` by name; the `traefik` and `rke2-*` charts' by Helm's release annotation), on a server (an Addon in kube-system), not being deleted, its `Available` condition False or fewer replicas available than wanted | 10 min from when `Available` went False, else from when it is first seen | No |

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
  and Sextant keeps the fields that may hold secrets from the extension altogether.

## Requirements and limits

- k3s or RKE2: the section "k3s / RKE2" shows only where the cluster serves `k3s.cattle.io/v1` Addons or
  ETCDSnapshotFiles, "helm-controller" only where it serves `helm.cattle.io/v1` HelmCharts or HelmChartConfigs.
- **What Sextant gives the extension.** Sextant hides inline secret material from every extension
  (`without_inline_secrets`, ADR-0123): a node's `k3s.io/node-args`/`rke2.io/node-args` and `node-env` annotations and
  a HelmChart's `spec.valuesContent` and `spec.set` (a HelmChartConfig's `spec.valuesContent`) reach it as empty texts,
  named in the annotation `sextant.dev/values-hidden`. The frame carries the built-in masking (`src/mask.ts`, ported
  unchanged) and applies it to what it does get — a chart's `spec.values`, a HelmChartConfig's `spec.set` — but it
  cannot show the masked node arguments or the masked `valuesContent` and `set`, which the built-in view showed: it says
  that Sextant keeps them and that the YAML section shows them. Showing the masked view needs Sextant to give an
  extension the masked text instead of an empty one — for these paths, a projection computed in Rust by ADR-0123's
  rules (a node's arguments as flag/value pairs with secret values hidden, a chart's values as YAML with secret-looking
  keys hidden) — an API addition, not something an extension can do.
- Where it still differs from the former built-in view, because the extension API cannot say it yet:
  - A HelmChart whose own `Failed` condition holds while its install Job failed is told by the Job's rule, so the
    problem's message is the Job's ("Job has reached the specified backoff limit") where the built-in one showed
    helm-controller's; its time and its day are the Job's, as before. A rule judging the chart cannot read its Job's
    time and a rule judging the Job cannot read the chart's message (a placeholder of a `related` object's field, or a
    time condition inside `related`, would close it).
  - A Failed chart without `status.jobName` keeps its own reading, without the Job's day: the built-in view found its
    Job by the name helm-controller would give it (`helm-install-<name>`), which no condition can build from the
    chart's name. helm-controller writes `status.jobName` with its conditions, so this needs an older controller.
  - A chart's Job rules judge the Jobs named `helm-install-…`; the built-in view took, when the Job `status.jobName`
    names was not there, the newest Job labelled for the chart.
  - The "no message" text of a Failed chart without a Job names the Job `status.jobName` names, where the built-in
    text left the name empty.
  - A Failed chart that names a Job is judged only once the Jobs are read (a rule that looks a Job up cannot tell
    before): the built-in category judged its own condition without them, also for a user who may not list Jobs.
  - A bundled component is judged where kube-system has an Addon (k3s and RKE2 servers always do); the built-in
    category judged it wherever Addons were served.
  - A node's role comes from its role labels only: the built-in view also took a `server` first argument, which Sextant
    keeps from the extension (servers carry the control-plane label anyway).
  - The Node section's condition cannot read a pattern, so a node whose kubelet version only looks like k3s's
    (`+k3sx`) gets the section's frame, which then hides itself; and a node whose only sign is its `node-args`
    annotation (always written with `node-config-hash`, which the condition reads) shows no section.
  - The Addon's Checksum column cuts the checksum with "…" (the `clip` filter); the built-in column cut it silently.
  - The Size column sorts by the amount and shows nothing for a size that is no quantity; the built-in column sorted
    by the text shown and showed such a size as it was.
  - The Install Job block's "Logs" button is a text button without the logs icon (the SDK's buttons have no icon).
  - The ServiceLB Services are read in one `resources.getMany` instead of four at a time, so their addresses come at
    once.
  - Agents get the category only when the user lets them have the extension's problems (Settings → AI agents (MCP));
    the built-in category was never given to agents.
- Checked by tests on fixtures of k3s's, RKE2's and helm-controller's objects (copied from the built-in view) against
  the built-in readings and rules; not yet tried on a live cluster.

## Troubleshooting

- **No "k3s / RKE2" or "helm-controller" section:** the cluster does not serve k3s's or helm-controller's kinds (not a
  k3s or RKE2 server), or the extension is disabled.
- **"The nodes cannot be read." on the Distribution page:** the extension may not read Nodes, or the cluster refused
  your credentials.
- **"kube-system's Deployments or DaemonSets cannot be read.":** the cluster refused your credentials there.
- **"The node's arguments are there, but Sextant does not give them to extensions":** expected; the YAML section of
  the node shows its annotations.
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
- `model.test.ts` judges the manifest's problem rules (their `missing`, `related` and `relatedBy` lookups as
  `src/extensions/problemsAcross.ts` does, their `about`), the kinds' "Only problems", the Node section's condition
  and the columns with Sextant's own window engine (`src/extensions/problemRules.ts`, `src/extensions/columns.tsx`)
  and compares them with the model on the fixtures in `fixtures/`; `views.test.ts` drives the details and the page
  through the SDK's test host, with objects as Sextant gives them to an extension.
- The texts are in `src/locales/<lang>.json` (English is the source; they come from the built-in view's `k3s` texts)
  and in the manifest's `translations`. `src/locales.test.ts` keeps both complete in every language of Sextant's
  `src/locales/`.
- **A release:**
  1. Raise `version` in `sextant-extension.json`, add its section to `CHANGELOG.md`, and merge to `main`.
  2. Run the workflow "Release a Sextant extension" of FriendsOfKubernetes/sextant-extensions with `k3s` and the
     commit (add `k3s` to that workflow's `extension` choices first).
  3. The catalog's index picks the release up.
