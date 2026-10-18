import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultAppSettings,
  mockBackend,
  type AppSettings,
  type ClusterInfo,
  type KindRef,
  type KubeObject,
  type MockBackend,
  type ResourceKind,
  type WatchSpec,
} from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { getSlot } from "../../layout/slots";
import "../../resources";
import { resetClusterKinds } from "../../resources/useKinds";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import { resetObjectIndex } from "../palette/objectIndex";
import { resetProblemSources } from "../problems/store";
import { selectCluster } from "../clusters/clustersStore";
import { MAX_SHOWN_ROWS } from "./constants";
import "./index";
import { FLEET_CATEGORIES } from "./ClusterCard";
import { FleetHome, FleetPage } from "./FleetPage";
import { FleetRailButton } from "./RailButton";
import { capRows, eventRows, podRow, summarizeNodes, nodeRow } from "./rows";
import { problemSourceStats, RETRY_BASE_MS } from "../problems/store";
import { openFleet, resetConnectQueue, toggleFleet } from "./store";

const cluster = (id: string, context: string): ClusterInfo => ({
  id,
  context,
  clusterName: context,
  server: `https://${id}.example`,
  user: "admin",
  namespace: null,
  sourceId: "s",
});
const CLUSTERS = [cluster("c1", "kind-test"), cluster("c2", "prod-eu"), cluster("c3", "staging")];

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
const CONFIGMAP: KindRef = { group: "", version: "v1", kind: "ConfigMap" };
function served(kindRef: KindRef, plural: string): ResourceKind {
  return { kindRef, plural, namespaced: true, verbs: ["get", "list", "watch"], printerColumns: [] };
}
const KINDS = [served(POD, "pods"), served(DEPLOYMENT, "deployments"), served(SERVICE, "services"), served(CONFIGMAP, "configmaps")];

function node(name: string, ready: boolean, version = "v1.31.2"): KubeObject {
  return {
    metadata: { name, uid: `node-${name}` },
    status: {
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
      nodeInfo: { kubeletVersion: version },
      allocatable: { cpu: "2", memory: "4Gi" },
    },
  };
}

function pod(name: string, namespace: string, waiting?: string): KubeObject {
  return {
    metadata: { name, namespace, uid: `pod-${namespace}-${name}`, creationTimestamp: new Date().toISOString() },
    spec: { containers: [{ name: "app" }], nodeName: "n1" },
    status: {
      phase: "Running",
      containerStatuses: [
        waiting
          ? { name: "app", ready: false, restartCount: 7, state: { waiting: { reason: waiting } } }
          : { name: "app", ready: true, restartCount: 0, state: { running: {} } },
      ],
    },
  };
}

interface Started {
  clusterId: string;
  spec: WatchSpec;
  streamId: string;
}

let backend: MockBackend;
let started: Started[];
let stopped: string[];
let stored: AppSettings;

function setUp(selected: string[], states: Record<string, "connected" | "disconnected">) {
  started = [];
  stopped = [];
  stored = { ...defaultAppSettings(), fleet: { selected } };
  backend = mockBackend({
    settings_get: () => structuredClone(stored),
    settings_update: (args) => {
      stored = structuredClone(args.settings as AppSettings);
      return structuredClone(stored);
    },
    clusters_list: () => CLUSTERS,
    kubeconfig_sources: () => [],
    cluster_state: (args) => ({ state: states[args.clusterId as string] ?? "disconnected" }),
    cluster_kinds: () => KINDS,
    watch_start: (args) => {
      started.push({ clusterId: args.clusterId as string, spec: args.spec as WatchSpec, streamId: args.streamId as string });
      return undefined;
    },
    watch_stop: (args) => {
      stopped.push(args.subscriptionId as string);
      return undefined;
    },
  });
  useClustersStore.setState({
    loaded: true,
    clusters: CLUSTERS,
    states: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }])),
  });
}

/** The newest open watch of `kind` in the cluster. */
async function watchOf(clusterId: string, kind: string, match?: (spec: WatchSpec) => boolean): Promise<string> {
  let found: Started | undefined;
  await waitFor(() => {
    found = [...started]
      .reverse()
      .find(
        (s) =>
          s.clusterId === clusterId &&
          s.spec.kind.kind === kind &&
          (!match || match(s.spec)) &&
          backend.listenerCount(`watch:${s.streamId}`) > 0,
      );
    expect(found).toBeDefined();
  });
  return found!.streamId;
}

