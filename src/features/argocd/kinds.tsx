// The Argo CD kinds in the sidebar's Argo CD section: their columns, the fields of their details and their actions.
// The section shows a kind only when the cluster serves it (discovery), so it is absent without Argo CD.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { column, registerResource, standardColumns, status, StatusText, type ColumnDef } from "../../resources";
import { ApplicationDetails, ApplicationSetDetails, AppProjectDetails } from "./details";
import {
  APP_PROJECT,
  APPLICATION,
  APPLICATION_SET,
  applicationDestination,
  destinationText,
  generatedCount,
  healthStatus,
  healthTone,
  operationRunning,
  projectDestinations,
  projectSources,
  revisions,
  shortRevision,
  syncStatus,
  syncTone,
} from "./model";

const { get, str } = status;

/** A column with an i18n header `argocd:columns.<id>`. */
function argoColumn(id: string, value: ColumnDef["value"], options: Partial<Omit<ColumnDef, "id" | "value">> = {}) {
  return { ...column(id, value, options), titleKey: `argocd:columns.${id}` };
}

function SyncCell({ app }: { app: KubeObject }) {
  const { t } = useTranslation();
  const value = syncStatus(app);
  return (
    <span className="rt-status-list">
      {value && <StatusText value={value} tone={syncTone(value)} />}
      {operationRunning(app) && <StatusText value={t("argocd:status.syncing")} tone="warning" />}
    </span>
  );
}

const applicationColumns: ColumnDef[] = standardColumns(
  true,
  argoColumn("project", (o) => str(get(o, "spec", "project")), { width: "minmax(90px, 1fr)" }),
  argoColumn("sync", syncStatus, { width: "minmax(100px, 1fr)", render: (o) => <SyncCell app={o} /> }),
  argoColumn("health", healthStatus, {
    width: "110px",
    render: (o) => {
      const value = healthStatus(o);
      return value ? <StatusText value={value} tone={healthTone(value)} /> : null;
    },
  }),
  argoColumn("revision", (o) => revisions(o).map(shortRevision).join(", "), { width: "minmax(80px, 1fr)" }),
  argoColumn("destination", (o) => destinationText(applicationDestination(o)), { width: "minmax(140px, 2fr)" }),
);

const applicationSetColumns: ColumnDef[] = standardColumns(
  true,
  argoColumn("applications", generatedCount, { width: "110px" }),
);

const appProjectColumns: ColumnDef[] = standardColumns(
  true,
  argoColumn("destinations", (o) => projectDestinations(o).map(destinationText).join(", "), {
    width: "minmax(160px, 2fr)",
  }),
  argoColumn("sources", (o) => projectSources(o).join(", "), { width: "minmax(160px, 2fr)" }),
);

registerResource({
  kind: APPLICATION,
  sidebar: { section: "argocd", order: 10, labelKey: "argocd:sidebar.applications" },
  columns: applicationColumns,
  details: ApplicationDetails,
  actions: ["argoSync", "argoRefresh", "argoHardRefresh", "argoTerminate", "argoDiff", "argoOpenUi", "edit", "delete"],
});

registerResource({
  kind: APPLICATION_SET,
  sidebar: { section: "argocd", order: 20, labelKey: "argocd:sidebar.applicationSets" },
  columns: applicationSetColumns,
  details: ApplicationSetDetails,
  actions: ["argoOpenUi", "edit", "delete"],
});

registerResource({
  kind: APP_PROJECT,
  sidebar: { section: "argocd", order: 30, labelKey: "argocd:sidebar.appProjects" },
  columns: appProjectColumns,
  details: AppProjectDetails,
  actions: ["argoOpenUi", "edit", "delete"],
});
