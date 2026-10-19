// Comparing objects across clusters and namespaces (#156), read-only. "Compare with…" on every object (offered for
// every kind through `extendActionsForAll`) compares it with the same or another object of its kind in a connected
// cluster and namespace, with its last-applied configuration, or with its Helm release's manifest (and the whole
// release's drift). The "Compare namespaces" page compares two namespaces kind by kind. Secrets are compared by key
// names and value hashes in the backend; a value is shown only after "Show values", through `secret_value`. A cluster
// that is not connected is never connected implicitly: only the "Connect" button does it. Agents and extensions get
// nothing new.
//
// The page is in the Cluster section, next to "Cleanup" and "Upgrade readiness": like them it is a tool across kinds
// rather than a list of one kind, and it may look at another cluster too, so no resource section fits it.
import { registerAction } from "../actions/registry";
import { registerPage } from "../../layout/pages";
import { extendActionsForAll } from "../../resources/registry";
import { compareDialog } from "./CompareDialog";
import { COMPARE_PAGE_ID, NamespaceComparePage } from "./NamespaceComparePage";
import "./compare.css";

registerAction("compareWith", {
  labelKey: "compare:action",
  icon: "diff",
  appliesTo: (obj) => Boolean(obj.metadata?.name),
  run: ({ clusterId, kind, objects, openDialog }) => {
    const object = objects[0];
    if (object) openDialog(compareDialog(clusterId, kind, object));
  },
});
extendActionsForAll(["compareWith"]);

// After the overview (0), the problems (10), the map (20), the security posture (30) and the cleanup (45).
registerPage({
  id: COMPARE_PAGE_ID,
  section: "cluster",
  order: 47,
  labelKey: "compare:sidebar",
  icon: "diff",
  Component: NamespaceComparePage,
});

export { CompareDialog } from "./CompareDialog";
export { NamespaceComparePage, COMPARE_PAGE_ID } from "./NamespaceComparePage";
