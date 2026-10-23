// Registers the resource.k8s.io kinds in the sidebar section `dra` (shown only where the cluster serves them, in the
// version it serves), their details, the "Devices" page, and the DRA blocks of Pods and Nodes. Read-only: the kinds
// offer the generic Edit and Delete only, under their usual confirmations.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { registerResource, type ColumnDef } from "../../resources";
import { claimColumns, deviceClassColumns, sliceColumns, templateColumns } from "./columns";
import { appliesTo, DraSection } from "./details";
import { DevicesPage } from "./DevicesPage";
import { claimState, DRA_KINDS } from "./model";
import { DraNodeSection, DraPodSection, nodeApplies, podApplies } from "./nodePod";

export const DEVICES_PAGE_ID = "draDevices";

const ICONS: Record<string, IconName> = {
  claims: "resourceClaim",
  templates: "resourceClaimTemplate",
  deviceClasses: "deviceClass",
  slices: "resourceSlice",
};

const COLUMNS: Record<string, ColumnDef[]> = {
  claims: claimColumns,
  templates: templateColumns,
  deviceClasses: deviceClassColumns,
  slices: sliceColumns,
};

for (const def of DRA_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "dra", order: def.order, labelKey: `dra:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: COLUMNS[def.label] ?? [],
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
    ...(def.label === "claims" ? { problem: (obj) => claimState(obj) === "bindingFailed" } : {}),
  });
}

registerPage({ id: DEVICES_PAGE_ID, section: "dra", order: 30, labelKey: "dra:page.sidebar", icon: "draDevices", Component: DevicesPage });

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "dra", order: 20, appliesTo, Component: DraSection });
// A pod's devices next to its scheduling (21); a node's devices next to its autoscaling (26).
registerDetailsSection({ id: "draPod", order: 22, appliesTo: podApplies, Component: DraPodSection });
registerDetailsSection({ id: "draNode", order: 27, appliesTo: nodeApplies, Component: DraNodeSection });
