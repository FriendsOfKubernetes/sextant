// Registers the Knative Serving kinds in the discovered sidebar section `knative` (shown only for kinds the cluster
// serves), their columns with the "Only problems" filter, and their details section. Read-only: the kinds offer the
// generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { configurationColumns, domainMappingColumns, revisionColumns, routeColumns, serviceColumns } from "./columns";
import { KnativeSection } from "./details";
import { CONFIGURATION, DOMAIN_MAPPING, isProblem, KNATIVE_KINDS, knativeKind, KSERVICE, REVISION, ROUTE, sameKind, type KnativeKind } from "./model";

const ICONS: Record<string, IconName> = {
  services: "service",
  configurations: "config",
  revisions: "knativeRevision",
  routes: "knativeRoute",
  domainMappings: "knativeDomain",
};

function columnsOf({ kind }: KnativeKind): ColumnDef[] {
  if (sameKind(kind, KSERVICE)) return serviceColumns;
  if (sameKind(kind, CONFIGURATION)) return configurationColumns;
  if (sameKind(kind, REVISION)) return revisionColumns;
  if (sameKind(kind, ROUTE)) return routeColumns;
  if (sameKind(kind, DOMAIN_MAPPING)) return domainMappingColumns;
  return [];
}

for (const def of KNATIVE_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "knative", order: def.order, labelKey: `knative:sidebar.${def.label}`, icon: ICONS[def.label] },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: true,
    problem: isProblem,
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "knative", order: 20, appliesTo: (kind) => knativeKind(kind) !== undefined, Component: KnativeSection });
