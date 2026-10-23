// Registers the Cluster API kinds in the sidebar section `clusterApi` (shown only for kinds the cluster serves) and
// their details. Read-only: the kinds offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import {
  clusterClassColumns,
  clusterColumns,
  clusterResourceSetColumns,
  controlPlaneColumns,
  healthCheckColumns,
  machineColumns,
  machineGroupColumns,
} from "./columns";
import { appliesTo, ClusterApiSection } from "./details";
import { CAPI_KINDS, isProblem, isProblemKind } from "./model";

const ICONS: Record<string, IconName> = {
  clusters: "capiCluster",
  clusterClasses: "capiClusterClass",
  controlPlanes: "capiControlPlane",
  machineDeployments: "capiMachineDeployment",
  machineSets: "capiMachineSet",
  machines: "capiMachine",
  machineHealthChecks: "capiHealthCheck",
  clusterResourceSets: "capiResourceSet",
};

const COLUMNS: Record<string, ColumnDef[]> = {
  clusters: clusterColumns,
  clusterClasses: clusterClassColumns,
  controlPlanes: controlPlaneColumns,
  machineDeployments: machineGroupColumns,
  machineSets: machineGroupColumns,
  machines: machineColumns,
  machineHealthChecks: healthCheckColumns,
  clusterResourceSets: clusterResourceSetColumns,
};

for (const def of CAPI_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: {
      section: "clusterApi",
      order: def.order,
      labelKey: `clusterapi:sidebar.${def.label}`,
      icon: ICONS[def.label],
    },
    columns: COLUMNS[def.label] ?? [],
    actions: ["edit", "delete"],
    namespaced: true,
    ...(isProblemKind(def.kind) ? { problem: (obj) => isProblem(obj, def.kind) } : {}),
  });
}

registerDetailsSection({
  id: "clusterApi",
  order: 20,
  appliesTo,
  Component: ClusterApiSection,
});
