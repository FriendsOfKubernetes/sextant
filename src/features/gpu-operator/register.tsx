// Registers ClusterPolicies and NVIDIADrivers in the sidebar section `gpuOperator` (shown only where the cluster
// serves them), their details, the "GPU nodes" page and the "GPU" block of Nodes. Read-only: the kinds offer the
// generic Edit and Delete only, under their usual confirmations.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { registerResource } from "../../resources";
import { driverColumns, policyColumns } from "./columns";
import { appliesTo, GpuNodeSection, GpuOperatorSection, nodeApplies } from "./details";
import { GpuNodesPage } from "./GpuNodesPage";
import { CLUSTER_POLICY, NVIDIA_DRIVER, stateOf } from "./model";

export const GPU_NODES_PAGE_ID = "gpuNodes";

registerResource({
  kind: CLUSTER_POLICY,
  sidebar: { section: "gpuOperator", order: 10, labelKey: "gpuoperator:sidebar.clusterPolicies", icon: "clusterPolicy" },
  columns: policyColumns,
  actions: ["edit", "delete"],
  namespaced: false,
  problem: (obj) => stateOf(obj) === "notReady",
});

registerResource({
  kind: NVIDIA_DRIVER,
  sidebar: { section: "gpuOperator", order: 20, labelKey: "gpuoperator:sidebar.drivers", icon: "nvidiaDriver" },
  columns: driverColumns,
  actions: ["edit", "delete"],
  namespaced: false,
  problem: (obj) => stateOf(obj) === "notReady",
});

registerPage({ id: GPU_NODES_PAGE_ID, section: "gpuOperator", order: 30, labelKey: "gpuoperator:page.sidebar", icon: "gpuNodes", Component: GpuNodesPage });

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "gpuOperator", order: 20, appliesTo, Component: GpuOperatorSection });
// A node's GPUs after its DRA devices (27).
registerDetailsSection({ id: "gpuNode", order: 28, appliesTo: nodeApplies, Component: GpuNodeSection });
