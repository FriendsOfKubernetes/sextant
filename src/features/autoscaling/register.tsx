// Registers the KEDA and Karpenter kinds in their discovered sidebar sections (shown only while the cluster serves
// one of them) and the autoscaling sections of the details panel. Read-only: the kinds offer the generic Edit and
// Delete only, under their usual confirmations.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef, type SidebarSection } from "../../resources";
import { authColumns, hasProblem, nodeClaimColumns, nodeClassColumns, nodePoolColumns, scaledJobColumns, scaledObjectColumns } from "./columns";
import { HpaSection } from "./HpaSection";
import { ScaledJobSection, ScaledObjectSection, TriggerAuthenticationSection } from "./KedaSection";
import {
  AKS_NODE_CLASS,
  CLUSTER_TRIGGER_AUTHENTICATION,
  CONFIG_MAP,
  EC2_NODE_CLASS,
  HPA,
  isKind,
  NODE,
  NODE_CLAIM,
  NODE_POOL,
  POD,
  SCALABLE_KINDS,
  SCALED_JOB,
  SCALED_OBJECT,
  TRIGGER_AUTHENTICATION,
} from "./model";
import { CaStatusSection, NodeAutoscalingSection, NodeClaimSection, NodePoolSection } from "./NodeSection";
import { SchedulingSection } from "./SchedulingSection";
import { WorkloadAutoscalingSection } from "./WorkloadSection";
import type { KindRef } from "../../api";

interface ToolKind {
  kind: KindRef;
  section: SidebarSection;
  order: number;
  /** Key under `autoscaling:sidebar`. */
  label: string;
  icon: IconName;
  columns: ColumnDef[];
  namespaced: boolean;
}

export const TOOL_KINDS: ToolKind[] = [
  { kind: SCALED_OBJECT, section: "keda", order: 10, label: "scaledObjects", icon: "scaledObject", columns: scaledObjectColumns, namespaced: true },
  { kind: SCALED_JOB, section: "keda", order: 20, label: "scaledJobs", icon: "scaledJob", columns: scaledJobColumns, namespaced: true },
  { kind: TRIGGER_AUTHENTICATION, section: "keda", order: 30, label: "triggerAuthentications", icon: "triggerAuthentication", columns: authColumns(true), namespaced: true },
  {
    kind: CLUSTER_TRIGGER_AUTHENTICATION,
    section: "keda",
    order: 31,
    label: "clusterTriggerAuthentications",
    icon: "triggerAuthentication",
    columns: authColumns(false),
    namespaced: false,
  },
  { kind: NODE_POOL, section: "karpenter", order: 10, label: "nodePools", icon: "nodePool", columns: nodePoolColumns, namespaced: false },
  { kind: NODE_CLAIM, section: "karpenter", order: 20, label: "nodeClaims", icon: "nodeClaim", columns: nodeClaimColumns, namespaced: false },
  { kind: EC2_NODE_CLASS, section: "karpenter", order: 30, label: "ec2NodeClasses", icon: "nodeClass", columns: nodeClassColumns, namespaced: false },
  { kind: AKS_NODE_CLASS, section: "karpenter", order: 31, label: "aksNodeClasses", icon: "nodeClass", columns: nodeClassColumns, namespaced: false },
];

for (const def of TOOL_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: def.section, order: def.order, labelKey: `autoscaling:sidebar.${def.label}`, icon: def.icon },
    columns: def.columns,
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
    problem: hasProblem,
  });
}

// Sections of built-in kinds: after the kind's fields (20), before the conditions (30).
registerDetailsSection({ id: "autoscalingHpa", order: 25, appliesTo: (kind) => isKind(kind, HPA), Component: HpaSection });
registerDetailsSection({
  id: "autoscalingWorkload",
  order: 26,
  appliesTo: (kind) => SCALABLE_KINDS.some((k) => isKind(kind, k)),
  Component: WorkloadAutoscalingSection,
});
registerDetailsSection({ id: "autoscalingScheduling", order: 21, appliesTo: (kind) => isKind(kind, POD), Component: SchedulingSection });
registerDetailsSection({ id: "autoscalingNode", order: 26, appliesTo: (kind) => isKind(kind, NODE), Component: NodeAutoscalingSection });
registerDetailsSection({ id: "autoscalingCaStatus", order: 22, appliesTo: (kind) => isKind(kind, CONFIG_MAP), Component: CaStatusSection });

// Sections of the tools' kinds, in place of the generic fields.
registerDetailsSection({ id: "autoscalingScaledObject", order: 20, appliesTo: (kind) => isKind(kind, SCALED_OBJECT), Component: ScaledObjectSection });
registerDetailsSection({ id: "autoscalingScaledJob", order: 20, appliesTo: (kind) => isKind(kind, SCALED_JOB), Component: ScaledJobSection });
registerDetailsSection({
  id: "autoscalingTriggerAuth",
  order: 20,
  appliesTo: (kind) => isKind(kind, TRIGGER_AUTHENTICATION, CLUSTER_TRIGGER_AUTHENTICATION),
  Component: TriggerAuthenticationSection,
});
registerDetailsSection({ id: "autoscalingNodePool", order: 20, appliesTo: (kind) => isKind(kind, NODE_POOL), Component: NodePoolSection });
registerDetailsSection({ id: "autoscalingNodeClaim", order: 20, appliesTo: (kind) => isKind(kind, NODE_CLAIM), Component: NodeClaimSection });
