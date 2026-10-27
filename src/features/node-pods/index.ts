// The pods of a node in its details (#279, #280): the tab "Pods" — every pod on the node in a full resource table —
// and the tab "Resources" — "Allocated resources" as in `kubectl describe node` and each pod's requests, limits and
// usage. Read-only and frontend-only: one watch of the node's pods by `spec.nodeName` (shared by both tabs and the
// "Related" tab), the metrics feature's usage polls.
import { registerDetailsSection } from "../../layout/details/registry";
import { NodePodsTab } from "./PodsTab";
import { NodeResourcesTab } from "./ResourcesTab";

const isNode = (kind: { group: string; kind: string }) => kind.group === "" && kind.kind === "Node";

// Right after "Overview", before the tabs every kind has ("Changes", "Related").
registerDetailsSection({
  id: "nodePods",
  order: 5,
  placement: "tab",
  labelKey: "nodepods:pods.tab",
  appliesTo: isNode,
  Component: NodePodsTab,
});

registerDetailsSection({
  id: "nodeResources",
  order: 6,
  placement: "tab",
  labelKey: "nodepods:resources.tab",
  appliesTo: isNode,
  Component: NodeResourcesTab,
});

export { allocatedResources, isTerminated, nodePodsSpec } from "./model";
