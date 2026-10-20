// Registers the Crossplane kinds in the discovered sidebar section `crossplane` (shown only for kinds the cluster
// serves): XRDs, Compositions, Providers, Configurations and Functions with their columns; the "Composite resources"
// page (shown with the section); the details of those kinds; and the details of claims, composites and managed
// resources, whatever their kind. Read-only: the kinds offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { registerResource, type ColumnDef } from "../../resources";
import { compositionColumns, packageColumns, xrdColumns } from "./columns";
import { CompositesPage } from "./CompositesPage";
import { CrossplaneResourceSection, CrossplaneSection, mayBeCrossplaneResource } from "./details";
import { COMPOSITION, CROSSPLANE_KINDS, crossplaneKind, FUNCTION, isPackageKind, packageHealth, sameKind, XRD, type CrossplaneKind } from "./model";

export const COMPOSITES_PAGE_ID = "crossplaneComposites";

function iconOf({ kind }: CrossplaneKind): IconName {
  if (sameKind(kind, XRD)) return "crossplaneXrd";
  if (sameKind(kind, COMPOSITION)) return "crossplaneComposition";
  if (sameKind(kind, FUNCTION)) return "crossplaneFunction";
  return "crossplanePackage";
}

function columnsOf({ kind }: CrossplaneKind): ColumnDef[] {
  if (sameKind(kind, XRD)) return xrdColumns;
  if (sameKind(kind, COMPOSITION)) return compositionColumns;
  return packageColumns;
}

for (const def of CROSSPLANE_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "crossplane", order: def.order, labelKey: `crossplane:sidebar.${def.label}`, icon: iconOf(def) },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: false,
    ...(isPackageKind(def.kind) ? { problem: (obj) => packageHealth(obj) === "failed" } : {}),
  });
}

registerPage({
  id: COMPOSITES_PAGE_ID,
  section: "crossplane",
  order: 10,
  labelKey: "crossplane:page.sidebar",
  icon: "crossplaneComposites",
  Component: CompositesPage,
});

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "crossplane", order: 20, appliesTo: (kind) => crossplaneKind(kind) !== undefined, Component: CrossplaneSection });
registerDetailsSection({ id: "crossplaneResource", order: 21, appliesTo: mayBeCrossplaneResource, Component: CrossplaneResourceSection });
