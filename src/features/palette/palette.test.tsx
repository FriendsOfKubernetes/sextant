import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type ClusterInfo, type KindRef, type KubeObject, type MockBackend, type ResourceKind } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { registerPage, unregisterPage } from "../../layout/pages";
import { resetClusterKinds } from "../../resources";
import "../actions/index";
import "../restart";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import { ActionBar } from "../details/ActionBar";
import { resetSettingsUi, useSettingsUi } from "../settings/store";
import { fuzzyScore } from "./fuzzy";
import { KEEP_ALIVE_MS, MAX_CONCURRENT_LISTS, resetObjectIndex, searchKinds } from "./objectIndex";
import { PaletteHost } from "./PaletteHost";
import { isPaletteShortcut } from "./shortcut";
import { resetPalette } from "./store";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const EVENT: KindRef = { group: "", version: "v1", kind: "Event" };
const WIDGET: KindRef = { group: "example.com", version: "v1alpha1", kind: "Widget" };

function served(kindRef: KindRef, plural: string, namespaced = true): ResourceKind {
  return { kindRef, plural, namespaced, verbs: ["get", "list", "watch"], printerColumns: [] };
}
const KINDS = [served(POD, "pods"), served(DEPLOYMENT, "deployments"), served(EVENT, "events"), served(WIDGET, "widgets")];

function pod(name: string, phase: string): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: "demo", uid: `pod-${name}`, resourceVersion: "1" },
    spec: { containers: [{ name: "app" }] },
    status: { phase },
  };
}
const DEPLOY_API: KubeObject = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "api", namespace: "demo", uid: "deploy-api", resourceVersion: "7" },
  spec: { replicas: 2 },
  status: { readyReplicas: 2, replicas: 2 },
};
const FULL: Record<string, KubeObject> = {
  "web-1": pod("web-1", "Running"),
  "web-2": pod("web-2", "Running"),
  "db-0": pod("db-0", "Pending"),
  api: DEPLOY_API,
};
/** What a metadata-only watch delivers: the metadata alone. */
const metaOf = (obj: KubeObject): KubeObject => ({ apiVersion: obj.apiVersion, kind: obj.kind, metadata: obj.metadata });

const CLUSTERS: ClusterInfo[] = [
  { id: "c1", context: "kind-test", clusterName: "kind-test", server: "https://127.0.0.1:6443", user: "admin", namespace: null, sourceId: "s" },
  { id: "c2", context: "prod-eu", clusterName: "prod-eu", server: "https://10.0.0.1", user: "admin", namespace: null, sourceId: "s" },
];

let backend: MockBackend;
/** Stream ids of the started watches by kind, in start order. */
let started: { kind: string; streamId: string; spec: Record<string, unknown> }[];

beforeEach(() => {
  resetAppStore();
  resetPalette();
  resetObjectIndex();
  resetClusterKinds();
  resetClustersStore();
  resetSettingsUi();
  started = [];
  backend = mockBackend({
    cluster_kinds: () => KINDS,
    watch_start: (args) => {
      const spec = args.spec as { kind: KindRef };
      started.push({ kind: spec.kind.kind, streamId: args.streamId as string, spec: args.spec as Record<string, unknown> });
      return `w-${spec.kind.kind}`;
    },
    watch_stop: () => undefined,
    resource_get: (args) => {
      const ref = args.ref as { name: string };
      const obj = FULL[ref.name];
      if (!obj) throw { code: "notFound", message: "not found" };
      return obj;
    },
    workload_restart: () => undefined,
  });
  useClustersStore.setState({ clusters: CLUSTERS, states: { c1: { state: "connected" }, c2: { state: "connected" } } });
  // Dialogs of actions live in the registry's module state: close the ones a previous test left open.
  render(<ActionDialogHost />);
  while (screen.queryAllByRole("dialog").length > 0) fireEvent.keyDown(window, { key: "Escape" });
});
afterEach(() => {
  resetObjectIndex();
  backend.restore();
  vi.useRealTimers();
});

function withCluster(id = "c1") {
  act(() => useAppStore.getState().setActiveCluster(id));
}

function renderPalette() {
  return render(
    <>
      <input aria-label="elsewhere" />
      <PaletteHost />
    </>,
  );
}

function pressShortcut(target: Element | Document = document.body, extra: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(target, { key: "k", code: "KeyK", ctrlKey: true, ...extra });
}

