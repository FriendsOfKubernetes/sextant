// Column widths: clamping, the keys of a resize handle, and saving the widths (debounced, per table).
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, mockBackend, type MockBackend } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import {
  clampWidth,
  cleanWidths,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  SAVE_WIDTHS_DELAY_MS,
  applyWidthChanges,
  MAX_TABLES,
  useColumnWidths,
  widthKeyTarget,
  WIDTH_STEP,
  WIDTH_STEP_LARGE,
} from "./columnWidths";

let backend: MockBackend;

beforeEach(async () => {
  resetSettingsCache();
  backend = mockBackend({}, { settings: { columnWidths: { "helm.releases": { columns: { "0": 200 }, used: 1 } } } });
  await loadSettings();
});

afterEach(() => {
  vi.useRealTimers();
  backend.restore();
  resetSettingsCache();
});

const updates = () => backend.calls.filter((c) => c.cmd === "settings_update");

describe("column widths", () => {
  it("clamps widths to the allowed range in whole pixels", () => {
    expect(clampWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampWidth(99_999)).toBe(MAX_COLUMN_WIDTH);
    expect(clampWidth(120.6)).toBe(121);
    expect(clampWidth(Number.NaN)).toBe(MIN_COLUMN_WIDTH);
  });

  it("maps the handle's keys to a width or a reset", () => {
    expect(widthKeyTarget("ArrowRight", false, 100)).toBe(100 + WIDTH_STEP);
    expect(widthKeyTarget("ArrowLeft", false, 100)).toBe(100 - WIDTH_STEP);
    expect(widthKeyTarget("ArrowRight", true, 100)).toBe(100 + WIDTH_STEP_LARGE);
    expect(widthKeyTarget("ArrowLeft", true, 60)).toBe(MIN_COLUMN_WIDTH);
    expect(widthKeyTarget("Home", false, 300)).toBe(MIN_COLUMN_WIDTH);
    expect(widthKeyTarget("End", false, 300)).toBe(MAX_COLUMN_WIDTH);
    expect(widthKeyTarget("Enter", false, 300)).toBe("reset");
    expect(widthKeyTarget("a", false, 300)).toBeNull();
  });

  it("reads saved widths leniently", () => {
    expect(cleanWidths({ columns: { a: 10, b: "x", c: 5000, "": 100 }, used: 1 })).toEqual({
      a: MIN_COLUMN_WIDTH,
      c: MAX_COLUMN_WIDTH,
    });
    expect(cleanWidths({ columns: [1, 2] })).toEqual({});
    expect(cleanWidths({ a: 100 })).toEqual({});
    expect(cleanWidths(null)).toEqual({});
  });

  it("reads a table's saved widths and saves a change once the user paused", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useColumnWidths("helm.releases"));
    expect(result.current.widths).toEqual({ "0": 200 });
    act(() => result.current.setWidth("1", 10));
    act(() => result.current.setWidth("1", 150));
    // Shown at once, written later.
    expect(result.current.widths).toEqual({ "0": 200, "1": 150 });
    expect(updates()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_WIDTHS_DELAY_MS);
    });
    expect(updates()).toHaveLength(1);
    expect(backend.settings.columnWidths).toEqual({
      "helm.releases": { columns: { "0": 200, "1": 150 }, used: expect.any(Number) },
    });
    expect(result.current.widths).toEqual({ "0": 200, "1": 150 });
  });

  it("resets one column or the whole table, and drops the table's entry when nothing is left", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useColumnWidths("helm.releases"));
    act(() => result.current.setWidth("1", 120));
    act(() => result.current.setWidth("0", null));
    expect(result.current.widths).toEqual({ "1": 120 });
    act(() => result.current.reset());
    expect(result.current.customized).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_WIDTHS_DELAY_MS);
    });
    expect(updates()).toHaveLength(1);
    expect(backend.settings.columnWidths).toEqual({});
  });

  it("writes a pending change when the table goes away, and never saves a table without an id", async () => {
    const { result, unmount } = renderHook(() => useColumnWidths("portforward"));
    act(() => result.current.setWidth("2", 90));
    unmount();
    await vi.waitFor(() => expect(backend.settings.columnWidths?.portforward?.columns).toEqual({ "2": 90 }));

    const local = renderHook(() => useColumnWidths(null));
    act(() => local.result.current.setWidth("0", 300));
    expect(local.result.current.widths).toEqual({ "0": 300 });
    local.unmount();
    await new Promise((r) => setTimeout(r, SAVE_WIDTHS_DELAY_MS + 50));
    expect(updates()).toHaveLength(1);
  });

  it("merges per column: two tables of the same id keep each other's widths", async () => {
    vi.useFakeTimers();
    const one = renderHook(() => useColumnWidths("kind:/Pod"));
    const two = renderHook(() => useColumnWidths("kind:/Pod"));
    act(() => one.result.current.setWidth("name", 300));
    act(() => two.result.current.setWidth("age", 90));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_WIDTHS_DELAY_MS);
    });
    expect(backend.settings.columnWidths?.["kind:/Pod"]?.columns).toEqual({ name: 300, age: 90 });
    // Both read the merged widths back.
    expect(one.result.current.widths).toEqual({ name: 300, age: 90 });
    expect(two.result.current.widths).toEqual({ name: 300, age: 90 });
  });

  it("keeps the most recently changed tables past the cap, never the one just changed", () => {
    const all = Object.fromEntries(
      Array.from({ length: MAX_TABLES }, (_, i) => [`t-${i}`, { columns: { "0": 100 }, used: 1000 + i }]),
    );
    const next = applyWidthChanges(all, "zz-new", { clear: false, set: { "0": 120 } }, 5000);
    expect(Object.keys(next)).toHaveLength(MAX_TABLES);
    expect(next["zz-new"]).toEqual({ columns: { "0": 120 }, used: 5000 });
    // The least recently changed one went.
    expect(next["t-0"]).toBeUndefined();
    expect(next["t-1"]).toBeDefined();

    // A change of an existing table refreshes its time and merges its columns.
    const merged = applyWidthChanges(next, "t-1", { clear: false, set: { "1": 80, "0": null } }, 6000);
    expect(merged["t-1"]).toEqual({ columns: { "1": 80 }, used: 6000 });
    // A reset drops the table.
    expect(applyWidthChanges(merged, "t-1", { clear: true, set: {} }, 7000)["t-1"]).toBeUndefined();
  });
});
