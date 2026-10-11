import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, updateSettings, type MockBackend } from "../api";
import { App } from "./App";
import { resetAppStore, useAppStore } from "./store";
import { PERSIST_DELAY_MS } from "./useLayoutPersistence";

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
  it("restores sidebar width and dock height/visibility from the saved settings", async () => {
    mockColorScheme(false);
    backend = mockBackend(
      {},
      { settings: { window: { sidebarWidth: 300, dockHeight: 250, dockOpen: true, lastCluster: null, width: 1400, height: 900, maximized: false } } },
    );
    render(<App />);
    act(() => useAppStore.getState().setActiveCluster("c1"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Dock" })).toHaveStyle({ height: "250px" }));
    expect(screen.getByRole("navigation", { name: "Sections" })).toHaveStyle({ width: "300px" });
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

    await waitFor(() =>
      expect(backend.settings.window).toMatchObject({ dockOpen: true, dockHeight: 316, sidebarWidth: 236, lastCluster: "c1" }),
    );
    // Debounced: several changes, one write.
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(1);
  });
});
