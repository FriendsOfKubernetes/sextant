// Registers the OLM kinds in the sidebar section `olm` (shown only for kinds the cluster serves: OLM v0's
// operators.coreos.com and, where installed, OLM v1's olm.operatorframework.io) and their details. Read-only: the kinds
// offer the generic Edit and Delete only; nothing approves an InstallPlan (ADR-0121).
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import {
  catalogSourceColumns,
  clusterCatalogColumns,
  clusterExtensionColumns,
  csvColumns,
  installPlanColumns,
  operatorColumns,
  operatorGroupColumns,
  subscriptionColumns,
} from "./columns";
import { appliesTo, OlmSection } from "./details";
import { isProblem, OLM_KINDS } from "./model";

const ICONS: Record<string, IconName> = {
  subscriptions: "olmSubscription",
  csvs: "olmCsv",
  installPlans: "olmInstallPlan",
  catalogSources: "olmCatalogSource",
  operatorGroups: "olmOperatorGroup",
  operators: "olmOperator",
  clusterExtensions: "olmClusterExtension",
  clusterCatalogs: "olmClusterCatalog",
};

const COLUMNS: Record<string, ColumnDef[]> = {
  subscriptions: subscriptionColumns,
  csvs: csvColumns,
  installPlans: installPlanColumns,
  catalogSources: catalogSourceColumns,
  operatorGroups: operatorGroupColumns,
  operators: operatorColumns,
  clusterExtensions: clusterExtensionColumns,
  clusterCatalogs: clusterCatalogColumns,
};

/** Kinds with an "Only problems" filter. */
const PROBLEM_LABELS = new Set(["subscriptions", "csvs", "installPlans", "catalogSources"]);

for (const def of OLM_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "olm", order: def.order, labelKey: `olm:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: COLUMNS[def.label] ?? [],
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
    ...(PROBLEM_LABELS.has(def.label) ? { problem: (obj) => isProblem(obj, def.kind) } : {}),
  });
}

registerDetailsSection({ id: "olm", order: 20, appliesTo, Component: OlmSection });
