import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KubeObject, type MockBackend, type ResourceKind, type WatchSpec } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, tableStateOf, useAppStore } from "../../app/store";
import { MainView } from "../../layout/main/MainView";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDefs, resetClusterKinds } from "../../resources";
import { resetNamespaceRestore } from "../namespaces";
import "./index";
import type { SavedView } from "./model";

const KINDS: ResourceKind[] = getResourceDefs().map((d) => ({
  kindRef: d.kind,
  plural: `${d.kind.kind.toLowerCase()}s`,
  namespaced: d.namespaced ?? true,
  verbs: ["list", "watch"],
  printerColumns: [],
}));

const POD_VIEW = "kind:/Pod";
const VIEW: SavedView = {
  id: "v1",
  name: "Front pods",
  cluster: "c1",
  group: "",
  kind: "Pod",
  namespaces: null,
  search: "",
  onlyProblems: false,
  labelSelector: "tier=front",
  sort: null,
  hiddenColumns: ["namespace"],
};

let backend: MockBackend;
let watches: { id: string; spec: WatchSpec }[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetNamespaceRestore();
  resetSettingsCache();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  watches = [];
  backend = mockBackend(
    {
      cluster_kinds: () => KINDS,
      watch_start: (args) => {
        const spec = args.spec as WatchSpec;
        const id = `${spec.kind.kind}-${watches.length + 1}`;
        watches.push({ id, spec });
        return id;
      },
      watch_stop: () => undefined,
    },
    { settings: { views: [VIEW] } },
  );
  useAppStore.getState().setActiveCluster("c1");
});
afterEach(() => {
  backend.restore();
  vi.restoreAllMocks();
});

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

const pod = (name: string): KubeObject => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name, namespace: "shop", uid: `uid-${name}`, resourceVersion: "1" },
  spec: { containers: [{ name: "app" }] },
  status: { phase: "Running" },
});

describe("saved views in the window", () => {
  it("opens a saved view from the sidebar: label selector asked from the cluster, hidden columns hidden", async () => {
    render(<Cluster />);
    fireEvent.click(await screen.findByRole("button", { name: "Open view Front pods" }));
    await waitFor(() => {
      const watch = watches.find((w) => w.spec.kind.kind === "Pod" && !w.spec.metadataOnly);
      expect(watch?.spec.labelSelector).toBe("tier=front");
    });
    const watch = watches.find((w) => w.spec.kind.kind === "Pod" && !w.spec.metadataOnly)!;
    await waitFor(() => expect(backend.listenerCount(`watch:${watch.id}`)).toBe(1));
    act(() => backend.emit(`watch:${watch.id}`, { type: "snapshot", items: [pod("web-0")] }));
    const table = await screen.findByRole("table");
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).not.toContain("Namespace");
    expect(headers).toContain("Name");
    expect(screen.getByText("Label selector: tier=front")).toBeInTheDocument();

    // The columns menu shows the column again; the store keeps it for the view.
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Columns" })).getByText("Namespace"));
    expect(tableStateOf(useAppStore.getState().clusterViews.c1!, POD_VIEW).hiddenColumns).toEqual([]);

    // Sorting is kept in the store too (what "Save view" captures).
    fireEvent.click(within(table).getByRole("button", { name: "Age" }));
    expect(tableStateOf(useAppStore.getState().clusterViews.c1!, POD_VIEW).sort).toEqual({ column: "age", desc: false });
  });

  it("saves the open table as a view for every cluster, pinned", async () => {
    useAppStore.getState().setView("c1", POD_VIEW);
    useAppStore.getState().setTableState("c1", POD_VIEW, { hiddenColumns: ["node"] });
    render(<Cluster />);
    fireEvent.click(await screen.findByRole("button", { name: "Save view" }));
    const dialog = screen.getByRole("dialog", { name: "Save view" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Pods everywhere" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "All clusters" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Pin to favourites" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(backend.settings.views).toHaveLength(2));
    const saved = backend.settings.views[1]!;
    expect(saved).toMatchObject({ name: "Pods everywhere", cluster: null, kind: "Pod", hiddenColumns: ["node"] });
    expect(backend.settings.pins).toEqual([
      expect.objectContaining({ cluster: "c1", target: { type: "view", view: saved.id } }),
    ]);
    // The favourites strip shows it.
    expect(await screen.findByLabelText("Favourites")).toBeInTheDocument();
  });
});
