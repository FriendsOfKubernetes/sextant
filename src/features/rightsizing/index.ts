// Right-sizing (#137): requests and limits against real usage, with a recommendation per container. The page sits in
// the Workloads section — it is about the pod templates of Deployments, StatefulSets and DaemonSets, follows the
// namespace filter like the workload lists do, and opens their details — and the same rows show as a section of
// their details. History comes from Prometheus (`metrics_usage_history`), a snapshot from metrics-server; nothing is
// changed in the cluster.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { RightsizingDetailsSection, rightsizingApplies } from "./DetailsSection";
import { RIGHTSIZING_PAGE_ID, RightsizingPage } from "./RightsizingPage";

registerPage({
  id: RIGHTSIZING_PAGE_ID,
  section: "workloads",
  // After the kinds of the section (CronJobs are 70).
  order: 80,
  labelKey: "rightsizing:sidebar",
  icon: "scale",
  Component: RightsizingPage,
});

// Right after the metrics (50).
registerDetailsSection({ id: "rightsizing", order: 55, appliesTo: rightsizingApplies, Component: RightsizingDetailsSection });

export { assess, recommend } from "./recommend";
export { RIGHTSIZING_PAGE_ID } from "./RightsizingPage";
