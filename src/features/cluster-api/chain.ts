// The chain of one Cluster's Machines as its details draw it, from the label-selected lists of its namespace: the
// control plane's Machines, each MachineDeployment with its MachineSets (by controller owner) and theirs, MachineSets
// of no MachineDeployment, then every other Machine (a MachinePool's, a lone one). At most `max` Machines are kept,
// in that order; the rest are counted.
import type { KubeObject } from "../../api";
import { controllerOf } from "../../resources/status";
import { isControlPlaneMachine } from "./model";

export interface SetPlan {
  set: KubeObject;
  machines: KubeObject[];
}

export interface ChainPlan {
  controlPlane: KubeObject[];
  deployments: { deployment: KubeObject; sets: SetPlan[] }[];
  sets: SetPlan[];
  others: KubeObject[];
  /** Machines left out past `max`. */
  hidden: number;
}

const ownedBy = (obj: KubeObject, kind: string, name: string | undefined) => {
  const owner = controllerOf(obj);
  return owner?.kind === kind && owner.name === name;
};

export function planChain(deployments: KubeObject[], sets: KubeObject[], machines: KubeObject[], max: number): ChainPlan {
  let left = max;
  let hidden = 0;
  const take = (list: KubeObject[]) => {
    const kept = list.slice(0, Math.max(0, left));
    left -= kept.length;
    hidden += list.length - kept.length;
    return kept;
  };
  const placed = new Set<KubeObject>();
  const setPlan = (set: KubeObject): SetPlan => {
    const mine = machines.filter((m) => ownedBy(m, "MachineSet", set.metadata?.name));
    mine.forEach((m) => placed.add(m));
    return { set, machines: take(mine) };
  };
  const cp = machines.filter((m) => isControlPlaneMachine(m));
  cp.forEach((m) => placed.add(m));
  const controlPlane = take(cp);
  const inDeployment = new Set<KubeObject>();
  const deploymentPlans = deployments.map((deployment) => {
    const own = sets.filter((s) => ownedBy(s, "MachineDeployment", deployment.metadata?.name));
    own.forEach((s) => inDeployment.add(s));
    return { deployment, sets: own.map(setPlan) };
  });
  const loose = sets.filter((s) => !inDeployment.has(s)).map(setPlan);
  const others = take(machines.filter((m) => !placed.has(m)));
  return { controlPlane, deployments: deploymentPlans, sets: loose, others, hidden };
}
