// Registers helm-controller's HelmCharts and HelmChartConfigs in the sidebar section `helmController`, and k3s's
// Addons and etcd snapshots with the "Distribution" page in the section `k3s` ("k3s / RKE2") — each shown only while
// the cluster serves its kinds, so the page appears on a k3s or RKE2 server and nowhere else — their details, and the
// "k3s" / "RKE2" block of Nodes. Read-only: the kinds offer the generic Edit and Delete only, under their usual
// confirmations.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { registerResource } from "../../resources";
import { addonColumns, chartColumns, configColumns, snapshotColumns } from "./columns";
import { appliesTo, K3sSection, NodeSection, nodeApplies } from "./details";
import { DistributionPage } from "./DistributionPage";
import { ADDON, chartStateOf, ETCD_SNAPSHOT, HELM_CHART, HELM_CHART_CONFIG, snapshotOf, snapshotStateOf } from "./model";

export const DISTRIBUTION_PAGE_ID = "k3sDistribution";

registerResource({
  kind: HELM_CHART,
  sidebar: { section: "helmController", order: 10, labelKey: "k3s:sidebar.helmCharts", icon: "helmControllerChart" },
  columns: chartColumns,
  actions: ["edit", "delete"],
  namespaced: true,
  problem: (obj) => chartStateOf(obj) === "failed",
});

registerResource({
  kind: HELM_CHART_CONFIG,
  sidebar: { section: "helmController", order: 20, labelKey: "k3s:sidebar.helmChartConfigs", icon: "helmChartConfig" },
  columns: configColumns,
  actions: ["edit", "delete"],
  namespaced: true,
});

registerPage({ id: DISTRIBUTION_PAGE_ID, section: "k3s", order: 10, labelKey: "k3s:page.sidebar", icon: "k3sDistribution", Component: DistributionPage });

registerResource({
  kind: ADDON,
  sidebar: { section: "k3s", order: 20, labelKey: "k3s:sidebar.addons", icon: "k3sAddon" },
  columns: addonColumns,
  actions: ["edit", "delete"],
  namespaced: true,
});

registerResource({
  kind: ETCD_SNAPSHOT,
  sidebar: { section: "k3s", order: 30, labelKey: "k3s:sidebar.etcdSnapshots", icon: "etcdSnapshot" },
  columns: snapshotColumns,
  actions: ["edit", "delete"],
  namespaced: false,
  problem: (obj) => snapshotStateOf(snapshotOf(obj)) === "failed",
});

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "k3s", order: 20, appliesTo, Component: K3sSection });
// A node's distribution after its GPUs (28).
registerDetailsSection({ id: "k3sNode", order: 29, appliesTo: nodeApplies, Component: NodeSection });
