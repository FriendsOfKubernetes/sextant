// Operator Lifecycle Manager (#268): the discovered sidebar section "Operators (OLM)" — Subscriptions,
// ClusterServiceVersions, InstallPlans, CatalogSources, OperatorGroups, Operators and, where OLM v1 is installed,
// ClusterExtensions and ClusterCatalogs. A Subscription's details tell its channel, approval, installed and current CSV
// ("upgrade pending" when they differ) and its InstallPlan; a CSV's its phase, requirements, CRDs, Deployments and
// install modes, a copy in a target namespace saying it is one; an InstallPlan's its approval and steps; a
// CatalogSource's its connection state. Failed CSVs (originals only), failed or stuck InstallPlans, failed resolutions
// and catalogs not READY feed the problems screen (category `olm`) and the section counter. Read-only (ADR-0121).
import { registerSectionBadge } from "../../layout/sectionBadges";
import { useOlmProblemCount } from "./badge";
import "./olm.css";
import "./provider";
import "./register";

registerSectionBadge("olm", useOlmProblemCount, { tone: "danger", labelKey: "olm:badge" });

export * from "./model";
