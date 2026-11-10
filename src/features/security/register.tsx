// Registers the "Security" section of workload and Pod details and the "Security" page of the Cluster section. The
// Trivy Operator report kinds' sidebar section and details are Sextant's own extension `extensions/trivy`
// (`sextant.trivy`, ADR-0162 amendment); the page still reads the reports' summary counts itself.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { SecurityPage, SECURITY_PAGE_ID } from "./SecurityPage";
import { securityApplies, SecuritySection } from "./SecuritySection";

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
