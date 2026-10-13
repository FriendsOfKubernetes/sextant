import { beforeEach, describe, expect, it } from "vitest";
import { DOCK_MIN_HEIGHT, SIDEBAR_MAX_WIDTH, resetAppStore, useAppStore } from "./store";

const ref = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "default", name: "web-1" };

beforeEach(() => resetAppStore());

describe("app store", () => {
  it("keeps view, namespaces and search per cluster", () => {
    const s = useAppStore.getState();
    s.setView("a", "pods");
    s.setNamespaces("a", ["default"]);
    s.setView("b", "nodes");
    s.setSearch("b", "web");
    const { clusterViews } = useAppStore.getState();
    expect(clusterViews.a).toEqual({ view: "pods", namespaces: ["default"], search: "" });
    expect(clusterViews.b).toEqual({ view: "nodes", namespaces: null, search: "web" });
  });

  it("opens and closes details", () => {
    useAppStore.getState().openDetails(ref);
    expect(useAppStore.getState().details).toEqual(ref);
    useAppStore.getState().closeDetails();
    expect(useAppStore.getState().details).toBeNull();
  });

  it("opening a dock tab shows the dock and activates the tab; reopening an id does not duplicate it", () => {
    const s = useAppStore.getState();
    const first = s.openDockTab({ type: "logs", title: "web-1", payload: { pod: ref } });
    const second = s.openDockTab({ id: "term-a", type: "terminal", title: "Terminal", payload: null });
    expect(useAppStore.getState().dock.open).toBe(true);
    expect(useAppStore.getState().dock.activeTabId).toBe(second);
    s.openDockTab({ id: first, type: "logs", title: "web-1", payload: null });
    const { dock } = useAppStore.getState();
    expect(dock.tabs.map((t) => t.id)).toEqual([first, "term-a"]);
    expect(dock.activeTabId).toBe(first);
  });

  it("closing the active tab activates its neighbour", () => {
    const s = useAppStore.getState();
    s.openDockTab({ id: "t1", type: "logs", title: "1", payload: null });
    s.openDockTab({ id: "t2", type: "logs", title: "2", payload: null });
    s.openDockTab({ id: "t3", type: "logs", title: "3", payload: null });
    s.setActiveDockTab("t2");
    s.closeDockTab("t2");
    expect(useAppStore.getState().dock.activeTabId).toBe("t3");
    s.closeDockTab("t3");
    expect(useAppStore.getState().dock.activeTabId).toBe("t1");
    s.closeDockTab("t1");
    expect(useAppStore.getState().dock).toMatchObject({ tabs: [], activeTabId: null });
  });

  it("clamps panel sizes", () => {
    const s = useAppStore.getState();
    s.setDockHeight(10);
    s.setSidebarWidth(5000);
    expect(useAppStore.getState().dock.height).toBe(DOCK_MIN_HEIGHT);
    expect(useAppStore.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("hydrates the saved window layout", () => {
    useAppStore.getState().hydrateLayout({
      sidebarWidth: 300,
      dockHeight: 250,
      dockOpen: true,
      lastCluster: null,
      width: null,
      height: null,
      maximized: false,
      railExpanded: false,
    });
    const s = useAppStore.getState();
    expect(s.sidebarWidth).toBe(300);
    expect(s.dock).toMatchObject({ open: true, height: 250 });
  });
});
