// Opening and leaving the overview of several clusters, the clusters it shows (`settings.fleet.selected`, written by
// the frontend, at most `MAX_SELECTED`), connecting them on the user's click (at most `CONNECT_CONCURRENCY` at a time)
// and opening an object of one of them in the main view.
import { useMemo } from "react";
import { create } from "zustand";
import { updateSettings, useSettings, type ClusterId, type ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { viewIdOf } from "../../resources";
import { connectCluster, stateOf, supersedeActivation, useClustersStore } from "../clusters/clustersStore";
import { openTarget } from "../notifications/notifier";
import { CONNECT_CONCURRENCY, FLEET_VIEW, MAX_SELECTED } from "./constants";

/** Shows the overview in the main area (the active cluster steps back; its connection stays). */
export function openFleet(): void {
  // The latest choice wins: a cluster still being activated (waiting for the settings) no longer takes the window.
  supersedeActivation();
  // A cluster being connected for the welcome area keeps connecting, but no longer takes the window when it is done.
  if (useClustersStore.getState().pendingId !== null) useClustersStore.setState({ pendingId: null });
  useAppStore.getState().setHomeView(FLEET_VIEW);
}

/** The rail's "All clusters": opens the overview, or, when it is open, goes back to the welcome area. */
export function toggleFleet(): void {
  const app = useAppStore.getState();
  if (app.homeView === FLEET_VIEW && app.activeClusterId === null) app.setHomeView(null);
  else openFleet();
}

let following = false;

/**
 * Leaves the overview when a cluster is opened (from the rail, the palette, a notification) or picked to be
 * connected in the welcome area: the cluster takes the main area, and the overview's watches close.
 */
export function followClusterChoice(): () => void {
  if (following) return () => undefined;
  following = true;
  const leave = () => {
    if (useAppStore.getState().homeView === FLEET_VIEW) useAppStore.getState().setHomeView(null);
  };
  const unApp = useAppStore.subscribe((s) => {
    if (s.activeClusterId !== null && s.homeView === FLEET_VIEW) leave();
  });
  const unClusters = useClustersStore.subscribe((s, prev) => {
    if (s.pendingId !== null && s.pendingId !== prev.pendingId) leave();
  });
  return () => {
    following = false;
    unApp();
    unClusters();
  };
}

/** The chosen clusters that the kubeconfig still has, in the order they were chosen (at most `MAX_SELECTED`). */
export function useFleetSelection(): ClusterId[] {
  const { settings } = useSettings();
  const clusters = useClustersStore((s) => s.clusters);
  const selected = settings?.fleet?.selected;
  return useMemo(() => {
    const known = new Set(clusters.map((c) => c.id));
    return (selected ?? []).filter((id) => known.has(id)).slice(0, MAX_SELECTED);
  }, [clusters, selected]);
}

/**
 * Adds the cluster to the overview or takes it out. Adding one beyond `MAX_SELECTED` (of the clusters the kubeconfig
 * still has, `known`) changes nothing.
 */
export function setFleetSelected(clusterId: ClusterId, on: boolean, known?: ReadonlySet<ClusterId>): Promise<unknown> {
  return updateSettings((current) => {
    const selected = (current.fleet?.selected ?? []).filter((id) => id !== clusterId && (!known || known.has(id)));
    if (on) {
      if (selected.length >= MAX_SELECTED) return current;
      selected.push(clusterId);
    }
    return { ...current, fleet: { ...current.fleet, selected } };
  });
}

// ---------- Connecting on the user's click, a few at a time ----------

interface ConnectQueue {
  /** Clusters waiting for their turn, in order. */
  waiting: ClusterId[];
  /** Clusters being connected by the queue. */
  running: ClusterId[];
}

export const useConnectQueue = create<ConnectQueue>(() => ({ waiting: [], running: [] }));

function pumpQueue(): void {
  const { waiting, running } = useConnectQueue.getState();
  if (running.length >= CONNECT_CONCURRENCY || waiting.length === 0) return;
  const [next, ...rest] = waiting as [ClusterId, ...ClusterId[]];
  useConnectQueue.setState({ waiting: rest, running: [...running, next] });
  const state = stateOf(next).state;
  const done = () => {
    useConnectQueue.setState((s) => ({ running: s.running.filter((id) => id !== next) }));
    pumpQueue();
  };
  if (state === "disconnected" || state === "error") void connectCluster(next).finally(done);
  else done();
  pumpQueue();
}

/**
 * Connects the chosen clusters that are not connected (nor connecting), at most `CONNECT_CONCURRENCY` at a time, so
 * a dozen exec plugins or cloud sign-ins do not start at once. Only ever on the user's click.
 */
export function connectSelected(clusterIds: readonly ClusterId[]): void {
  const { waiting, running } = useConnectQueue.getState();
  const queued = new Set([...waiting, ...running]);
  const add = clusterIds.filter((id) => {
    const state = stateOf(id).state;
    return !queued.has(id) && (state === "disconnected" || state === "error");
  });
  if (add.length === 0) return;
  useConnectQueue.setState({ waiting: [...waiting, ...add] });
  pumpQueue();
}

/** Takes a cluster off the queue (it left the selection). */
export function dequeue(clusterId: ClusterId): void {
  useConnectQueue.setState((s) => ({ waiting: s.waiting.filter((id) => id !== clusterId) }));
}

/** Forgets the queue (tests). */
export function resetConnectQueue(): void {
  useConnectQueue.setState({ waiting: [], running: [] }, true);
}

/** Opens the object's details in its cluster, over the table of its kind. */
export function openInCluster(clusterId: ClusterId, object: ObjectRef): void {
  supersedeActivation();
  const app = useAppStore.getState();
  const view = viewIdOf(object.kind);
  if ((app.clusterViews[clusterId]?.view ?? null) !== view) {
    app.setSearch(clusterId, "");
    app.setView(clusterId, view);
  }
  openTarget(clusterId, object);
}
