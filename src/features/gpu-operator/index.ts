// NVIDIA GPU Operator (#245, ADR-0116): the discovered sidebar section "NVIDIA GPU Operator" — ClusterPolicies and,
// where served, NVIDIADrivers (nvidia.com) — with the state the operator reports, each component enabled or not and
// its DaemonSet rolled out or not, the MIG strategy; the "GPU nodes" page and the "GPU" block of Nodes (product,
// count, MIG configuration and state, `nvidia.com/gpu` and MIG resources). A ClusterPolicy or NVIDIADriver not ready,
// a component not rolled out and a failed MIG configuration feed the problems screen (category `gpuOperator`, never
// given to agents) and the section counter. Read-only.
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useGpuOperatorProblemCount } from "./badge";
import "./gpu-operator.css";
import "./provider";
import "./register";

registerSectionBadge("gpuOperator", useGpuOperatorProblemCount, { tone: "danger", labelKey: "gpuoperator:badge" });

export * from "./model";
