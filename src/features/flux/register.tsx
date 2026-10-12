// Registers the Flux kinds in the sidebar section `flux` (shown only for kinds the cluster serves), with their
// columns, details and actions.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ActionId } from "../../resources";
import { fluxTable, sourceColumn } from "./columns";
import { FluxFields, FluxRelatedSection, hasRelated } from "./details";
import { FLUX_KINDS, HELM_RELEASE, isKind, KUSTOMIZATION } from "./model";

const ACTIONS: ActionId[] = ["reconcile", "reconcileWithSource", "fluxSuspend", "fluxResume", "edit", "delete"];

for (const { kind, order, label } of FLUX_KINDS) {
  registerResource({
    kind,
    sidebar: { section: "flux", order, labelKey: `flux:sidebar.${label}` },
    columns: isKind(kind, KUSTOMIZATION, HELM_RELEASE) ? fluxTable(sourceColumn) : fluxTable(),
    details: FluxFields,
    actions: ACTIONS,
    namespaced: true,
  });
}

// After the kind's fields (20), before the conditions (30).
registerDetailsSection({ id: "flux", order: 25, appliesTo: hasRelated, Component: FluxRelatedSection });
