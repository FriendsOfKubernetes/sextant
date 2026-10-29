import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, updateSettings, useWatch, type MockBackend } from "../api";
import { App } from "./App";
import { resetAppStore, useAppStore } from "./store";
import { PERSIST_DELAY_MS } from "./useLayoutPersistence";
import { registerDetailsSection, unregisterDetailsSection } from "../layout/details/registry";
import { resetNamespaceRestore } from "../features/namespaces";
import { resetClusterKinds } from "../resources";

const tableRenders = vi.hoisted(() => vi.fn());
vi.mock("../components/Table", async (original) => {
  const table = await original<typeof import("../components/Table")>();
  return { ...table, ResourceTable: (props: Parameters<typeof table.ResourceTable>[0]) => {
    tableRenders();
    return <table.ResourceTable {...props} />;
  } };
});

/** A controllable `prefers-color-scheme: dark` media query. */
function mockColorScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    set(next: boolean) {
      dark = next;
      for (const fn of listeners) fn();
    },
  };
}

const theme = () => document.documentElement.dataset.theme;
let backend: MockBackend;

beforeEach(() => {
  resetAppStore();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  backend.restore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("theme", () => {
  it("system mode follows the OS theme, including changes while running", async () => {
    const os = mockColorScheme(true);
    backend = mockBackend({}, { settings: { theme: "system" } });
    render(<App />);
    await waitFor(() => expect(theme()).toBe("dark"));
    act(() => os.set(false));
    expect(theme()).toBe("light");
    act(() => os.set(true));
    expect(theme()).toBe("dark");
  });

  it("an explicit theme ignores the OS; settings_update with dark/light applies and saves it", async () => {
    const os = mockColorScheme(false);
    backend = mockBackend({}, { settings: { theme: "light" } });
    render(<App />);
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "settings_get")).toBe(true));
    await waitFor(() => expect(theme()).toBe("light"));

    await act(() => updateSettings((s) => ({ ...s, theme: "dark" })));
    expect(theme()).toBe("dark");
    expect(backend.settings.theme).toBe("dark");
    act(() => os.set(false));
    expect(theme()).toBe("dark");

    await act(() => updateSettings((s) => ({ ...s, theme: "light" })));
    expect(theme()).toBe("light");
    expect(backend.settings.theme).toBe("light");
  });
});

