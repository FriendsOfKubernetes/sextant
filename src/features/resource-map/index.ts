// Resource map (#139): how objects relate — owners, label selectors (Service, PDB, NetworkPolicy), EndpointSlices,
// Ingresses and Gateway API routes → Services, pods → ConfigMaps / Secrets / ServiceAccounts / claims / nodes,
// PVC → PV → StorageClass, HPA → target — to answer "what uses this" and "what breaks if I delete it". Read-only and
// frontend-only: pure relation functions (`relations.ts`, `selectors.ts`, `impact.ts`) over bounded, shared watches
// (`data.ts`, `watches.ts`).
//
// Registered here:
//  - the details tab "Related" for every kind: the impact of a deletion in plain words and the relations one hop
//    both ways, expandable hop by hop;
//  - the page "Map" in the sidebar section "Cluster" (after the overview and the problems): it is a view across kinds
//    like those two, not a kind of its own, so no single kind section (Workloads, Network, Config, Storage) fits; and
//    the "Namespaces" section is one link today, which a second entry would turn into a group.
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { MAP_PAGE_ID, MapPage } from "./MapPage";
import { RelatedSection } from "./RelatedTab";
import "./resource-map.css";

registerDetailsSection({
  id: "resourceMapRelated",
  order: 80,
  placement: "tab",
  labelKey: "resourcemap:related.tab",
  appliesTo: () => true,
  Component: RelatedSection,
});

registerPage({
  id: MAP_PAGE_ID,
  section: "cluster",
  order: 20,
  labelKey: "resourcemap:sidebar",
  icon: "network",
  Component: MapPage,
});

export { MAP_PAGE_ID, MapPage } from "./MapPage";
export { RelatedSection } from "./RelatedTab";
