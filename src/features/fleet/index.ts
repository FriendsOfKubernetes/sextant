// Overview of several clusters (#144): "All clusters" at the top of the cluster rail opens a window-wide page (the
// "home" slot, `useAppStore().homeView`) with a health card per chosen cluster, tables of pods, workloads and Warning
// events across them and "Find by name" in all of them. Read-only; connects a cluster only on the user's click.
import { registerSlot } from "../../layout/slots";
import { FleetHome } from "./FleetPage";
import { FleetRailButton } from "./RailButton";
import { followClusterChoice } from "./store";

registerSlot("home", FleetHome);
// Before the cluster list (order 0).
registerSlot("clusterRail", FleetRailButton, -1);
followClusterChoice();

export { FLEET_VIEW } from "./constants";
export { FleetPage } from "./FleetPage";
export { openFleet } from "./store";