describe("window layout across restarts", () => {
  it("saving a details width does not rerender the main table or restart the active details subscription", async () => {
    mockColorScheme(false);
    resetNamespaceRestore();
    resetClusterKinds();
    backend = mockBackend({
      cluster_kinds: () => [{ kindRef: { group: "", version: "v1", kind: "Pod" }, plural: "pods", namespaced: true, verbs: ["list", "watch"], printerColumns: [] }],
      watch_start: args => {
        const items = (args.spec as { kind: { kind: string } }).kind.kind === "Pod"
          ? [{ apiVersion: "v1", kind: "Pod", metadata: { uid: "web", name: "web", namespace: "apps" } }] : [];
        queueMicrotask(() => backend.emit(`watch:${args.streamId}`, { type: "snapshot", items }));
        return args.streamId;
      },
      watch_stop: () => undefined,
    });
    registerDetailsSection({ id: "details-width-watch", placement: "tab", label: "Width subscription", order: 1, appliesTo: () => true, Component: () => {
      useWatch("c1", { kind: { group: "", version: "v1", kind: "Pod" }, namespaces: null, labelSelector: null, fieldSelector: null });
      return <input aria-label="Width draft" defaultValue="keep me" />;
    } });
    try {
      render(<App />);
      await waitFor(() => expect(backend.calls.some(c => c.cmd === "settings_get")).toBe(true));
      act(() => { useAppStore.getState().setActiveCluster("c1"); useAppStore.getState().setView("c1", "kind:/Pod"); });
      // jsdom has no viewport for virtual rows; the real table's counter proves its snapshot is loaded.
      await within(await screen.findByRole("region", { name: "Pods" })).findByText("1 item");
      act(() => useAppStore.getState().openDetails({ kind: { group: "", version: "v1", kind: "Pod" }, namespace: "apps", name: "web" }));
      fireEvent.click(await screen.findByRole("tab", { name: "Width subscription" }));
      const input = screen.getByRole("textbox", { name: "Width draft" });
      const body = input.closest(".details__body") as HTMLElement;
      body.scrollTop = 250;
      await new Promise(resolve => setTimeout(resolve, PERSIST_DELAY_MS + 100));
      tableRenders.mockClear();
      const calls = backend.calls.filter(c => c.cmd === "watch_start" || c.cmd === "watch_stop").length;
      act(() => useAppStore.getState().setDetailsWidth("/Pod", 800));
      await waitFor(() => expect(backend.settings.window.detailsWidths["/Pod"]).toBe(800));
      expect(tableRenders).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "Width draft" })).toBe(input);
      expect(input).toHaveValue("keep me");
      expect(body.scrollTop).toBe(250);
      expect(screen.getByRole("tab", { name: "Width subscription" })).toHaveAttribute("aria-selected", "true");
      expect(backend.calls.filter(c => c.cmd === "watch_start" || c.cmd === "watch_stop")).toHaveLength(calls);
    } finally { act(() => unregisterDetailsSection("details-width-watch")); }
  });
  it("restores sidebar width, dock height/visibility and the expanded rail from the saved settings", async () => {
    mockColorScheme(false);
    backend = mockBackend(
      {},
      { settings: { window: { sidebarWidth: 300, detailsWidths: {}, dockHeight: 250, dockOpen: true, lastCluster: null, width: 1400, height: 900, maximized: false, railExpanded: true } } },
    );
    render(<App />);
    act(() => useAppStore.getState().setActiveCluster("c1"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Dock" })).toHaveStyle({ height: "250px" }));
    expect(screen.getByRole("navigation", { name: "Sections" })).toHaveStyle({ width: "300px" });
    expect(screen.getByRole("navigation", { name: "Clusters" })).toHaveClass("rail--expanded");
    expect(screen.getByRole("button", { name: "Collapse cluster list" })).toHaveAttribute("aria-expanded", "true");
  });

  it("saves dock and sidebar changes into settings.window", async () => {
    mockColorScheme(false);
    backend = mockBackend();
    render(<App />);
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "settings_get")).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Open dock" })).toBeInTheDocument());
    // Hydration itself must not write anything.
    await new Promise((r) => setTimeout(r, PERSIST_DELAY_MS + 50));
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(0);

    act(() => useAppStore.getState().setActiveCluster("c1"));
    fireEvent.click(within(screen.getByRole("region", { name: "Dock" })).getByRole("button", { name: "Open dock" }));
    const splitter = screen.getByRole("separator", { name: "Resize dock" });
    fireEvent.keyDown(splitter, { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize sidebar" }), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Expand cluster list" }));

    await waitFor(() =>
      expect(backend.settings.window).toMatchObject({
        dockOpen: true,
        dockHeight: 316,
        sidebarWidth: 236,
        lastCluster: "c1",
        railExpanded: true,
      }),
    );
    // Debounced: several changes, one write.
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(1);
  });
});

describe("streams of a previous page", () => {
  it("are closed once at load, before the first stream of this page starts", async () => {
    mockColorScheme(false);
    let answer: () => void = () => undefined;
    backend = mockBackend({
      streams_reset: () => new Promise<void>((resolve) => (answer = resolve)),
      watch_start: () => undefined,
      watch_stop: () => undefined,
    });
    const spec = { kind: { group: "", version: "v1", kind: "Pod" }, namespaces: null, labelSelector: null, fieldSelector: null };
    function Probe() {
      useWatch("c1", spec);
      return null;
    }
    const { rerender } = render(
      <>
        <App />
        <Probe />
      </>,
    );
    rerender(
      <>
        <App />
        <Probe />
      </>,
    );
    await new Promise((r) => setTimeout(r, 20));
    const commands = () => backend.calls.map((c) => c.cmd);
    expect(commands().filter((c) => c === "streams_reset")).toHaveLength(1);
    expect(commands()).not.toContain("watch_start");

    act(() => answer());
    await waitFor(() => expect(commands()).toContain("watch_start"));
    expect(commands().indexOf("streams_reset")).toBeLessThan(commands().indexOf("watch_start"));
  });
});