function snapshot(streamId: string, items: KubeObject[]) {
  act(() => backend.emit(`watch:${streamId}`, { type: "snapshot", items }));
}

const watching = (clusterId: string) => started.filter((s) => s.clusterId === clusterId);
/** The watches open now (something listens to them). */
const openWatches = () => started.filter((s) => backend.listenerCount(`watch:${s.streamId}`) > 0);
/** Lists `items(clusterId)` to every open watch of `kind`. */
function snapshotAll(kind: string, items: (clusterId: string) => KubeObject[]) {
  for (const s of openWatches().filter((x) => x.spec.kind.kind === kind)) snapshot(s.streamId, items(s.clusterId));
}

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
  resetClusterKinds();
  resetProblemSources();
  resetObjectIndex();
  resetConnectQueue();
});

afterEach(() => {
  vi.useRealTimers();
  resetProblemSources();
  resetObjectIndex();
  resetConnectQueue();
  (backend as MockBackend | undefined)?.restore();
  backend = undefined as unknown as MockBackend;
});

describe("opening the overview", () => {
  it("is the rail's All clusters; it leaves the active cluster and gives way when a cluster is opened", () => {
    setUp([], { c1: "connected" });
    useAppStore.getState().setActiveCluster("c1");
    render(<FleetRailButton />);
    fireEvent.click(screen.getByRole("button", { name: "All clusters" }));
    expect(useAppStore.getState().homeView).toBe("fleet");
    expect(useAppStore.getState().activeClusterId).toBeNull();
    expect(screen.getByRole("button", { name: "All clusters" })).toHaveAttribute("aria-current", "page");
    expect(getSlot("home")).toBe(FleetHome);

    act(() => useAppStore.getState().setActiveCluster("c1"));
    expect(useAppStore.getState().homeView).toBeNull();
  });

  it("goes back to the welcome area when All clusters is clicked again", () => {
    setUp([], {});
    render(<FleetRailButton />);
    fireEvent.click(screen.getByRole("button", { name: "All clusters" }));
    expect(useAppStore.getState().homeView).toBe("fleet");
    expect(screen.getByRole("button", { name: "All clusters" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "All clusters" }));
    expect(useAppStore.getState().homeView).toBeNull();
    act(() => toggleFleet());
    expect(useAppStore.getState().homeView).toBe("fleet");
  });

  it("wins over a cluster chosen just before that is still being opened", async () => {
    setUp([], { c1: "connected" });
    // c1 has no view yet: opening it waits for the settings, and All clusters is clicked meanwhile.
    selectCluster("c1");
    openFleet();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(useAppStore.getState().activeClusterId).toBeNull();
    expect(useAppStore.getState().homeView).toBe("fleet");
  });

  it("gives way to a cluster picked to be connected in the welcome area", () => {
    setUp([], {});
    openFleet();
    act(() => useClustersStore.setState({ pendingId: "c2" }));
    expect(useAppStore.getState().homeView).toBeNull();
  });
});

