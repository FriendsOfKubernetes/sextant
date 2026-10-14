import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend } from "../api";
import { resetAppStore, useAppStore } from "../app/store";
import { AppShell } from "./AppShell";
import { registerDetailsSection, unregisterDetailsSection, type DetailsSectionProps } from "./details/registry";
import { registerDockAction, registerDockTab, unregisterDockAction, unregisterDockTab, type DockTabProps } from "./dock/registry";
import { registerPage, unregisterPage } from "./pages";
import { registerSlot, unregisterSlot } from "./slots";

const pod = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "default", name: "web-1" };
let backend: MockBackend;

beforeEach(() => {
  resetAppStore();
  backend = mockBackend({ resource_get: () => ({ metadata: { name: "web-1", uid: "u1" } }) });
});
afterEach(() => backend.restore());

function withCluster() {
  act(() => useAppStore.getState().setActiveCluster("c1"));
}

describe("AppShell", () => {
  it("shows the five zones: cluster rail, sidebar, main, details panel, dock", () => {
    render(<AppShell />);
    withCluster();
    act(() => useAppStore.getState().openDetails(pod));
    expect(screen.getByRole("navigation", { name: "Clusters" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Dock" })).toBeInTheDocument();
  });

  it("without an active cluster shows the welcome slot instead of the sidebar", () => {
    function Welcome() {
      return <p>no clusters here</p>;
    }
    registerSlot("welcome", Welcome);
    try {
      render(<AppShell />);
      expect(screen.queryByRole("navigation", { name: "Sections" })).not.toBeInTheDocument();
      expect(screen.getByRole("main")).toHaveTextContent("no clusters here");
    } finally {
      unregisterSlot("welcome");
    }
  });

  it("shows the confirmation dialog of agents and extensions once, outside the cluster rail", async () => {
    backend.on("mcp_confirm_answer", () => undefined);
    render(<AppShell />);
    await vi.waitFor(() => expect(backend.listenerCount("mcp-confirm")).toBe(1));
    act(() =>
      backend.emit("mcp-confirm", {
        id: "r1",
        source: "extension",
        principal: "Extension Widgets",
        client: "demo.widgets",
        clusterId: "c1",
        clusterName: "kind-test",
        tool: "resources.delete",
        target: "Widget team-a/w1",
        details: null,
      }),
    );
    const dialog = screen.getByRole("alertdialog", { name: "An extension asks to act" });
    expect(screen.getByRole("navigation", { name: "Clusters" })).not.toContainElement(dialog);
  });

  it("draws every component registered for the rail footer, in order", () => {
    const Second = () => <button>second</button>;
    const First = () => <button>first</button>;
    registerSlot("railFooter", Second, 10);
    registerSlot("railFooter", First);
    try {
      render(<AppShell />);
      const rail = screen.getByRole("navigation", { name: "Clusters" });
      const names = within(rail).getAllByRole("button").map((b) => b.textContent);
      expect(names.slice(-2)).toEqual(["first", "second"]);
    } finally {
      unregisterSlot("railFooter", First);
      unregisterSlot("railFooter", Second);
    }
  });

  it("renders the cluster rail slot", () => {
    registerSlot("clusterRail", () => <button>cluster-a</button>);
    try {
      render(<AppShell />);
      const rail = screen.getByRole("navigation", { name: "Clusters" });
      expect(within(rail).getByRole("button", { name: "cluster-a" })).toBeInTheDocument();
    } finally {
      unregisterSlot("clusterRail");
    }
  });

  it("opens the details panel for an object and closes it with the close button and Escape", async () => {
    render(<AppShell />);
    withCluster();
    expect(screen.queryByRole("complementary", { name: "Details" })).not.toBeInTheDocument();

    act(() => useAppStore.getState().openDetails(pod));
    const panel = screen.getByRole("complementary", { name: "Details" });
    expect(within(panel).getByRole("heading", { name: "web-1" })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("complementary", { name: "Details" })).not.toBeInTheDocument();

    act(() => useAppStore.getState().openDetails(pod));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Details" })).not.toBeInTheDocument();
  });

  it("details panel shows registered sections that apply to the kind, in order, with the object", async () => {
    function Meta({ obj }: DetailsSectionProps) {
      return <p>meta of {String(obj?.metadata?.name ?? "…")}</p>;
    }
    registerDetailsSection({ id: "t-meta", order: 20, appliesTo: () => true, Component: Meta });
    registerDetailsSection({ id: "t-first", order: 10, appliesTo: () => true, Component: () => <p>first</p> });
    registerDetailsSection({ id: "t-nodes", order: 5, appliesTo: (k) => k.kind === "Node", Component: () => <p>node only</p> });
    try {
      render(<AppShell />);
      withCluster();
      act(() => useAppStore.getState().openDetails(pod));
      const panel = screen.getByRole("complementary", { name: "Details" });
      expect(await within(panel).findByText("meta of web-1")).toBeInTheDocument();
      const texts = [...panel.querySelectorAll("[data-section]")].map((s) => s.getAttribute("data-section"));
      expect(texts).toEqual(["t-first", "t-meta"]);
      expect(within(panel).queryByText("node only")).not.toBeInTheDocument();
      expect(backend.calls).toContainEqual({ cmd: "resource_get", args: { clusterId: "c1", ref: pod } });
    } finally {
      unregisterDetailsSection("t-meta");
      unregisterDetailsSection("t-first");
      unregisterDetailsSection("t-nodes");
    }
  });

  it("details panel shows the error of the object source", async () => {
    backend.on("resource_get", () => {
      throw { code: "forbidden", message: "pods is forbidden" };
    });
    render(<AppShell />);
    withCluster();
    act(() => useAppStore.getState().openDetails(pod));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You don't have permission to do this (403).");
    expect(alert).toHaveTextContent("pods is forbidden");
  });

  it("dock opens and closes with its toggle", () => {
    render(<AppShell />);
    const dock = screen.getByRole("region", { name: "Dock" });
    fireEvent.click(within(dock).getByRole("button", { name: "Open dock" }));
    expect(useAppStore.getState().dock.open).toBe(true);
    expect(screen.getByRole("separator", { name: "Resize dock" })).toBeInTheDocument();
    fireEvent.click(within(dock).getByRole("button", { name: "Close dock" }));
    expect(useAppStore.getState().dock.open).toBe(false);
    expect(screen.queryByRole("separator", { name: "Resize dock" })).not.toBeInTheDocument();
  });

  it("dock height changes by dragging the splitter up and down", () => {
    act(() => {
      useAppStore.getState().setDockOpen(true);
      useAppStore.getState().setDockHeight(300);
    });
    render(<AppShell />);
    const splitter = screen.getByRole("separator", { name: "Resize dock" });
    fireEvent.pointerDown(splitter, { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(splitter, { clientY: 400, pointerId: 1 });
    expect(useAppStore.getState().dock.height).toBe(400);
    expect(screen.getByRole("region", { name: "Dock" })).toHaveStyle({ height: "400px" });

    fireEvent.pointerDown(splitter, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientY: 450, pointerId: 1 });
    fireEvent.pointerUp(splitter, { pointerId: 1 });
    expect(useAppStore.getState().dock.height).toBe(350);

    fireEvent.keyDown(splitter, { key: "ArrowUp" });
    expect(useAppStore.getState().dock.height).toBe(366);
  });

  it("sidebar width changes by dragging its splitter", () => {
    render(<AppShell />);
    withCluster();
    const splitter = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.pointerDown(splitter, { clientX: 292, pointerId: 1 });
    fireEvent.pointerMove(splitter, { clientX: 352, pointerId: 1 });
    fireEvent.pointerUp(splitter, { pointerId: 1 });
    expect(useAppStore.getState().sidebarWidth).toBe(280);
    expect(screen.getByRole("navigation", { name: "Sections" })).toHaveStyle({ width: "280px" });
  });

  it("dock renders registered tab components and header actions", () => {
    function LogsTab({ tab, active }: DockTabProps) {
      return <p>logs of {tab.title} {active ? "(active)" : ""}</p>;
    }
    registerDockTab("logs", LogsTab);
    let ran = 0;
    registerDockAction({ id: "t-create", order: 1, labelKey: "common:actions.confirm", icon: "add", run: () => ran++ });
    try {
      render(<AppShell />);
      act(() => {
        useAppStore.getState().openDockTab({ id: "l1", type: "logs", title: "web-1", payload: null });
      });
      const dock = screen.getByRole("region", { name: "Dock" });
      expect(within(dock).getByRole("tab", { name: "web-1" })).toHaveAttribute("aria-selected", "true");
      expect(within(dock).getByText("logs of web-1 (active)")).toBeInTheDocument();
      fireEvent.click(within(dock).getByRole("button", { name: "Confirm" }));
      expect(ran).toBe(1);
      fireEvent.click(within(dock).getByRole("button", { name: "Close tab web-1" }));
      expect(within(dock).queryByText(/logs of web-1/)).not.toBeInTheDocument();
    } finally {
      unregisterDockTab("logs");
      unregisterDockAction("t-create");
    }
  });

  it("sidebar lists registered pages and the main view renders the chosen one", () => {
    registerPage({
      id: "t-overview",
      section: "cluster",
      order: 1,
      labelKey: "common:app.name",
      Component: ({ clusterId }) => <p>overview of {clusterId}</p>,
    });
    try {
      render(<AppShell />);
      withCluster();
      const sidebar = screen.getByRole("navigation", { name: "Sections" });
      fireEvent.click(within(sidebar).getByRole("button", { name: "Sextant" }));
      expect(screen.getByRole("main")).toHaveTextContent("overview of c1");
      expect(useAppStore.getState().clusterViews.c1?.view).toBe("t-overview");
    } finally {
      unregisterPage("t-overview");
    }
  });

  describe("narrow window (up to 768 px)", () => {
    let width = 1280;
    const listeners = new Set<() => void>();
    const original = window.matchMedia;

    function resizeTo(next: number) {
      width = next;
      act(() => {
        for (const fn of listeners) fn();
      });
    }

    beforeEach(() => {
      width = 1280;
      listeners.clear();
      // jsdom has no layout: answer max-width queries from `width`.
      window.matchMedia = ((query: string) => {
        const max = /max-width:\s*(\d+)px/.exec(query);
        return {
          get matches() {
            return max ? width <= Number(max[1]) : false;
          },
          media: query,
          onchange: null,
          addEventListener: (_: string, fn: () => void) => listeners.add(fn),
          removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
          addListener: (fn: () => void) => listeners.add(fn),
          removeListener: (fn: () => void) => listeners.delete(fn),
          dispatchEvent: () => true,
        };
      }) as unknown as typeof window.matchMedia;
    });
    afterEach(() => {
      window.matchMedia = original;
    });

    function menuOf(button: HTMLElement): HTMLElement {
      const id = button.getAttribute("aria-controls");
      const menu = id ? document.getElementById(id) : null;
      if (!menu) throw new Error("the menu button controls no element");
      return menu;
    }

    it("moves the cluster rail and the sidebar into a menu that closes when a section is chosen", () => {
      registerPage({ id: "t-page", section: "cluster", order: 1, labelKey: "common:app.name", Component: () => <p>the page</p> });
      try {
        width = 400;
        render(<AppShell />);
        withCluster();
        const button = screen.getByRole("button", { name: "Open menu" });
        expect(button).toHaveAttribute("aria-expanded", "false");
        const menu = menuOf(button);
        expect(menu).toHaveAttribute("data-open", "false");
        expect(within(menu).getByRole("navigation", { name: "Clusters" })).toBeInTheDocument();
        expect(within(menu).getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
        expect(screen.queryByRole("separator", { name: "Resize sidebar" })).not.toBeInTheDocument();

        fireEvent.click(button);
        expect(menu).toHaveAttribute("data-open", "true");
        expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");

        fireEvent.click(within(menu).getByRole("button", { name: "Sextant" }));
        expect(screen.getByRole("main")).toHaveTextContent("the page");
        expect(menu).toHaveAttribute("data-open", "false");
      } finally {
        unregisterPage("t-page");
      }
    });

    it("keeps the details panel and the dock reachable, and Escape closes the menu", () => {
      width = 360;
      render(<AppShell />);
      withCluster();
      act(() => useAppStore.getState().openDetails(pod));
      expect(screen.getByRole("complementary", { name: "Details" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Dock" })).toBeInTheDocument();

      const button = screen.getByRole("button", { name: "Open menu" });
      fireEvent.click(button);
      expect(menuOf(button)).toHaveAttribute("data-open", "true");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(menuOf(button)).toHaveAttribute("data-open", "false");
    });

    it("follows the window width: wide shows the rail and sidebar again", () => {
      render(<AppShell />);
      withCluster();
      expect(screen.queryByRole("button", { name: "Open menu" })).not.toBeInTheDocument();
      expect(screen.getByRole("separator", { name: "Resize sidebar" })).toBeInTheDocument();

      resizeTo(700);
      expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
      expect(screen.queryByRole("separator", { name: "Resize sidebar" })).not.toBeInTheDocument();

      resizeTo(1024);
      expect(screen.queryByRole("button", { name: "Open menu" })).not.toBeInTheDocument();
      expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    });
  });
});
