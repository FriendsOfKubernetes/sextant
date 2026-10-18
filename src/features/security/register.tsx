// Registers the Trivy Operator report kinds in the sidebar section `trivy` (shown only for kinds the cluster serves)
// with their details, the "Security" section of workload and Pod details, and the "Security" page of the Cluster
// section. Read-only: the report kinds offer the generic Edit and Delete only (the operator writes and rescans them).
import type { IconName } from "../../components";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { registerResource } from "../../resources";
import { trivyColumns } from "./columns";
import { SecurityPage, SECURITY_PAGE_ID } from "./SecurityPage";
import { securityApplies, SecuritySection } from "./SecuritySection";
import { TRIVY_KINDS, trivyKind, type ReportShape } from "./trivy";
import { TrivyReportSection } from "./TrivySection";

const ICONS: Record<ReportShape | "rbac" | "infra", IconName> = {
  vulnerabilities: "trivyVulnerabilities",
  checks: "trivyConfigAudit",
  secrets: "trivySecrets",
  compliance: "trivyCompliance",
  sbom: "trivySbom",
  rbac: "trivyRbac",
  infra: "trivyInfra",
};

function iconOf(label: string, shape: ReportShape): IconName {
  if (label.toLowerCase().includes("rbac")) return ICONS.rbac;
  if (label.toLowerCase().includes("infra")) return ICONS.infra;
  return ICONS[shape];
}

for (const def of TRIVY_KINDS) {
  registerResource({
    kind: def.kind,
    sidebar: { section: "trivy", order: def.order, labelKey: `security:trivy.sidebar.${def.label}`, icon: iconOf(def.label, def.shape) },
    columns: trivyColumns(def),
    actions: ["edit", "delete"],
    namespaced: def.namespaced,
  });
}

// In place of the generic fields (20), before the conditions (30).
registerDetailsSection({ id: "trivyReport", order: 20, appliesTo: (kind) => trivyKind(kind) !== undefined, Component: TrivyReportSection });

// After the right-sizing (55).
registerDetailsSection({ id: "security", order: 57, appliesTo: securityApplies, Component: SecuritySection });

// The Cluster section, after the overview (0), the problems (10) and the map (20): a posture of the whole cluster
// across namespaces, like the problems screen it feeds; Access Control holds the RBAC objects (who may do what), not
// what pods may do.
registerPage({
  id: SECURITY_PAGE_ID,
  section: "cluster",
  order: 30,
  labelKey: "security:sidebar",
  icon: "securityPosture",
  Component: SecurityPage,
});
