// Autoscaling insights (#146): why something did or did not scale. Read-only and frontend only.
//  - HorizontalPodAutoscaler details: each metric's current value against its target and the replicas it asks for
//    (the controller's formula with its tolerance), min/max clamping and the behavior's step limits, the conditions in
//    plain words (missing metrics-server or requests, at maxReplicas, stabilization), the target's container requests
//    and the recent scaling events (hpa.ts, HpaSection.tsx);
//  - workloads an HPA or a KEDA ScaledObject scales say so, with the verdict (WorkloadSection.tsx);
//  - a Pending pod the scheduler could not place: its message parsed, a local per-node check (resources, taints,
//    affinity, topology spread, volume zones; ≤ 200 nodes, from taps on the problems store's node and pod watches),
//    and what Karpenter or Cluster Autoscaler decided (scheduling.ts, SchedulingSection.tsx);
//  - nodes: Karpenter's NodePool and NodeClaim and its disruption reasons (drift, consolidation, emptiness,
//    expiration); Cluster Autoscaler's marks and its status ConfigMap (karpenter.ts, clusterAutoscaler.ts,
//    NodeSection.tsx).
// The KEDA and Karpenter kinds' sidebar sections, tables and details are Sextant's own extensions `extensions/keda`
// (`sextant.keda`) and `extensions/karpenter` (`sextant.karpenter`); keda.ts and karpenter.ts keep what the sections
// above and agents' `get_autoscaling_status` read of their objects.
// Nothing here changes the cluster; agents and extensions get nothing new.
import "./autoscaling.css";
import "./register";

export { analyzeHpa } from "./hpa";
export { checkNodes, parseSchedulerMessage } from "./scheduling";
