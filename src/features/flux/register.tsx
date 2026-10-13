// Registers the Flux kinds in the sidebar section `flux` (shown only for kinds the cluster serves), with their
// columns, details and actions.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ActionId } from "../../resources";
import { fluxTable, sourceColumn } from "./columns";
import { FluxFields, FluxRelatedSection, hasRelated } from "./details";
import { FLUX_KINDS, HELM_RELEASE, isKind, KUSTOMIZATION } from "./model";

const ACTIONS: ActionId[] = ["reconcile", "reconcileWithSource", "fluxSuspend", "fluxResume", "edit", "delete"];

/** Sidebar icon by the label of the kind in `FLUX_KINDS`. */
const ICONS: Record<string, IconName> = {
  gitRepositories: "gitRepository",
  ociRepositories: "ociRepository",
  helmRepositories: "helmRepository",
  helmCharts: "fluxHelmChart",
  buckets: "bucket",
  kustomizations: "kustomization",
  helmReleases: "fluxHelmRelease",
  imageRepositories: "imageRepository",
  imagePolicies: "imagePolicy",
  imageUpdateAutomations: "imageUpdateAutomation",
  alerts: "alert",
  providers: "provider",
  receivers: "receiver",
};

for (const { kind, order, label } of FLUX_KINDS) {
  registerResource({
    kind,
    sidebar: { section: "flux", order, labelKey: `flux:sidebar.${label}`, icon: ICONS[label] },
    columns: isKind(kind, KUSTOMIZATION, HELM_RELEASE) ? fluxTable(sourceColumn) : fluxTable(),
    details: FluxFields,
    actions: ACTIONS,
    namespaced: true,
  });
}

// After the kind's fields (20), before the conditions (30).
registerDetailsSection({ id: "flux", order: 25, appliesTo: hasRelated, Component: FluxRelatedSection });
