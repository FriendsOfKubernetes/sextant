// Clusters from the kubeconfig, their connection states and the cluster the user is connecting to.
// The window-wide UI state (active cluster, per-cluster view) stays in src/app/store.
import { create } from "zustand";
import {
  api,
  events,
  loadSettings,
  toApiError,
  type ApiError,
  type ClusterId,
  type ClusterInfo,
  type ConnectionState,
  type KubeconfigSource,
  type Unsubscribe,
} from "../../api";
import { useAppStore } from "../../app/store";
import { refreshClusterKinds } from "../../resources/useKinds";
import { startViewPersistence } from "./viewPersistence";

export interface ClustersState {
  /** The first list was loaded (successfully or not). */
  loaded: boolean;
  loading: boolean;
  clusters: ClusterInfo[];
  /** Every kubeconfig source, the checked default paths first. */
  sources: KubeconfigSource[];
  /** Reading the kubeconfig failed and no cluster could be listed. */
  listError: ApiError | null;
  states: Record<ClusterId, ConnectionState>;
  /** The cluster the user picked that is not connected yet; the welcome area shows its progress or error. */
  pendingId: ClusterId | null;
  /** Cluster whose settings dialog is open. */
  settingsFor: ClusterId | null;
  /** What the settings dialog puts the focus on when it opens ("Change icon…" — the icon). */
  settingsFocus: "icon" | null;
}

const initialState = (): ClustersState => ({
  loaded: false,
  loading: false,
  clusters: [],
  sources: [],
  listError: null,
  states: {},
  pendingId: null,
  settingsFor: null,
  settingsFocus: null,
});

export const useClustersStore = create<ClustersState>()(initialState);

const DISCONNECTED: ConnectionState = { state: "disconnected" };

export function stateOf(id: ClusterId): ConnectionState {
  return useClustersStore.getState().states[id] ?? DISCONNECTED;
}

function setClusterState(id: ClusterId, state: ConnectionState): void {
  const was = useClustersStore.getState().states[id]?.state;
  useClustersStore.setState((s) => ({ states: { ...s.states, [id]: state } }));
  // A new connection may serve other kinds (a CRD created since the last one): discovery is read again.
  if (state.state === "connected" && was !== "connected") refreshClusterKinds(id);
}

/** Re-reads the kubeconfig files ("Refresh"). */
export async function refreshClusters(): Promise<void> {
  useClustersStore.setState({ loading: true });
  const [list, sources] = await Promise.allSettled([api.clusters.list(), api.clusters.sources()]);
  useClustersStore.setState((s) => ({
    loaded: true,
    loading: false,
    clusters: list.status === "fulfilled" ? list.value : [],
    listError: list.status === "rejected" ? toApiError(list.reason) : null,
    sources: sources.status === "fulfilled" ? sources.value : s.sources,
  }));
}

let initialized: Promise<void> | null = null;
let teardown: Unsubscribe[] = [];

/**
 * Loads the clusters once, follows `cluster-state` events and reopens the last active cluster
 * (`settings.window.lastCluster`). Safe to call from every component that needs the list.
 */
export function initClusters(): Promise<void> {
  initialized ??= (async () => {
    teardown.push(startViewPersistence());
    const unlisten = events.onClusterState(({ clusterId, state }) => onStateEvent(clusterId, state));
    teardown.push(() => void unlisten.then((fn) => fn()));
    await refreshClusters();

    // The backend may already hold connections (e.g. the window was reloaded).
    const { clusters } = useClustersStore.getState();
    await Promise.all(
      clusters.map(async (c) => {
        try {
          const state = await api.clusters.state(c.id);
          if (!useClustersStore.getState().states[c.id]) setClusterState(c.id, state);
        } catch {
          // Unknown state = disconnected.
        }
      }),
    );

    const settings = await loadSettings().catch(() => null);
    const last = settings?.window.lastCluster;
    if (last && useAppStore.getState().activeClusterId === null && clusters.some((c) => c.id === last)) {
      selectCluster(last);
    }
  })();
  return initialized;
}

