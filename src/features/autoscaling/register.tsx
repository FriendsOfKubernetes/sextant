// Registers the autoscaling sections of the details panel. The KEDA and Karpenter kinds' sidebar sections, tables and
// details are Sextant's own extensions `extensions/keda` (`sextant.keda`) and `extensions/karpenter`
// (`sextant.karpenter`, ADR-0162 amendment); the sections below still read their objects where a built-in kind needs
// them (a workload a ScaledObject scales, a Karpenter node, a Pending pod Karpenter is launching a node for).
import { registerDetailsSection } from "../../layout/details/registry";
import { HpaSection } from "./HpaSection";
import { CONFIG_MAP, HPA, isKind, NODE, POD, SCALABLE_KINDS } from "./model";
import { CaStatusSection, NodeAutoscalingSection } from "./NodeSection";
import { SchedulingSection } from "./SchedulingSection";
import { WorkloadAutoscalingSection } from "./WorkloadSection";

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
