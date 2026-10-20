// Registers the CloudNativePG kinds in the sidebar section `cnpg` (shown only for kinds the cluster serves) and their
// details. Read-only: the kinds offer the generic Edit and Delete only.
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerResource, type ColumnDef } from "../../resources";
import { backupColumns, clusterColumns, poolerColumns, scheduledBackupColumns } from "./columns";
import { appliesTo, CnpgSection } from "./details";
import { BACKUP, CNPG_KINDS, isKind, isProblem, PG_CLUSTER, POOLER, SCHEDULED_BACKUP, type CnpgKind } from "./model";

const ICONS: Record<string, IconName> = {
  clusters: "postgresCluster",
  backups: "postgresBackup",
  scheduledBackups: "postgresScheduledBackup",
  poolers: "postgresPooler",
};

function columnsOf({ kind }: CnpgKind): ColumnDef[] {
  if (isKind(kind, PG_CLUSTER)) return clusterColumns;
  if (isKind(kind, BACKUP)) return backupColumns;
  if (isKind(kind, SCHEDULED_BACKUP)) return scheduledBackupColumns;
  if (isKind(kind, POOLER)) return poolerColumns;
  return [];
}

for (const def of CNPG_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: {
      section: "cnpg",
      order: def.order,
      labelKey: `cnpg:sidebar.${def.label}`,
      icon: ICONS[def.label],
    },
    columns: columnsOf(def),
    actions: ["edit", "delete"],
    namespaced: true,
    problem: (obj) => isProblem(obj, def.kind),
  });
}

registerDetailsSection({
  id: "cnpg",
  order: 20,
  appliesTo,
  Component: CnpgSection,
});