const field = () => screen.getByRole("combobox", { name: "Search" });
const palette = () => screen.queryByRole("dialog", { name: "Command palette" });

function type(text: string) {
  fireEvent.change(field(), { target: { value: text } });
}

/** Delivers the first list of every started watch. */
function listAll(objects: Record<string, KubeObject[]>) {
  act(() => {
    for (const w of started) backend.emit(`watch:w-${w.kind}`, { type: "snapshot", items: (objects[w.kind] ?? []).map(metaOf) });
  });
}

async function openWithObjects() {
  withCluster();
  renderPalette();
  pressShortcut();
  // Nothing is listed until something is typed.
  type("w");
  await waitFor(() => expect(started.map((w) => w.kind)).toEqual(["Pod", "Deployment"]));
  listAll({ Pod: [FULL["web-1"]!, FULL["web-2"]!, FULL["db-0"]!], Deployment: [DEPLOY_API] });
}

describe("command palette", () => {
  it("opens with Ctrl+K and closes with Escape or the shortcut again; in a text field only with Shift", () => {
    renderPalette();
    const elsewhere = screen.getByRole("textbox", { name: "elsewhere" });

    pressShortcut();
    expect(palette()).toBeInTheDocument();
    expect(field()).toHaveFocus();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(palette()).not.toBeInTheDocument();

    pressShortcut(document.body, { ctrlKey: false, metaKey: true });
    expect(palette()).toBeInTheDocument();
    pressShortcut(field());
    expect(palette()).not.toBeInTheDocument();

    // Typing somewhere: Ctrl+K belongs to the field, Ctrl+Shift+K opens the palette; focus comes back on close.
    elsewhere.focus();
    pressShortcut(elsewhere);
    expect(palette()).not.toBeInTheDocument();
    pressShortcut(elsewhere, { key: "K", shiftKey: true });
    expect(palette()).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(elsewhere).toHaveFocus();
  });

  it("finds a pod by a fuzzy name, with its namespace and status, and opens its details on Enter", async () => {
    await openWithObjects();
    type("wb2");
    const pods = await screen.findByRole("group", { name: "Pods" });
    const option = within(pods).getByRole("option", { name: /web-2/ });
    expect(within(pods).queryByRole("option", { name: /db-0/ })).not.toBeInTheDocument();
    expect(option).toHaveTextContent("demo");
    // The status comes from the whole object, read for the top results only.
    await waitFor(() => expect(option).toHaveTextContent("Running"));
    expect(option).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(field(), { key: "Enter" });
    expect(palette()).not.toBeInTheDocument();
    expect(useAppStore.getState().details).toEqual({ kind: POD, namespace: "demo", name: "web-2" });
  });

  it("starts no search on open, only with the first typed character", async () => {
    withCluster();
    renderPalette();
    pressShortcut();
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toHaveLength(0);
    type("w");
    await waitFor(() => expect(started.length).toBeGreaterThan(0));
    // Clearing the field does not stop or restart anything.
    type("");
    type("we");
    expect(started.map((w) => w.kind)).toEqual(["Pod", "Deployment"]);
  });

  it("searches the common kinds, metadata only, in every namespace, at most a few lists at once", async () => {
    withCluster();
    const common = [
      served({ group: "apps", version: "v1", kind: "StatefulSet" }, "statefulsets"),
      served({ group: "apps", version: "v1", kind: "DaemonSet" }, "daemonsets"),
      served({ group: "batch", version: "v1", kind: "Job" }, "jobs"),
      served({ group: "batch", version: "v1", kind: "CronJob" }, "cronjobs"),
      served({ group: "", version: "v1", kind: "Service" }, "services"),
      served({ group: "", version: "v1", kind: "ConfigMap" }, "configmaps"),
    ];
    const many = Array.from({ length: 12 }, (_, i) => served({ group: "x.io", version: "v1", kind: `K${i}` }, `k${i}`));
    backend.on("cluster_kinds", () => [...KINDS, ...common, ...many]);
    renderPalette();
    pressShortcut();
    type("w");
    await waitFor(() => expect(started).toHaveLength(MAX_CONCURRENT_LISTS));
    expect(started[0]).toMatchObject({ kind: "Pod", spec: { metadataOnly: true, namespaces: null } });
    // The next kinds start as the first lists come; custom kinds and events never by default.
    listAll({});
    await waitFor(() => expect(started).toHaveLength(8));
    listAll({});
    await new Promise((r) => setTimeout(r, 150));
    const kinds = started.map((w) => w.kind);
    expect(kinds).toHaveLength(8);
    expect(kinds).not.toContain("Event");
    expect(kinds).not.toContain("Widget");
    expect(kinds.filter((k) => k.startsWith("K"))).toEqual([]);
  });

  it("searches another kind when the query names it, and every kind when asked", async () => {
    withCluster();
    const many = Array.from({ length: 3 }, (_, i) => served({ group: "x.io", version: "v1", kind: `K${i}` }, `k${i}`));
    backend.on("cluster_kinds", () => [...KINDS, ...many]);
    renderPalette();
    pressShortcut();
    type("widgets blue");
    await waitFor(() => expect(started.map((w) => w.kind)).toContain("Widget"));
    const widget = { apiVersion: "example.com/v1alpha1", kind: "Widget", metadata: { name: "blue", namespace: "demo", uid: "w1" } };
    listAll({ Widget: [widget] });
    await waitFor(() => expect(screen.getByRole("group", { name: "Widget" })).toBeInTheDocument());

    // `kind:` lists the kind; a short name works too.
    type("widget:");
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Widget" })).getByRole("option")).toHaveTextContent("blue"));
    expect(started.map((w) => w.kind)).not.toContain("K0");

    type("zzz");
    const all = await screen.findByRole("option", { name: /Search all kinds/ });
    fireEvent.click(all);
    expect(palette()).toBeInTheDocument();
    await waitFor(() => expect(started.map((w) => w.kind)).toEqual(expect.arrayContaining(["K0", "K1", "K2"])));
    expect(screen.queryByRole("option", { name: /Search all kinds/ })).not.toBeInTheDocument();
  });

  it("searches the open table's kind first", () => {
    const order = searchKinds(KINDS, { group: "example.com", kind: "Widget" }).map((k) => k.kind.kind);
    expect(order).toEqual(["Widget", "Pod", "Deployment"]);
  });

  it("keeps the searches for a while after it closes, reuses them on reopening, then stops them", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    await openWithObjects();
    const ids = started.map((w) => w.streamId);
    const stops = () => backend.calls.filter((c) => c.cmd === "watch_stop").map((c) => c.args.subscriptionId);
    fireEvent.keyDown(field(), { key: "Escape" });
    act(() => vi.advanceTimersByTime(KEEP_ALIVE_MS - 1000));
    expect(stops()).toEqual([]);

    // Reopened: the names are there at once, nothing is listed again.
    pressShortcut();
    type("wb2");
    expect(await screen.findByRole("option", { name: /web-2/ })).toBeInTheDocument();
    expect(started.map((w) => w.streamId)).toEqual(ids);

    fireEvent.keyDown(field(), { key: "Escape" });
    act(() => vi.advanceTimersByTime(KEEP_ALIVE_MS - 1000));
    expect(stops()).toEqual([]);
    act(() => vi.advanceTimersByTime(1000));
    await waitFor(() => expect(stops()).toEqual(expect.arrayContaining(ids)));
    expect(backend.listenerCount("watch:w-Pod")).toBe(0);
  });

  it("goes to a section, a page and a Settings tab", async () => {
    const Page = () => null;
    registerPage({ id: "t-releases", section: "helm", order: 1, label: "Chart Releases", Component: Page });
    try {
      withCluster();
      renderPalette();
      pressShortcut();
      type("deployments");
      const goTo = await screen.findByRole("group", { name: "Go to" });
      expect(within(goTo).getAllByRole("option")[0]).toHaveTextContent("Deployments");
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(useAppStore.getState().clusterViews.c1?.view).toBe("kind:apps/Deployment");

      pressShortcut();
      type("chart rel");
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(useAppStore.getState().clusterViews.c1?.view).toBe("t-releases");

      pressShortcut();
      type("ai agents");
      expect(screen.getAllByRole("option")[0]).toHaveTextContent("Settings: AI agents");
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(useAppStore.getState().clusterViews.c1?.view).toBe("settings");
      expect(useSettingsUi.getState().tab).toBe("agents");

      // What was chosen comes first next time.
      pressShortcut();
      const recent = screen.getByRole("group", { name: "Recent" });
      expect(within(recent).getAllByRole("option").map((o) => o.textContent)).toEqual([
        "Settings: AI agents",
        expect.stringContaining("Chart Releases"),
        expect.stringContaining("Deployments"),
      ]);
    } finally {
      unregisterPage("t-releases");
    }
  });

  it("switches to another cluster", async () => {
    withCluster();
    renderPalette();
    pressShortcut();
    type("prod");
    const clusters = screen.getByRole("group", { name: "Clusters" });
    expect(within(clusters).getByRole("option", { name: /prod-eu/ })).toHaveTextContent("Switch");
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBe("c2"));
  });

  it("runs an object's action from the registry with the same call as the details panel's button", async () => {
    await openWithObjects();
    type("deploy api");
    const option = await screen.findByRole("option", { name: /^api/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field(), { key: "Tab" });
    const restart = await screen.findByRole("option", { name: "Restart" });
    expect(screen.getByRole("option", { name: "Scale" })).toBeInTheDocument();
    // Filtering the actions by typing, then Enter: the action's own confirmation.
    type("rest");
    expect(restart).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(palette()).not.toBeInTheDocument();
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(backend.calls.filter((c) => c.cmd === "workload_restart")).toHaveLength(1));

    // The same through the details panel's button.
    const { unmount } = render(<ActionBar clusterId="c1" kind={DEPLOYMENT} obj={DEPLOY_API} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(backend.calls.filter((c) => c.cmd === "workload_restart")).toHaveLength(2));
    unmount();
    const [fromPalette, fromButton] = backend.calls.filter((c) => c.cmd === "workload_restart").map((c) => c.args);
    expect(fromPalette).toEqual(fromButton);
    expect(fromPalette).toEqual({ clusterId: "c1", ref: { kind: DEPLOYMENT, namespace: "demo", name: "api" } });
  });

  it("goes back from the actions with Shift+Tab and offers the object open in details first", async () => {
    withCluster();
    act(() => useAppStore.getState().openDetails({ kind: POD, namespace: "demo", name: "web-1" }));
    renderPalette();
    pressShortcut();
    const selected = screen.getByRole("group", { name: "Open in details" });
    expect(within(selected).getByRole("option")).toHaveTextContent("web-1");
    fireEvent.keyDown(field(), { key: "Tab" });
    expect(await screen.findByRole("option", { name: "Open details" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Delete" })).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: "Tab", shiftKey: true });
    expect(screen.getByRole("group", { name: "Open in details" })).toBeInTheDocument();
  });

  it("without a cluster offers the clusters and Settings and searches no objects", async () => {
    renderPalette();
    pressShortcut();
    expect(screen.queryByRole("group", { name: "Go to" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Clusters" })).toBeInTheDocument();
    type("web");
    expect(screen.getByRole("status")).toHaveTextContent("Open a cluster to search its objects");
    type("general");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(useSettingsUi.getState()).toMatchObject({ dialogOpen: true, tab: "general" });
    expect(backend.calls.some((c) => c.cmd === "watch_start" || c.cmd === "cluster_kinds")).toBe(false);
  });
});

describe("palette matching", () => {
  it("ranks exact over prefix over substring over scattered characters", () => {
    const exact = fuzzyScore("web", "web")!;
    const prefix = fuzzyScore("web", "web-1")!;
    const substring = fuzzyScore("web", "my-web-1")!;
    const scattered = fuzzyScore("wb1", "web-1")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
    expect(fuzzyScore("bw", "web")).toBeNull();
  });

  it("the shortcut is Ctrl/Cmd+K, and inside a terminal or an editor only with Shift", () => {
    const key = (target: Element, init: KeyboardEventInit) => {
      const e = new KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true, ...init });
      Object.defineProperty(e, "target", { value: target });
      return isPaletteShortcut(e);
    };
    const term = document.createElement("div");
    term.className = "xterm";
    const inner = document.createElement("textarea");
    term.append(inner);
    const button = document.createElement("button");
    expect(key(button, { ctrlKey: true })).toBe(true);
    expect(key(button, { metaKey: true })).toBe(true);
    expect(key(button, {})).toBe(false);
    expect(key(button, { ctrlKey: true, altKey: true })).toBe(false);
    expect(key(inner, { ctrlKey: true })).toBe(false);
    expect(key(inner, { ctrlKey: true, shiftKey: true })).toBe(true);
    // Another keyboard layout: the key is another letter, the physical key is K.
    expect(key(button, { ctrlKey: true, key: "л" })).toBe(true);
  });
});
