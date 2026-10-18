import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type AppSettings, type KubeObject, type MockBackend, type ResourceKind, type WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { resetNamespaceRestore } from "../../features/namespaces";
import { getResourceDefs, nameColumn, registerResource, resetClusterKinds, unregisterResource } from "../../resources";
import { registerPage, unregisterPage } from "../pages";
import { Sidebar } from "../sidebar/Sidebar";
import { MainView } from "./MainView";

const kindRef = (group: string, version: string, kind: string) => ({ group, version, kind });
const served = (group: string, version: string, kind: string, extra: Partial<ResourceKind> = {}): ResourceKind => ({
  kindRef: kindRef(group, version, kind),
  plural: `${kind.toLowerCase()}s`,
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
  ...extra,
});

// Every built-in kind except DaemonSet (to see that kinds the cluster does not serve are hidden), and the CRD.
const KINDS: ResourceKind[] = [
  ...getResourceDefs()
    .filter((d) => d.kind.kind !== "DaemonSet")
    .map((d) => served(d.kind.group, d.kind.version, d.kind.kind, { namespaced: d.namespaced ?? true })),
  // Discovery names custom kinds only; their printer columns come from their CRD.
  served("demo.sextant.dev", "v1", "Widget"),
  // A CRD in a Kubernetes-named group (Gateway API) is a custom resource too.
  served("gateway.networking.k8s.io", "v1", "Gateway"),
  // Kubernetes' own API groups and aggregated metrics are not custom resources.
  served("metrics.k8s.io", "v1beta1", "PodMetrics", { verbs: ["get", "list"] }),
  served("coordination.k8s.io", "v1", "Lease"),
];

const widgetsCrd: KubeObject = {
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: { name: "widgets.demo.sextant.dev", uid: "crd-1" },
  spec: {
    group: "demo.sextant.dev",
    scope: "Namespaced",
    names: { kind: "Widget", plural: "widgets" },
    versions: [
      {
        name: "v1",
        served: true,
        storage: true,
        additionalPrinterColumns: [
          { name: "Size", jsonPath: ".spec.size", type: "string" },
          { name: "Replicas", jsonPath: ".spec.replicas", type: "integer" },
          { name: "Debug", jsonPath: ".spec.debug", type: "string", priority: 1 },
          { name: "Age", jsonPath: ".metadata.creationTimestamp", type: "date" },
        ],
      },
    ],
  },
};

let backend: MockBackend;
let watches: { id: string; spec: WatchSpec }[];

function setup(settings?: Partial<AppSettings>) {
  watches = [];
  backend = mockBackend(
    {
      cluster_kinds: () => KINDS,
      resource_get: (args) => {
        const ref = args.ref as { kind: { kind: string }; name: string };
        if (ref.kind.kind === "CustomResourceDefinition" && ref.name === "widgets.demo.sextant.dev") return widgetsCrd;
        throw { code: "notFound", message: `${ref.name} not found` };
      },
      watch_start: (args) => {
        const spec = args.spec as WatchSpec;
        const id = `${spec.kind.kind}-${watches.length + 1}`;
        watches.push({ id, spec });
        return id;
      },
      watch_stop: () => undefined,
    },
    { settings },
  );
}

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetNamespaceRestore();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  setup();
});
afterEach(() => backend.restore());

function Cluster() {
  return (
    <>
      <nav aria-label="Sections">
        <Sidebar clusterId="c1" />
      </nav>
      <main>
        <MainView clusterId="c1" />
      </main>
    </>
  );
}

/** The latest watch of a kind by a table (not the sidebar's metadata-only watch of CRDs), once its listener is
 * attached. */
async function watchOf(kind: string): Promise<{ id: string; spec: WatchSpec }> {
  let found: { id: string; spec: WatchSpec } | undefined;
  await waitFor(() => {
    found = [...watches].reverse().find((w) => w.spec.kind.kind === kind && !w.spec.metadataOnly);
    expect(found && backend.listenerCount(`watch:${found.id}`)).toBe(1);
  });
  return found!;
}