describe("the overview of several clusters", () => {
  it("remembers the chosen clusters and never connects one by itself", async () => {
    setUp(["c2"], { c1: "connected", c2: "disconnected" });
    render(<FleetPage />);
    const card = await screen.findByRole("region", { name: "prod-eu" });
    expect(within(card).getByText("Not connected.")).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(backend.calls.some((c) => c.cmd === "cluster_connect")).toBe(false);
    expect(watching("c2")).toEqual([]);

    fireEvent.click(screen.getByRole("checkbox", { name: /kind-test/ }));
    await waitFor(() => expect(stored.fleet.selected).toEqual(["c2", "c1"]));
    // A connected cluster shows at once.
    await screen.findByRole("region", { name: "kind-test" });
    await watchOf("c1", "Node");
    expect(backend.calls.some((c) => c.cmd === "cluster_connect")).toBe(false);

    fireEvent.click(screen.getByRole("checkbox", { name: /kind-test/ }));
    await waitFor(() => expect(stored.fleet.selected).toEqual(["c2"]));
  });

  it("connects a cluster on its button and shows a failed connection inline", async () => {
    setUp(["c2", "c3"], { c2: "disconnected", c3: "disconnected" });
    backend.on("cluster_connect", (args) => {
      if (args.clusterId === "c3") throw { code: "unreachable", message: "dial tcp: i/o timeout" };
      return undefined;
    });
    render(<FleetPage />);
    const card = await screen.findByRole("region", { name: "staging" });
    fireEvent.click(within(card).getByRole("button", { name: "Connect" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent("dial tcp: i/o timeout");
    expect(backend.calls.filter((c) => c.cmd === "cluster_connect").map((c) => c.args.clusterId)).toEqual(["c3"]);

    fireEvent.click(screen.getByRole("button", { name: "Connect all selected" }));
    await waitFor(() =>
      expect(backend.calls.filter((c) => c.cmd === "cluster_connect").map((c) => c.args.clusterId).sort()).toEqual(["c2", "c3", "c3"]),
    );
    await waitFor(() => expect(useClustersStore.getState().states.c2?.state).toBe("connected"));
  });

  it("shows each cluster's health and lists pods of all of them with a Cluster column", async () => {
    setUp(["c1", "c2"], { c1: "connected", c2: "connected" });
    render(<FleetPage />);
    await watchOf("c2", "Node");
    snapshotAll("Node", (c) => (c === "c1" ? [node("n1", true), node("n2", false, "v1.30.4")] : [node("m1", true)]));
    snapshotAll("Pod", (c) => (c === "c1" ? [pod("api", "shop", "CrashLoopBackOff"), pod("web", "shop")] : [pod("db", "data")]));

    const c1 = screen.getByRole("region", { name: "kind-test" });
    expect(within(c1).getByTestId("fleet-nodes")).toHaveTextContent("1 of 2 ready");
    expect(within(c1).getByText("v1.30.4 to v1.31.2")).toBeInTheDocument();
    await waitFor(() => expect(c1.querySelector('[data-category="pods"]')).toHaveTextContent(/^Pods1$/));
    const c2 = screen.getByRole("region", { name: "prod-eu" });
    expect(within(c2).getByTestId("fleet-nodes")).toHaveTextContent("1 of 1 ready");
    // Opt-in categories (security findings) are not watched by the cards.
    expect(FLEET_CATEGORIES).not.toContain("security");
    expect(started.some((s) => s.spec.kind.kind === "CronJob")).toBe(false);
    for (const s of watching("c2")) if (s.spec.kind.kind !== "Node" && s.spec.kind.kind !== "Pod") snapshot(s.streamId, []);
    await waitFor(() => expect(within(c2).getByRole("group", { name: "Problems" })).toHaveTextContent("No problems"));
  });

  it("aggregates pods across clusters, filters by cluster and namespace and opens details in the right cluster", async () => {
    setUp(["c1", "c2"], { c1: "connected", c2: "connected" });
    render(<FleetPage />);
    await watchOf("c2", "Pod");
    snapshotAll("Pod", (c) => (c === "c1" ? [pod("web", "shop"), pod("api", "shop", "CrashLoopBackOff")] : [pod("db", "data")]));
    const table = await screen.findByRole("table", { name: "Pods" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0]!.textContent)).toEqual(["kind-test", "kind-test", "prod-eu"]);
    // The worst first.
    expect(within(rows[0]!).getByText("CrashLoopBackOff")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Namespace" }), { target: { value: "data" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Namespace" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Cluster" }), { target: { value: "c1" } });
    expect(within(screen.getByRole("table", { name: "Pods" })).getAllByRole("row")).toHaveLength(3);
    fireEvent.change(screen.getByRole("combobox", { name: "Cluster" }), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "Open Pod db in prod-eu" }));
    expect(useAppStore.getState().activeClusterId).toBe("c2");
    expect(useAppStore.getState().details).toEqual({ kind: POD, namespace: "data", name: "db" });
    expect(useAppStore.getState().clusterViews.c2?.view).toBe("kind:/Pod");
  });

  it("lists Warning events from the shared problem watches, the newest first", async () => {
    setUp(["c1"], { c1: "connected" });
    render(<FleetPage />);
    const events = await watchOf("c1", "Event");
    const warning = (name: string, reason: string, at: string): KubeObject => ({
      metadata: { name, namespace: "shop", uid: `ev-${name}` },
      type: "Warning",
      reason,
      message: `${reason} happened`,
      lastTimestamp: at,
      involvedObject: { apiVersion: "v1", kind: "Pod", name: "web", namespace: "shop" },
    });
    snapshot(events, [warning("a", "BackOff", "2026-10-18T10:00:00Z"), warning("b", "FailedMount", "2026-10-18T11:00:00Z")]);
    fireEvent.click(screen.getByRole("tab", { name: "Warning events" }));
    const table = await screen.findByRole("table", { name: "Warning events" });
    const reasons = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[3]!.textContent);
    expect(reasons).toEqual(["FailedMount", "BackOff"]);
    // No second watch of events for the table.
    expect(started.filter((s) => s.spec.kind.kind === "Event")).toHaveLength(1);
  });

  it("says how many more rows a cluster has beyond the cap", async () => {
    setUp(["c1"], { c1: "connected" });
    render(<FleetPage />);
    await watchOf("c1", "Pod");
    const many = Array.from({ length: MAX_SHOWN_ROWS + 5 }, (_, i) => pod(`p${i}`, "load"));
    snapshotAll("Pod", () => many);
    const table = await screen.findByRole("table", { name: "Pods" });
    expect(within(table).getAllByRole("row")).toHaveLength(MAX_SHOWN_ROWS + 2);
    expect(within(table).getByText("5 more in kind-test are not listed. Narrow the filters to see them.")).toBeInTheDocument();
  });

  it("opens one watch per (cluster, kind): the tables ride on the cards' problem watches, and all close when left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setUp(["c1", "c2"], { c1: "connected", c2: "connected" });
    const { unmount } = render(<FleetPage />);
    await watchOf("c2", "DaemonSet");
    snapshotAll("Pod", () => [pod("web", "shop")]);
    fireEvent.click(screen.getByRole("tab", { name: "Workloads" }));
    await screen.findByRole("tab", { name: "Workloads", selected: true });
    const keys = openWatches().map((w) => `${w.clusterId}|${w.spec.kind.kind}|${w.spec.fieldSelector ?? ""}`);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    for (const kind of ["Node", "Pod", "Deployment", "StatefulSet", "DaemonSet"]) {
      expect(openWatches().filter((w) => w.clusterId === "c1" && w.spec.kind.kind === kind)).toHaveLength(1);
    }
    // Nodes, pods and three workload kinds in two clusters: taps, not watches.
    expect(problemSourceStats().taps).toBe(10);
    // No re-list: each watch was started once.
    expect(started.filter((w) => w.clusterId === "c1" && w.spec.kind.kind === "Pod")).toHaveLength(1);

    unmount();
    expect(problemSourceStats().taps).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(openWatches()).toEqual([]);
  });

  it("opens a watch that failed again, later and later, and its rows come back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setUp(["c1"], { c1: "connected" });
    render(<FleetPage />);
    const first = await watchOf("c1", "Pod");
    act(() => backend.emit(`watch:${first}`, { type: "error", code: "unreachable", message: "connection reset" }));
    expect(await screen.findByText("Could not list Pod in kind-test")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(RETRY_BASE_MS + 10));
    const second = await watchOf("c1", "Pod");
    expect(second).not.toBe(first);
    snapshot(second, [pod("web", "shop")]);
    expect(await screen.findByRole("button", { name: "Open Pod web in kind-test" })).toBeInTheDocument();
    expect(screen.queryByText("Could not list Pod in kind-test")).toBeNull();
  });

  it("shows a cluster that disconnects while open, and stops watching it", async () => {
    setUp(["c1"], { c1: "connected" });
    render(<FleetPage />);
    await watchOf("c1", "Node");
    act(() => useClustersStore.setState((s) => ({ states: { ...s.states, c1: { state: "disconnected" } } })));
    const card = screen.getByRole("region", { name: "kind-test" });
    expect(within(card).getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(problemSourceStats().taps).toBe(0);
    expect(screen.getByText("1 selected cluster is not connected; its objects are not listed.")).toBeInTheDocument();
  });

  it("shows at most ten clusters and says so", async () => {
    const many = Array.from({ length: 12 }, (_, i) => cluster(`k${i}`, `ctx-${i}`));
    setUp(many.slice(0, 10).map((c) => c.id), {});
    backend.on("clusters_list", () => many);
    useClustersStore.setState({ clusters: many });
    render(<FleetPage />);
    expect(await screen.findByText("You can show up to 10 clusters at once. Clear one to add another.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /ctx-11/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /ctx-0/ })).toBeEnabled();
    expect(screen.getAllByRole("region")).toHaveLength(10);
  });

  it("connects all selected clusters two at a time", async () => {
    setUp(["c1", "c2", "c3"], {});
    const pending: Record<string, () => void> = {};
    backend.on("cluster_connect", (args) => new Promise<void>((resolve) => (pending[args.clusterId as string] = resolve)));
    render(<FleetPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect all selected" }));
    const connects = () => backend.calls.filter((c) => c.cmd === "cluster_connect").map((c) => c.args.clusterId);
    await waitFor(() => expect(connects()).toEqual(["c1", "c2"]));
    expect(within(screen.getByRole("region", { name: "staging" })).getByText("Waiting to connect…")).toBeInTheDocument();
    await act(async () => pending.c1!());
    await waitFor(() => expect(connects()).toEqual(["c1", "c2", "c3"]));
  });

  it("finds objects by name in every selected cluster with the palette's bounded search", async () => {
    setUp(["c1", "c2"], { c1: "connected", c2: "connected" });
    render(<FleetPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Find by name" }));
    const before = started.length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Name" }), { target: { value: "web" } });
    const c1Pods = await watchOf("c1", "Pod", (s) => s.metadataOnly === true);
    const c2Pods = await watchOf("c2", "Pod", (s) => s.metadataOnly === true);
    const searched = started.slice(before).filter((s) => s.spec.metadataOnly);
    // Pods, Deployments and Services: the default kinds the cluster serves, never ConfigMaps unless asked.
    expect(new Set(searched.map((s) => s.spec.kind.kind))).toEqual(new Set(["Pod", "Deployment", "Service"]));
    snapshot(c1Pods, [{ metadata: { name: "web-1", namespace: "shop", uid: "w1" } }]);
    snapshot(c2Pods, [{ metadata: { name: "web-eu", namespace: "shop", uid: "w2" } }]);
    for (const s of searched) if (s.spec.kind.kind !== "Pod") snapshot(s.streamId, []);
    const hits = await within(screen.getByRole("tabpanel")).findAllByRole("button", { name: /^Open Pod/ });
    expect(hits.map((h) => h.getAttribute("aria-label"))).toEqual(["Open Pod web-1 in kind-test", "Open Pod web-eu in prod-eu"]);

    fireEvent.change(screen.getByRole("searchbox", { name: "Name" }), { target: { value: "cm settings" } });
    await watchOf("c1", "ConfigMap", (s) => s.metadataOnly === true);
  });
});

describe("rows", () => {
  it("summarize nodes with their versions, lowest first", () => {
    const summary = summarizeNodes([node("a", true, "v1.31.10"), node("b", true, "v1.31.9"), node("c", false)].map(nodeRow));
    expect(summary).toMatchObject({ total: 3, ready: 2, versions: ["v1.31.2", "v1.31.9", "v1.31.10"], cpu: 6000 });
  });

  it("keep a pod's status, readiness and restarts", () => {
    expect(podRow(pod("api", "shop", "CrashLoopBackOff"))).toMatchObject({
      status: "CrashLoopBackOff",
      ready: 0,
      containers: 1,
      restarts: 7,
      node: "n1",
    });
  });

  it("cap a list after the filter and count the rest", () => {
    expect(capRows([1, 2, 3, 4, 5, 6], (n) => n % 2 === 0, 2)).toEqual({ shown: [2, 4], more: 1 });
  });

  it("take the newest Warning events up to the limit", () => {
    const problem = (key: string, since: string) => ({
      key,
      notifyKey: key,
      category: "events" as const,
      uid: key,
      object: { kind: POD, namespace: "shop", name: key },
      reason: "BackOff",
      since,
      notify: false,
      firstSeen: 0,
      activeAt: 0,
    });
    const rows = eventRows([problem("old", "2026-01-01T00:00:00Z"), problem("new", "2026-02-01T00:00:00Z"), problem("mid", "2026-01-15T00:00:00Z")], 2);
    expect(rows.map((r) => r.key)).toEqual(["new", "mid"]);
  });
});
