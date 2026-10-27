// vcluster (#269, ADR-0122): the page "Virtual clusters" (Cluster section) lists the vcluster instances of the host
// cluster — control planes found by `app=vcluster` — with their state, pods, Service and kubeconfig Secret (metadata
// only); the "vcluster" section of a control plane's StatefulSet or Deployment adds the objects the syncer copied from
// the virtual cluster. "Connect" (a click and a confirmation) has the backend read the Secret, forward a local port
// through the host cluster and add the virtual cluster to the cluster list as Sextant's own `vcluster.yaml`; the entry
// lives as long as the forward. Nothing else writes anything; agents and extensions get nothing new.
import { useEffect } from "react";
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { registerSlot } from "../../layout/slots";
import { VclusterSection, vclusterApplies } from "./details";
import { followLinks } from "./links";
import { VCLUSTER_PAGE_ID, VclusterPage } from "./VclusterPage";
import "./vcluster.css";

// After the cost page (50).
registerPage({
  id: VCLUSTER_PAGE_ID,
  section: "cluster",
  order: 55,
  labelKey: "vcluster:sidebar",
  icon: "cluster",
  Component: VclusterPage,
});

// After the conditions (30).
registerDetailsSection({ id: "vcluster", order: 33, appliesTo: vclusterApplies, Component: VclusterSection });

/** Follows the backend's list of forwarded virtual clusters for the whole window (draws nothing). */
function VclusterLinksHost() {
  useEffect(() => followLinks(), []);
  return null;
}

registerSlot("railFooter", VclusterLinksHost, 1003);

export { VCLUSTER_PAGE_ID } from "./VclusterPage";
export * from "./model";
