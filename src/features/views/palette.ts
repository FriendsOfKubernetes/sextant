// Saved views and pins in the command palette: with a cluster open, its favourites and its views (its own and those
// for every cluster); with none, the views and pins of the clusters the workspace shows.
import type { TFunction } from "i18next";
import type { AppSettings, ClusterId, ClusterInfo } from "../../api";
import { useAppStore } from "../../app/store";
import { formatParts } from "../../i18n/format";
import { displayNameOf } from "../clusters/clusterSettings";
import type { NavigationInput, PaletteGroup, PaletteItem } from "../palette/items";
import { inWorkspace, pinsFor, type Pin, type SavedView } from "./model";
import { pinIcon } from "./SidebarViews";
import { openPin, openSavedView } from "./ui";

function clusterLabel(t: TFunction, clusters: ClusterInfo[], settings: AppSettings, id: ClusterId | null): string {
  if (id === null) return t("views:palette.allClusters");
  const cluster = clusters.find((c) => c.id === id);
  return cluster ? displayNameOf(cluster, settings) : id;
}

export function viewGroups({ t, clusterId, clusters, settings }: NavigationInput): PaletteGroup[] {
  if (!settings) return [];
  const active = useAppStore.getState().activeClusterId;
  const known = new Set(clusters.map((c) => c.id));
  const views: PaletteItem[] = [];
  for (const view of settings.views) {
    // Where the view opens: the open cluster, or its own cluster.
    const target: ClusterId | null = clusterId
      ? view.cluster === null || view.cluster === clusterId
        ? clusterId
        : null
      : view.cluster;
    if (!target || !known.has(target) || !inWorkspace(settings, target, active)) continue;
    views.push(viewItem(t, view, target, clusterLabel(t, clusters, settings, view.cluster)));
  }
  const pins: PaletteItem[] = [];
  const pinClusters = clusterId ? [clusterId] : clusters.map((c) => c.id).filter((id) => inWorkspace(settings, id, active));
  for (const id of pinClusters) {
    for (const pin of pinsFor(settings, id)) pins.push(pinItem(t, pin, settings, clusterLabel(t, clusters, settings, id)));
  }
  return [
    { id: "favourites", label: t("views:palette.favourites"), items: pins },
    { id: "views", label: t("views:palette.views"), items: views },
  ];
}

function viewItem(t: TFunction, view: SavedView, clusterId: ClusterId, detail: string): PaletteItem {
  const key = `view:${clusterId}:${view.id}`;
  return {
    key,
    label: view.name,
    detail: detail || t("views:palette.thisCluster"),
    icon: "savedView",
    run: () => openSavedView(clusterId, view),
    recent: { key },
    score: 0,
  };
}

function pinItem(t: TFunction, pin: Pin, settings: AppSettings, detail: string): PaletteItem {
  const key = `pin:${pin.id}`;
  const target = pin.target;
  const label =
    target.type === "view"
      ? (settings.views.find((v) => v.id === target.view)?.name ?? target.view)
      : target.name;
  const icon = pinIcon(pin);
  return {
    key,
    label,
    detail:
      target.type === "object"
        ? formatParts([target.kind, ...(target.namespace ? [target.namespace] : []), detail])
        : detail || t("views:palette.thisCluster"),
    icon,
    run: () => openPin(pin, settings.views),
    recent: { key },
    score: 0,
  };
}
