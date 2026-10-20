// Registers the External Secrets kinds in the sidebar section `externalSecrets` (shown only for kinds the cluster
// serves) and their details. Read-only: the kinds offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { clusterExternalSecretColumns, externalSecretColumns, pushSecretColumns, storeColumns } from "./columns";
import { appliesTo, ExternalSecretsSection } from "./details";
import {
  CLUSTER_EXTERNAL_SECRET,
  CLUSTER_SECRET_STORE,
  ESO_KINDS,
  EXTERNAL_SECRET,
  isKind,
  isProblem,
  PUSH_SECRET,
  SECRET_STORE,
  type EsoKind,
} from "./model";

const ICONS: Record<string, IconName> = {
  externalSecrets: "externalSecret",
  clusterExternalSecrets: "externalSecret",
  secretStores: "secretStore",
  clusterSecretStores: "secretStore",
  pushSecrets: "pushSecret",
};

function columnsOf({ kind, namespaced }: EsoKind): ColumnDef[] {
  if (isKind(kind, EXTERNAL_SECRET)) return externalSecretColumns;
  if (isKind(kind, CLUSTER_EXTERNAL_SECRET)) return clusterExternalSecretColumns;
  if (isKind(kind, SECRET_STORE, CLUSTER_SECRET_STORE)) return storeColumns(namespaced);
  if (isKind(kind, PUSH_SECRET)) return pushSecretColumns;
  return [];
}

for (const def of ESO_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: {
      section: "externalSecrets",
      order: def.order,
      labelKey: `externalsecrets:sidebar.${def.label}`,
      icon: ICONS[def.label],
    },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
    problem: isProblem,
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({
  id: "externalSecrets",
  order: 20,
  appliesTo,
  Component: ExternalSecretsSection,
});
