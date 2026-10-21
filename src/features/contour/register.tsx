// Registers Contour's kinds in the discovered sidebar section `contour` (shown only for kinds the cluster serves),
// their columns (HTTPProxies with the "Only problems" filter), their details section, and the traffic diagnosis of an
// HTTPProxy (`diagnose.ts`: the "Diagnose" action and the "Diagnosis" tab). Read-only: the kinds offer the generic
// Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { extendActions } from "../../resources/registry";
import { registerRouteDiagnoser } from "../diagnose/routeKinds";
import { delegationColumns, extensionColumns, proxyColumns } from "./columns";
import { ContourSection } from "./details";
import { contourDiagnoser } from "../diagnose/contour";
import { CONTOUR_KINDS, contourKind, EXTENSION_SERVICE, HTTP_PROXY, isProblem, sameKind, type ContourKind } from "./model";

const ICONS: Record<string, IconName> = {
  httpProxies: "contourProxy",
  tlsDelegations: "contourDelegation",
  extensionServices: "contourExtension",
};

function columnsOf({ kind }: ContourKind): ColumnDef[] {
  if (sameKind(kind, HTTP_PROXY)) return proxyColumns;
  if (sameKind(kind, EXTENSION_SERVICE)) return extensionColumns;
  return delegationColumns;
}

for (const def of CONTOUR_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "contour", order: def.order, labelKey: `contour:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: true,
    ...(sameKind(def.kind, HTTP_PROXY) ? { problem: isProblem } : {}),
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "contour", order: 20, appliesTo: (kind) => contourKind(kind) !== undefined, Component: ContourSection });

registerRouteDiagnoser(contourDiagnoser);
extendActions(HTTP_PROXY, ["diagnose"]);
