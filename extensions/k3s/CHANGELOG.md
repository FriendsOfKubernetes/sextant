# Changes of k3s / RKE2

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
- **Problems:** HelmCharts whose install failed (from the Job's failure, for a day) or keeps failing, and bundled
  components not available, in the built-in groups.
- Installing asks for consent to read HelmCharts, HelmChartConfigs, Addons, etcd snapshots, Jobs, Nodes and Services,
  Deployments and DaemonSets in kube-system, to open Pods' logs, and to judge HelmCharts, Jobs and Deployments in
  problem rules.