function onStateEvent(id: ClusterId, state: ConnectionState): void {
  setClusterState(id, state);
  if (state.state === "connected" && useClustersStore.getState().pendingId === id) void activate(id);
}

/** Opens a cluster: switches to it when connected, otherwise connects and shows the progress. */
export function selectCluster(id: ClusterId): void {
  const state = stateOf(id).state;
  if (state === "connected") {
    void activate(id);
    return;
  }
  useClustersStore.setState({ pendingId: id });
  useAppStore.getState().setActiveCluster(null);
  if (state !== "connecting") void connectCluster(id);
}

/** Connects (or reconnects) a cluster. */
export async function connectCluster(id: ClusterId): Promise<void> {
  setClusterState(id, { state: "connecting" });
  try {
    await api.clusters.connect(id);
    setClusterState(id, { state: "connected" });
    if (useClustersStore.getState().pendingId === id) await activate(id);
  } catch (err) {
    const error = toApiError(err);
    setClusterState(id, { state: "error", ...error.toCoreError() });
    // A failed reconnect of the open cluster shows the error instead of a broken view.
    if (useAppStore.getState().activeClusterId === id) {
      useClustersStore.setState({ pendingId: id });
      useAppStore.getState().setActiveCluster(null);
    }
  }
}

export async function disconnectCluster(id: ClusterId): Promise<void> {
  try {
    await api.clusters.disconnect(id);
  } finally {
    setClusterState(id, DISCONNECTED);
    if (useClustersStore.getState().pendingId === id) useClustersStore.setState({ pendingId: null });
    if (useAppStore.getState().activeClusterId === id) useAppStore.getState().setActiveCluster(null);
  }
}

/** Bumped by every choice of where the window goes; an activation that waited and is no longer the latest gives up. */
let choiceSeq = 0;

/**
 * A later choice of the user (the overview of several clusters, say) wins over a cluster still being activated:
 * that activation, waiting for the settings, then does nothing.
 */
export function supersedeActivation(): void {
  choiceSeq++;
}

/** Makes a connected cluster the active one, reopening its last section when it was not opened yet. */
async function activate(id: ClusterId): Promise<void> {
  const seq = ++choiceSeq;
  useClustersStore.setState({ pendingId: null });
  const app = useAppStore.getState();
  if (!app.clusterViews[id]?.view) {
    const settings = await loadSettings().catch(() => null);
    if (seq !== choiceSeq) return;
    const lastView = settings?.clusters[id]?.lastView;
    if (lastView && !useAppStore.getState().clusterViews[id]?.view) app.setView(id, lastView);
  }
  if (seq !== choiceSeq) return;
  useAppStore.getState().setActiveCluster(id);
}

export async function addKubeconfigFile(path: string): Promise<KubeconfigSource> {
  const source = await api.clusters.addFile(path);
  await refreshClusters();
  return source;
}

export async function addPastedKubeconfig(text: string): Promise<KubeconfigSource> {
  const source = await api.clusters.addPasted(text);
  await refreshClusters();
  return source;
}

export async function removeKubeconfigSource(sourceId: string): Promise<void> {
  const gone = useClustersStore.getState().clusters.filter((c) => c.sourceId === sourceId).map((c) => c.id);
  await api.clusters.removeSource(sourceId);
  for (const id of gone) {
    setClusterState(id, DISCONNECTED);
    if (useAppStore.getState().activeClusterId === id) useAppStore.getState().setActiveCluster(null);
    if (useClustersStore.getState().pendingId === id) useClustersStore.setState({ pendingId: null });
  }
  await refreshClusters();
}

export function openClusterSettings(id: ClusterId | null, focus: "icon" | null = null): void {
  useClustersStore.setState({ settingsFor: id, settingsFocus: id ? focus : null });
}

/** Forgets everything (tests). */
export function resetClustersStore(): void {
  for (const fn of teardown) fn();
  teardown = [];
  initialized = null;
  useClustersStore.setState(initialState(), true);
}
