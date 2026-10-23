// Cluster API (#243, ADR-0113): the discovered sidebar section "Cluster API" — Clusters, ClusterClasses,
// KubeadmControlPlanes, MachineDeployments, MachineSets, Machines, MachineHealthChecks and ClusterResourceSets — with
// each object's state from its own phase and conditions (v1beta2, and v1beta1 with or without `status.v1beta2`).
// Details follow the chain Cluster → control plane and infrastructure → MachineDeployments → MachineSets → Machines →
// bootstrap and infrastructure objects → the Node in the workload cluster, which opens when that cluster is one of
// Sextant's (matched by its API server address, never connected without a click). Failed or stuck Machines,
// unavailable Clusters and control planes and blocked remediation feed the problems screen (category `clusterApi`,
// never given to agents) and the section counter. Read-only.
import { registerSectionBadge } from "../../layout/sectionBadges";
import "./cluster-api.css";
import { useClusterApiProblemCount } from "./badge";
import "./register";

registerSectionBadge("clusterApi", useClusterApiProblemCount, {
  tone: "danger",
  labelKey: "clusterapi:badge",
});

export * from "./model";
