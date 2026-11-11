# Changes of k3s / RKE2

## 1.1.0 — 2026-11-12

Needs Sextant 0.30.1 (`sextantApi` 5); Sextant 0.30.0 keeps 1.0.0. What the built-in view did that extension API 4
could not say (ADR-0169):

- **A node's arguments and a chart's values** are shown masked again, as the built-in view showed them: Sextant gives
  the extension a masked copy of a node's `node-args` and a HelmChart's `valuesContent` and `set` (a HelmChartConfig's
  `valuesContent`), every secret value hidden in Sextant before the object leaves it (`permissions.maskedSecrets`,
  asked for at install); a node's environment is still never given. A node's role comes from its `server` argument
  too, and a value Sextant cannot read safely is said to be unreadable, as the built-in view said it.
- **The problems of a HelmChart** are judged on the chart with its install Job as the built-in category judged them:
  the Job the chart names, else `helm-install-<name>`, else the newest labelled for it; helm-controller's own message
  dated from its Job's failure; the chart's own `Failed` condition also while its Jobs cannot be read; the "no
  message" text naming that Job, or none. Each problem is about the chart itself (`chart-failed`, `chart-failed-plain`,
  `chart-job-failed`, `chart-job-failed-plain`, `chart-retrying` replace the rules of 1.0.0).
- **A bundled component** is judged wherever the cluster serves k3s Addons, as the built-in category did.
- **The Node section** shows on a node whose kubelet version reads like k3s's or RKE2's (`+k3s<n>`, `+rke2r<n>`), not on
  a look-alike, and on one whose only sign is its `node-args` or `node-env` annotation.
- **Checksum** is cut to 12 characters silently, and **Size** shows a size that is no quantity as it is and sorts by the
  text shown, as the built-in columns did.
- Installing asks for consent to the masked fields of Nodes, HelmCharts and HelmChartConfigs; the problem rules judge
  HelmCharts and Deployments and look up Jobs (listed by helm-controller's label), no longer Addons.

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in k3s / RKE2 view (ADR-0123) as an
extension.

- **Sidebar sections "k3s / RKE2"** (the page **Distribution**, Addons and etcd Snapshots) and **"helm-controller"**
  (Helm Charts and Helm Chart Configs) in their built-in places, in Sextant's table with the built-in columns (State,
  Chart, Version, Target namespace, Addon; HelmChart; Manifest, Checksum; Node, Storage, Size, Created, State) and
  "Only problems", each section with its counter.
- **Distribution:** the distribution and versions the nodes tell, servers, agents and embedded etcd, each node's role,
  the bundled components with their state, source and workloads, and ServiceLB's Services with their addresses.
- **Details:** a HelmChart's state with its install Job and the Job's logs, what it installs, the Secrets of its values
  by name; a HelmChartConfig's HelmChart; an Addon's manifest; an etcd snapshot's storage and error; and a **k3s** or
  **RKE2** block on k3s and RKE2 nodes. The blocks open and close in Sextant's memory of details sections. A node's
  arguments and a chart's `valuesContent` and `set`, which Sextant keeps from extensions, are said to be in the YAML
  section; what the extension does get of a chart's values is masked as before.
- **Tables** on the page and in the details whose columns resize and are remembered, as the built-in tables'.
- The install Job block's **Logs** button carries Sextant's logs icon, as the built-in one did.
- **Problems:** HelmCharts whose install failed (from the Job's failure, for a day) or keeps failing, and bundled
  components not available, in the built-in groups.
- Installing asks for consent to read HelmCharts, HelmChartConfigs, Addons, etcd snapshots, Jobs, Nodes and Services,
  Deployments and DaemonSets in kube-system, to open Pods' logs, and to judge HelmCharts, Jobs and Deployments in
  problem rules.
