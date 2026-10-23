// Details of Cluster API objects (one section, `clusterApi`, #243):
//   Cluster                 — its state in words, the class and version, the control plane endpoint, the control
//                             plane and infrastructure objects (read by name: kind, name, ready), the Machine counts,
//                             the workload cluster when Sextant has it, and the chain control plane / MachineDeployments
//                             → MachineSets → Machines (label-selected watches of the Cluster's namespace);
//   Machine                 — phase, owner, version, provider ID, the bootstrap and infrastructure objects (read by
//                             name, with a few fields of Docker, AWS, Azure and vSphere machines) and the Node, which
//                             opens in the workload cluster when Sextant has it;
//   MachineDeployment / MachineSet / KubeadmControlPlane — replica counts, templates and their Machines;
//   MachineHealthCheck      — what it checks, healthy of expected, remediations allowed, why remediation is blocked.
// ClusterClasses and ClusterResourceSets have the panel's generic sections only. Conditions and YAML are the panel's
// own sections. Read-only: nothing here changes the cluster, and a workload cluster is connected only by a click.
import type { KindRef } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { ClusterView } from "./clusterView";
import { ControlPlaneView, HealthCheckView, MachineGroupView, MachineView } from "./machineViews";
import { CAPI_CLUSTER, isKind, KUBEADM_CONTROL_PLANE, MACHINE, MACHINE_DEPLOYMENT, MACHINE_HEALTH_CHECK, MACHINE_SET } from "./model";

export function ClusterApiSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  if (!obj) return null;
  const kind = objectRef.kind;
  if (isKind(kind, CAPI_CLUSTER)) return <ClusterView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, MACHINE)) return <MachineView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, MACHINE_DEPLOYMENT, MACHINE_SET)) return <MachineGroupView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, KUBEADM_CONTROL_PLANE)) return <ControlPlaneView clusterId={clusterId} obj={obj} />;
  if (isKind(kind, MACHINE_HEALTH_CHECK)) return <HealthCheckView obj={obj} />;
  return null;
}

export const appliesTo = (kind: KindRef): boolean => isKind(kind, CAPI_CLUSTER, MACHINE, MACHINE_DEPLOYMENT, MACHINE_SET, KUBEADM_CONTROL_PLANE, MACHINE_HEALTH_CHECK);
