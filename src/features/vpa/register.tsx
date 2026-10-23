// Registers VerticalPodAutoscalers and their checkpoints in the sidebar section `vpa` (shown only where the cluster
// serves the kinds), the details of a VPA, and the VPA block of the workloads a VPA can target, right after
// right-sizing (55). Read-only: the kinds offer the generic Edit and Delete only, under their usual confirmations.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource } from "../../resources";
import { checkpointColumns, vpaColumns } from "./columns";
import { appliesTo, VpaSection } from "./details";
import { isProblem, VPA, VPA_CHECKPOINT } from "./model";
import { VpaWorkloadSection, workloadApplies } from "./WorkloadSection";

registerResource({
  kind: VPA,
  sidebar: { section: "vpa", order: 10, labelKey: "vpa:sidebar.vpas", icon: "verticalPodAutoscaler" },
  columns: vpaColumns,
  actions: ["edit", "delete"],
  namespaced: true,
  problem: isProblem,
});

registerResource({
  kind: VPA_CHECKPOINT,
  sidebar: { section: "vpa", order: 20, labelKey: "vpa:sidebar.checkpoints", icon: "vpaCheckpoint" },
  columns: checkpointColumns,
  actions: ["edit", "delete"],
  namespaced: true,
});

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "vpa", order: 20, appliesTo, Component: VpaSection });
// Right after right-sizing (55).
registerDetailsSection({ id: "vpaWorkload", order: 56, appliesTo: workloadApplies, Component: VpaWorkloadSection });