function emit(id: string, items: KubeObject[]) {
  act(() => backend.emit(`watch:${id}`, { type: "snapshot", items }));
}

const sidebar = () => screen.getByRole("navigation", { name: "Sections" });

describe("Sidebar and main view", () => {
  it("lists the Lens sections and opens a kind's table from them", async () => {
    render(<Cluster />);
    await waitFor(() => expect(within(sidebar()).getByRole("button", { name: /Workloads/ })).toBeInTheDocument());
    const groups = within(sidebar())
      .getAllByRole("button")
      .map((b) => b.textContent?.replace(/[▸▾]/g, ""));
    expect(groups).toEqual([
      "Nodes",
      "Workloads",
      "Config",
      "Network",
      "Storage",
      "Namespaces",
      "Access Control",
      "Custom Resources",
    ]);

    fireEvent.click(within(sidebar()).getByRole("button", { name: /Workloads/ }));
    // Once discovery is known, kinds the cluster does not serve (DaemonSet in this mock) are hidden.
    expect(
      within(sidebar())
        .getAllByRole("button")
        .map((b) => b.textContent?.replace(/[▸▾]/g, ""))
        .slice(2, 8),
    ).toEqual(["Pods", "Deployments", "Stateful Sets", "Replica Sets", "Jobs", "Cron Jobs"]);

    fireEvent.click(within(sidebar()).getByRole("button", { name: "Deployments" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe("kind:apps/Deployment");
    const { spec } = await watchOf("Deployment");
    expect(spec.kind).toEqual(kindRef("apps", "v1", "Deployment"));
    expect(await screen.findByRole("heading", { name: "Deployments" })).toBeInTheDocument();
  });

  it("adds registered pages to their sections and hides sections without entries", async () => {
    registerPage({ id: "t-events", section: "events", order: 0, labelKey: "resources:sections.events", Component: () => <p>events page</p> });
    registerPage({ id: "t-releases", section: "helm", order: 10, labelKey: "Releases", Component: () => <p>releases</p> });
    registerPage({ id: "t-pf", section: "network", order: 100, labelKey: "Port Forwarding", Component: () => <p>pf</p> });
    try {
      render(<Cluster />);
      await waitFor(() => expect(within(sidebar()).getByRole("button", { name: /Helm/ })).toBeInTheDocument());
      expect(within(sidebar()).queryByRole("button", { name: /^Cluster$/ })).not.toBeInTheDocument();
      fireEvent.click(within(sidebar()).getByRole("button", { name: "Events" }));
      expect(screen.getByText("events page")).toBeInTheDocument();
      fireEvent.click(within(sidebar()).getByRole("button", { name: /Network/ }));
      fireEvent.click(within(sidebar()).getByRole("button", { name: "Port Forwarding" }));
      expect(screen.getByText("pf")).toBeInTheDocument();
    } finally {
      unregisterPage("t-events");
      unregisterPage("t-releases");
      unregisterPage("t-pf");
    }
  });

  it("lists custom resources by group from discovery; a CR table reads its printer columns from its one CRD", async () => {
    render(<Cluster />);
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /Custom Resources/ }));
    expect(within(sidebar()).getByRole("button", { name: "Definitions" })).toBeInTheDocument();
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /demo\.sextant\.dev/ }));
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Widget" }));
    // The sidebar does not download the CRDs (with their schemas) to list them; it watches their metadata only.
    expect(watches.filter((w) => w.spec.kind.kind === "CustomResourceDefinition" && !w.spec.metadataOnly)).toEqual([]);

    const widgets = await watchOf("Widget");
    expect(widgets.spec.kind).toEqual(kindRef("demo.sextant.dev", "v1", "Widget"));
    emit(widgets.id, [
      {
        apiVersion: "demo.sextant.dev/v1",
        kind: "Widget",
        metadata: { name: "demo-widget", namespace: "sextant-demo", uid: "w1", creationTimestamp: "2026-10-01T00:00:00Z" },
        spec: { size: "large", replicas: 3 },
      },
    ]);
    const table = await screen.findByRole("table", { name: "Widget" });
    const headers = () =>
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent?.replace(/[▲▼]/g, ""))
        .filter(Boolean);
    await waitFor(() => expect(headers()).toEqual(["Name", "Namespace", "Size", "Replicas", "Age"]));
    expect(within(table).getByText("large")).toBeInTheDocument();
    const crdReads = backend.calls.filter((c) => c.cmd === "resource_get");
    expect(crdReads.map((c) => c.args.ref)).toEqual([
      { kind: kindRef("apiextensions.k8s.io", "v1", "CustomResourceDefinition"), namespace: null, name: "widgets.demo.sextant.dev" },
    ]);

    fireEvent.click(within(sidebar()).getByRole("button", { name: "Definitions" }));
    const defs = await watchOf("CustomResourceDefinition");
    emit(defs.id, [widgetsCrd]);
    const crdTable = await screen.findByRole("table", { name: "Definitions" });
    expect(within(crdTable).getByText("widgets.demo.sextant.dev")).toBeInTheDocument();
    expect(within(crdTable).getByText("Namespaced")).toBeInTheDocument();
  });

  it("lists CRDs of Kubernetes-named groups, but not Kubernetes' own groups or kinds that cannot be watched", async () => {
    render(<Cluster />);
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /Custom Resources/ }));
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /gateway\.networking\.k8s\.io/ }));
    expect(within(sidebar()).getByRole("button", { name: "Gateway" })).toBeInTheDocument();
    expect(within(sidebar()).queryByRole("button", { name: /^apps$/ })).not.toBeInTheDocument();
    expect(within(sidebar()).queryByRole("button", { name: /metrics\.k8s\.io/ })).not.toBeInTheDocument();
    expect(within(sidebar()).queryByRole("button", { name: /coordination\.k8s\.io/ })).not.toBeInTheDocument();
  });

  it("a CR table without the right to read its CRD shows the standard columns", async () => {
    act(() => useAppStore.getState().setView("c1", "kind:gateway.networking.k8s.io/Gateway"));
    render(<Cluster />);
    const gateways = await watchOf("Gateway");
    emit(gateways.id, []);
    await screen.findByText("No objects found in the selected namespaces");
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "resource_get")).toBe(true));
    expect(screen.getByRole("heading", { name: "Gateway" })).toBeInTheDocument();
  });

  it("a section opened before its data shows its title and a loading counter at once", () => {
    vi.useFakeTimers();
    try {
      // Discovery never answers: a custom kind waits for it, a built-in kind does not.
      backend.restore();
      watches = [];
      backend = mockBackend({
        cluster_kinds: () => new Promise(() => undefined),
        watch_start: () => undefined,
        watch_stop: () => undefined,
      });
      act(() => useAppStore.getState().setView("c1", "kind:demo.sextant.dev/Widget"));
      render(<Cluster />);
      expect(screen.getByRole("heading", { name: "Widget" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(/^Loading Widget…$/);
      act(() => vi.advanceTimersByTime(6_000));
      expect(screen.getByRole("status")).toHaveTextContent(/^Loading Widget…\s*6 s/);
      expect(screen.getByText("The cluster is slow to respond")).toBeInTheDocument();

      act(() => useAppStore.getState().setView("c1", "kind:/Node"));
      expect(screen.getByRole("heading", { name: "Nodes" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(/^Loading Nodes…$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves the namespace choice per cluster and uses it after a restart", async () => {
    act(() => useAppStore.getState().setView("c1", "kind:/Pod"));
    const { unmount } = render(<Cluster />);
    const pods = await watchOf("Pod");
    expect(pods.spec.namespaces).toBeNull();
    const namespaces = await watchOf("Namespace");
    emit(namespaces.id, [
      { metadata: { name: "default", uid: "n1" } },
      { metadata: { name: "sextant-demo", uid: "n2" } },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Namespaces: All namespaces" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "sextant-demo" }));
    await waitFor(() => expect(backend.settings.clusters.c1?.namespaces).toEqual(["sextant-demo"]));
    await waitFor(() => expect(watches.at(-1)?.spec.namespaces).toEqual(["sextant-demo"]));
    expect(screen.getByRole("button", { name: "Namespaces: sextant-demo" })).toBeInTheDocument();
    unmount();

    // Restart: a fresh store, the settings as saved.
    const saved = backend.settings;
    backend.restore();
    resetAppStore();
    resetClusterKinds();
    resetNamespaceRestore();
    setup(saved);
    act(() => useAppStore.getState().setView("c1", "kind:/Pod"));
    render(<Cluster />);
    const again = await watchOf("Pod");
    expect(again.spec.namespaces).toEqual(["sextant-demo"]);
    expect(watches.filter((w) => w.spec.kind.kind === "Pod")).toHaveLength(1);

    // "All namespaces" clears it.
    fireEvent.click(screen.getByRole("button", { name: "Namespaces: sextant-demo" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All namespaces" }));
    await waitFor(() => expect(backend.settings.clusters.c1?.namespaces).toBeNull());
  });
});

describe("Only problems", () => {
  const GIZMO = kindRef("demo.sextant.dev", "v1", "Gizmo");
  const gizmo = (name: string, broken: boolean): KubeObject => ({
    metadata: { name, namespace: "default", uid: name },
    spec: { broken },
  });

  it("a kind that says what a problem is offers the filter; it keeps only those rows", async () => {
    registerResource({
      kind: GIZMO,
      sidebar: null,
      columns: [nameColumn],
      actions: [],
      problem: (obj) => (obj.spec as { broken: boolean }).broken,
    });
    try {
      useAppStore.getState().setView("c1", "kind:demo.sextant.dev/Gizmo");
      render(<MainView clusterId="c1" />);
      const { id } = await watchOf("Gizmo");
      emit(id, [gizmo("good", false), gizmo("bad", true)]);
      expect(await screen.findByText("good")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("checkbox", { name: "Only problems" }));
      await waitFor(() => expect(screen.queryByText("good")).toBeNull());
      expect(screen.getByText("bad")).toBeInTheDocument();
      expect(screen.getByTestId("rt-count")).toHaveTextContent("1 of 2");
      emit(id, [gizmo("good", false)]);
      expect(await screen.findByText("Nothing matches the filter")).toBeInTheDocument();
    } finally {
      unregisterResource(GIZMO);
    }
  });

  it("starts off again for another kind or cluster", async () => {
    const OTHER = kindRef("demo.sextant.dev", "v1", "Doohickey");
    for (const kind of [GIZMO, OTHER]) {
      registerResource({ kind, sidebar: null, columns: [nameColumn], actions: [], problem: () => true });
    }
    try {
      useAppStore.getState().setView("c1", "kind:demo.sextant.dev/Gizmo");
      useAppStore.getState().setView("c2", "kind:demo.sextant.dev/Gizmo");
      const { rerender } = render(<MainView clusterId="c1" />);
      fireEvent.click(await screen.findByRole("checkbox", { name: "Only problems" }));
      expect(screen.getByRole("checkbox", { name: "Only problems" })).toBeChecked();
      act(() => useAppStore.getState().setView("c1", "kind:demo.sextant.dev/Doohickey"));
      expect(await screen.findByRole("checkbox", { name: "Only problems" })).not.toBeChecked();
      fireEvent.click(screen.getByRole("checkbox", { name: "Only problems" }));
      rerender(<MainView clusterId="c2" />);
      expect(await screen.findByRole("checkbox", { name: "Only problems" })).not.toBeChecked();
    } finally {
      unregisterResource(GIZMO);
      unregisterResource(OTHER);
    }
  });

  it("other kinds have no such filter", async () => {
    useAppStore.getState().setView("c1", "kind:apps/Deployment");
    render(<MainView clusterId="c1" />);
    await watchOf("Deployment");
    expect(await screen.findByRole("heading", { name: "Deployments" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Only problems" })).toBeNull();
  });
});
