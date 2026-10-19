// Cost (#153): costs from OpenCost or Kubecost's compatible allocation API, when one of them runs in the cluster —
// per namespace, workload, Pod, node or label value over 24 hours, 7 or 30 days, split by resource, with the idle
// cost; and in a workload's details a monthly estimate and the estimated savings of its right-sizing
// recommendation. Read-only: the backend (`cost_allocation`) finds the cost service and reads it through the API
// server's service proxy with the user's own credentials; nothing is installed or stored, and agents and
// extensions get nothing new.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { COST_PAGE_ID, CostPage } from "./CostPage";
import { CostDetailsSection, costApplies } from "./DetailsSection";

// After the overview (0), the problems (10), the timeline (15), the map (20), the security posture (30) and the
// cleanup (45).
registerPage({
  id: COST_PAGE_ID,
  section: "cluster",
  order: 50,
  labelKey: "cost:sidebar",
  icon: "cost",
  Component: CostPage,
});

// Right after the right-sizing section (55).
registerDetailsSection({ id: "cost", order: 56, appliesTo: costApplies, Component: CostDetailsSection });

export { COST_PAGE_ID } from "./CostPage";
