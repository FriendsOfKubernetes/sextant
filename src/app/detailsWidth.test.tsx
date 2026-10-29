import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, mockBackend, updateSettings, useSettings, type MockBackend } from "../api";
import { resetAppStore, useAppStore } from "./store";
import { PERSIST_DELAY_MS, useLayoutPersistence } from "./useLayoutPersistence";

let backend: MockBackend;
beforeEach(() => { resetAppStore(); vi.useFakeTimers(); backend = mockBackend(); });
afterEach(() => { cleanup(); backend.restore(); vi.useRealTimers(); });

function Host() {
  const { settings } = useSettings();
  useLayoutPersistence(settings);
  return null;
}
const tick = () => act(() => vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS + 1));

describe("details width preferences", () => {
  it("defaults to independent persistent resource kinds", () => {
    const state = useAppStore.getState();
    expect(state.detailsWidthScope).toBe("kind");
    expect(state.detailsWidthSessionOnly).toBe(false);
    expect(state.detailsWidths).toEqual({});
  });

  it("keeps the global bank and each group/kind independent, without duplicate updates", () => {
    const state = useAppStore.getState();
    state.setDetailsWidth("/Pod", 600);
    state.setDetailsWidth("apps/Deployment", 850);
    state.setDetailsWidth("custom/Deployment", 900);
    state.setDetailsWidthPreferences("global", false, {});
    state.setDetailsWidth("/Pod", 1000);
    state.setDetailsWidthPreferences("kind", false, {});
    expect(useAppStore.getState().detailsWidths).toEqual({ "/Pod": 600, "apps/Deployment": 850, "custom/Deployment": 900, "*": 1000 });
    const changed = vi.fn();
    const unsubscribe = useAppStore.subscribe(changed);
    state.setDetailsWidth("/Pod", 600.1);
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("enforces the minimum and integer pixels, and refuses non-finite sizes", () => {
    const state = useAppStore.getState();
    state.setDetailsWidth("/Pod", -20);
    expect(useAppStore.getState().detailsWidths["/Pod"]).toBe(480);
    state.setDetailsWidth("/Pod", 700.8);
    state.setDetailsWidth("/Pod", Number.NaN);
    state.setDetailsWidth("/Pod", Number.POSITIVE_INFINITY);
    expect(useAppStore.getState().detailsWidths["/Pod"]).toBe(701);
  });

  it("debounces widths and preserves unrelated settings and inactive kinds", async () => {
    backend.settings.window.detailsWidths = { "/Pod": 600, "/Node": 900 };
    backend.settings.window.width = 1400;
    await act(async () => { render(<Host />); });
    expect(useAppStore.getState().detailsWidths["/Pod"]).toBe(600);
    act(() => {
      useAppStore.getState().setDetailsWidth("/Pod", 750);
      useAppStore.getState().setDetailsWidth("/Pod", 800);
    });
    expect(backend.calls.filter(c => c.cmd === "settings_update")).toHaveLength(0);
    await act(() => updateSettings(s => ({ ...s, appearance: { ...s.appearance, sidebarGuides: true } })));
    await tick();
    expect(backend.settings.window.detailsWidths).toEqual({ "/Pod": 800, "/Node": 900 });
    expect(backend.settings.window.width).toBe(1400);
    expect(backend.settings.appearance.sidebarGuides).toBe(true);
    expect(backend.calls.filter(c => c.cmd === "settings_update")).toHaveLength(2);
  });

  it("cancels a pending width save in session mode, and saves current edits when resumed", async () => {
    backend.settings.window.detailsWidths = { "/Pod": 600, "/Node": 900 };
    await act(async () => { render(<Host />); });
    act(() => useAppStore.getState().setDetailsWidth("/Pod", 800));
    await act(() => updateSettings(s => ({ ...s, appearance: { ...s.appearance, detailsWidthSessionOnly: true } })));
    await tick();
    act(() => useAppStore.getState().setDetailsWidth("/Pod", 850));
    await tick();
    expect(useAppStore.getState().detailsWidths["/Pod"]).toBe(850);
    expect(backend.settings.window.detailsWidths).toEqual({ "/Pod": 600, "/Node": 900 });
    expect(backend.calls.filter(c => c.cmd === "settings_update")).toHaveLength(1);
    await act(() => updateSettings(s => ({ ...s, appearance: { ...s.appearance, detailsWidthSessionOnly: false } })));
    await tick();
    expect(backend.settings.window.detailsWidths).toEqual({ "/Pod": 850, "/Node": 900 });
  });

  it("starts a session-only launch without reading or overwriting saved widths", async () => {
    backend.settings.appearance.detailsWidthSessionOnly = true;
    backend.settings.window.detailsWidths = { "/Pod": 600, "/Node": 900 };
    const view = await act(async () => render(<Host />));
    expect(useAppStore.getState().detailsWidths).toEqual({});
    act(() => useAppStore.getState().setDetailsWidth("/Pod", 850));
    await tick();
    expect(backend.calls.filter(c => c.cmd === "settings_update")).toHaveLength(0);
    const saved = structuredClone(backend.settings);
    view.unmount(); backend.restore(); resetAppStore(); backend = mockBackend({}, { settings: saved });
    await act(async () => { render(<Host />); });
    expect(useAppStore.getState().detailsWidths).toEqual({});
    expect(backend.settings.window.detailsWidths).toEqual({ "/Pod": 600, "/Node": 900 });
  });

  it("restores persisted values on a fresh launch, using defaults for old files", () => {
    const settings = defaultAppSettings();
    settings.window.detailsWidths = { "/Pod": 900 };
    settings.appearance.detailsWidthScope = "global";
    useAppStore.getState().hydrateLayout(settings.window, settings.appearance);
    expect(useAppStore.getState().detailsWidths).toEqual({ "/Pod": 900 });
    expect(useAppStore.getState().detailsWidthScope).toBe("global");
    Reflect.deleteProperty(settings.window, "detailsWidths");
    useAppStore.getState().hydrateLayout(settings.window);
    expect(useAppStore.getState().detailsWidths).toEqual({});
    expect(useAppStore.getState().detailsWidthScope).toBe("kind");
    expect(useAppStore.getState().detailsWidthSessionOnly).toBe(false);
  });

  it("retains the current width if a write fails, and can save a later adjustment", async () => {
    backend.settings.window.detailsWidths = { "/Pod": 600 };
    backend.on("settings_update", () => { throw new Error("disk full"); });
    await act(async () => { render(<Host />); });
    act(() => useAppStore.getState().setDetailsWidth("/Pod", 800));
    await tick();
    expect(useAppStore.getState().detailsWidths["/Pod"]).toBe(800);
    expect(backend.settings.window.detailsWidths["/Pod"]).toBe(600);
    expect(backend.calls.filter(c => c.cmd === "settings_update")).toHaveLength(1);
    backend.on("settings_update", args => { Object.assign(backend.settings, args.settings); return structuredClone(backend.settings); });
    act(() => useAppStore.getState().setDetailsWidth("/Pod", 850));
    await tick();
    expect(backend.settings.window.detailsWidths["/Pod"]).toBe(850);
  });
});
