// The kinds the extension may read (its manifest's `permissions`): Cluster API's own kinds by name, and every kind of
// the groups under `cluster.x-k8s.io` (`readGroups`: the control planes, infrastructure, bootstrap configs and addons
// of any provider), as the built-in view read any provider object. `model.test.ts` keeps these equal to the manifest's.
import type { KindRef } from "./model";

/** Cluster API's own kinds, read by name. */
export const READABLE_KINDS: Readonly<Record<string, readonly string[]>> = {
  "cluster.x-k8s.io": ["Cluster", "ClusterClass", "MachineDeployment", "MachineSet", "Machine", "MachineHealthCheck"],
};

/** The groups every kind of which the extension may read: those under this domain. */
export const READ_GROUPS = ["*.cluster.x-k8s.io"] as const;

const DOMAIN = "cluster.x-k8s.io";

/** Whether the extension may read objects of `kind`. */
export const isReadable = (kind: Pick<KindRef, "group" | "kind">): boolean => {
  const group = kind.group.toLowerCase();
  return (READABLE_KINDS[kind.group]?.includes(kind.kind) ?? false) || (group.endsWith(`.${DOMAIN}`) && group.length > DOMAIN.length + 1);
};
