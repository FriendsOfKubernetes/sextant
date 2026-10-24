// Saved views, pins and workspaces (#149): "Save view" in the table header, the favourites and views above the
// sidebar, the workspace switcher in the cluster rail, views and pins in the command palette, "Pin to favourites" on
// every object (the table's row menu, and a toggle next to the name in the details panel, #274), and the manager (rename, reorder, delete; workspaces; export and import).
import type { KindRef, KubeObject } from "../../api";
import { getSettingsSnapshot, updateSettings } from "../../api/settings";
import { useAppStore } from "../../app/store";
import { registerDetailsHeaderTool } from "../../layout/details/registry";
import { registerTableTool } from "../../layout/main/tableTools";
import { registerSlot } from "../../layout/slots";
import { extendActionsForAll } from "../../resources/registry";
import { registerAction } from "../actions/registry";
import { registerNavigationProvider } from "../palette/items";
import { ViewsHost } from "./Manager";
import { isPinned, objectPinOf, togglePin } from "./model";
import { viewGroups } from "./palette";
import { PinToggle } from "./PinToggle";
import { SaveViewTool } from "./SaveView";
import { SidebarViews } from "./SidebarViews";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

registerTableTool("views:save", SaveViewTool);
registerSlot("sidebarTop", SidebarViews);
// Above "All clusters" (order -1) and the cluster list (order 0).
registerSlot("clusterRail", WorkspaceSwitcher, -2);
registerSlot("railFooter", ViewsHost, 1001);
registerNavigationProvider("views", viewGroups);
// After the copy button (order 0) next to the object's name in the details panel (#274).
registerDetailsHeaderTool({ id: "pin", place: "name", order: 10, Component: PinToggle });

/** Whether the object (in the active cluster) is on the favourites strip. */
function pinnedInActiveCluster(obj: KubeObject, kind: KindRef): boolean | null {
  const clusterId = useAppStore.getState().activeClusterId;
  const name = obj.metadata?.name;
  if (!clusterId || !name) return null;
  const pin = objectPinOf(clusterId, { kind, namespace: obj.metadata?.namespace ?? null, name });
  return isPinned(getSettingsSnapshot(), pin);
}

registerAction("pin", {
  placement: "more",
  // The details panel's header has the pin toggle instead (#274); the table's row menu keeps this one.
  inDetails: false,
  labelKey: "views:pin.action",
  icon: "pin",
  appliesTo: (obj, kind) => pinnedInActiveCluster(obj, kind) === false,
  run: ({ clusterId, refs }) => {
    const ref = refs[0];
    if (ref) void updateSettings((s) => togglePin(s, objectPinOf(clusterId, ref))).catch(() => undefined);
  },
});
registerAction("unpin", {
  placement: "more",
  // The details panel's header has the pin toggle instead (#274); the table's row menu keeps this one.
  inDetails: false,
  labelKey: "views:pin.unpinAction",
  icon: "unpin",
  appliesTo: (obj, kind) => pinnedInActiveCluster(obj, kind) === true,
  run: ({ clusterId, refs }) => {
    const ref = refs[0];
    if (ref) void updateSettings((s) => togglePin(s, objectPinOf(clusterId, ref))).catch(() => undefined);
  },
});
extendActionsForAll(["pin", "unpin"]);

export { activeWorkspace, inWorkspace, workspaceClusters } from "./model";
