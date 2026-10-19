// Window state of the views feature: whether the manager dialog is open and on which tab; opening a view or a pin.
import { create } from "zustand";
import { updateSettings, type ClusterId } from "../../api";
import { useAppStore } from "../../app/store";
import { selectCluster } from "../clusters/clustersStore";
import { applyView, refOfPin, type Pin, type SavedView } from "./model";

export type ManagerTab = "views" | "workspaces" | "transfer";

interface ViewsUi {
  manager: ManagerTab | null;
}

export const useViewsUi = create<ViewsUi>()(() => ({ manager: null }));

export function openManager(tab: ManagerTab = "views"): void {
  useViewsUi.setState({ manager: tab });
}

export function closeManager(): void {
  useViewsUi.setState({ manager: null });
}

/** Shows `clusterId` (connecting it if needed, as its rail icon does) with `view` open. */
export function openSavedView(clusterId: ClusterId, view: SavedView): void {
  if (useAppStore.getState().activeClusterId !== clusterId) selectCluster(clusterId);
  void applyView(clusterId, view).catch(() => {
    // The namespace filter is shown anyway; saving it is retried by the next change.
  });
}

/** Opens a pin: a view, or the object's details in its cluster. */
export function openPin(pin: Pin, views: readonly SavedView[]): void {
  if (pin.target.type === "view") {
    const viewId = pin.target.view;
    const view = views.find((v) => v.id === viewId);
    if (view) openSavedView(pin.cluster, view);
    return;
  }
  const ref = refOfPin(pin);
  if (!ref) return;
  if (useAppStore.getState().activeClusterId !== pin.cluster) selectCluster(pin.cluster);
  useAppStore.getState().openDetails(ref);
}

/** Saves a settings change of this feature; a failure is reported by the settings status, not here. */
export function save(change: Parameters<typeof updateSettings>[0]): void {
  void updateSettings(change).catch(() => undefined);
}
