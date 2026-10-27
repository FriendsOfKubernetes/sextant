import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, getSettingsSnapshot, loadSettings, mockBackend, updateSettings, withBackendSettingsChange, type AppSettings } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import type { TableFilters } from "../../api/generated/TableFilters";
import { resetAppStore, useAppStore } from "../../app/store";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { EMPTY_TABLE_FILTERS } from "./model";
import { getTableFilters, resetTableFiltersState, setTableFilters, useTableFilters } from "./state";
import { TableFilterLimitError } from "./validation";

const POD = "kind:/Pod";
const DEPLOYMENT = "kind:apps/Deployment";
const selected = (value: string): TableFilters => ({
  columns: { owner: { values: { mode: "exclude", values: [value] }, condition: null } }, advanced: null,
});
const stored = (map: Record<string, TableFilters>): Partial<AppSettings> => ({
  clusters: { c1: { ...defaultClusterSettings(), tableFilters: map } },
});

beforeEach(() => {
  resetTableFiltersState();
  resetSettingsCache();
  resetAppStore();
});
afterEach(() => {
  resetTableFiltersState();
  resetSettingsCache();
  resetAppStore();
});

describe("resource table filter state", () => {
  it("reads persisted filters after a restart and uses empty defaults without starting a load", async () => {
    const backend = mockBackend({}, { settings: stored({ [POD]: selected("Job") }) });
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    expect(backend.calls).toEqual([]);
    await loadSettings();
    expect(getTableFilters("c1", POD)).toEqual(selected("Job"));
    await setTableFilters("c1", POD, selected("CronJob"));
    resetTableFiltersState();
    resetSettingsCache();
    await loadSettings();
    expect(getTableFilters("c1", POD)).toEqual(selected("CronJob"));
  });

  it("keeps filters across kind navigation, independent clusters and clearing one table", async () => {
    mockBackend();
    await loadSettings();
    await setTableFilters("c1", POD, selected("Job"));
    useAppStore.getState().setView("c1", DEPLOYMENT);
    await setTableFilters("c1", DEPLOYMENT, selected("ReplicaSet"));
    await setTableFilters("c2", POD, selected("CronJob"));
    useAppStore.getState().setView("c1", POD);
    expect(getTableFilters("c1", POD)).toEqual(selected("Job"));
    await setTableFilters("c1", POD, EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", DEPLOYMENT)).toEqual(selected("ReplicaSet"));
    expect(getTableFilters("c2", POD)).toEqual(selected("CronJob"));
  });

  it("publishes the optimistic snapshot before saving and captures it before the lazy settings callback", async () => {
    const backend = mockBackend();
    await loadSettings();
    let release!: (value: AppSettings) => void;
    backend.on("settings_update", ({ settings }) => new Promise<AppSettings>((resolve) => { release = () => resolve(settings as AppSettings); }));
    const blocked = updateSettings((s) => ({ ...s, theme: "dark" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    const next = selected("Job");
    const saving = setTableFilters("c1", POD, next);
    expect(getTableFilters("c1", POD)).toEqual(selected("Job"));
    next.columns.owner!.values!.values.push("mutated after click");
    release(defaultAppSettings());
    await blocked;
    await waitFor(() => expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(2));
    release(defaultAppSettings());
    await saving;
    expect(getSettingsSnapshot()!.theme).toBe("dark");
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters![POD]).toEqual(selected("Job"));
  });

  it("serializes rapid functional edits with concurrent unrelated settings changes", async () => {
    mockBackend({}, { settings: stored({ [DEPLOYMENT]: selected("ReplicaSet") }) });
    await loadSettings();
    const first = setTableFilters("c1", POD, selected("Job"));
    const other = updateSettings((s) => ({ ...s, language: "ru", clusters: { ...s.clusters, c1: { ...s.clusters.c1!, color: "#123456", knownNamespaces: ["team-a"] } } }));
    const second = setTableFilters("c1", POD, (current) => ({
      ...current, columns: { ...current.columns, ready: { values: null, condition: { operator: "eq", value: true } } },
    }));
    expect(getTableFilters("c1", POD).columns.ready).toBeDefined();
    await Promise.all([first, other, second]);
    const settings = getSettingsSnapshot()!;
    expect(settings.language).toBe("ru");
    expect(settings.clusters.c1!.color).toBe("#123456");
    expect(settings.clusters.c1!.knownNamespaces).toEqual(["team-a"]);
    expect(settings.clusters.c1!.tableFilters![DEPLOYMENT]).toEqual(selected("ReplicaSet"));
    expect(settings.clusters.c1!.tableFilters![POD]!.columns).toHaveProperty("ready");
    expect(settings.clusters.c1!.tableFilters![POD]!.columns.owner).toEqual(selected("Job").columns.owner);
  });

  it.each([false, true])("combines rapid functional edits after the initial load (existing filters: %s)", async (existing) => {
    const initial: TableFilters = { columns: { age: { values: null, condition: { operator: "gt", value: 60_000 } } }, advanced: null };
    const saved = { ...defaultAppSettings(), ...stored(existing ? { [POD]: initial } : {}) };
    let finish!: () => void;
    const backend = mockBackend({ settings_get: () => new Promise<AppSettings>((resolve) => { finish = () => resolve(saved); }) });
    const first = setTableFilters("c1", POD, (current) => ({
      ...current, columns: { ...current.columns, ...selected("Job").columns },
    }));
    const second = setTableFilters("c1", POD, (current) => ({
      ...current, columns: { ...current.columns, ready: { values: null, condition: { operator: "eq", value: true } } },
    }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    finish();
    await Promise.all([first, second]);
    expect(getTableFilters("c1", POD).columns).toEqual({
      ...(existing ? initial.columns : {}),
      ...selected("Job").columns,
      ready: { values: null, condition: { operator: "eq", value: true } },
    });
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters![POD]).toEqual(getTableFilters("c1", POD));
    expect(backend.calls.filter((call) => call.cmd === "settings_get")).toHaveLength(1);
  });

  it("copies a plain filter object before waiting for the initial settings load", async () => {
    let finish!: () => void;
    mockBackend({ settings_get: () => new Promise<AppSettings>((resolve) => { finish = () => resolve(defaultAppSettings()); }) });
    const next = selected("Job");
    const saving = setTableFilters("c1", POD, next);
    next.columns.owner!.values!.values.push("caller mutation while loading");
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    finish();
    await saving;
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters![POD]).toEqual(selected("Job"));
  });

  it("retains failed edits with an explicit hook error and retries them with a later same-cluster table write", async () => {
    const backend = mockBackend();
    await loadSettings();
    backend.on("settings_update", () => { throw new Error("disk full"); });
    const hook = renderHook(() => useTableFilters("c1", POD));
    await act(async () => { await expect(setTableFilters("c1", POD, selected("Job"))).rejects.toThrow("disk full"); });
    expect(hook.result.current.filters).toEqual(selected("Job"));
    expect(hook.result.current.error).toBeInstanceOf(Error);
    // A failed filter must survive an unrelated settings save too.
    backend.on("settings_update", ({ settings }) => structuredClone(settings));
    await act(async () => { await updateSettings((s) => ({ ...s, theme: "dark" })); });
    expect(hook.result.current.error).toBeInstanceOf(Error);
    await act(async () => { await setTableFilters("c1", DEPLOYMENT, selected("ReplicaSet")); });
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters).toEqual({ [POD]: selected("Job"), [DEPLOYMENT]: selected("ReplicaSet") });
    expect(hook.result.current.error).toBeNull();
    hook.unmount();
  });

  it("does not let an older failed save mark a newer successful edit as unsaved", async () => {
    const backend = mockBackend();
    await loadSettings();
    let rejectFirst!: (error: Error) => void;
    let calls = 0;
    backend.on("settings_update", ({ settings }) => ++calls === 1
      ? new Promise((_resolve, reject) => { rejectFirst = reject; })
      : structuredClone(settings));
    const first = setTableFilters("c1", POD, selected("Job")).catch(() => undefined);
    await waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
    const second = setTableFilters("c1", POD, selected("CronJob"));
    rejectFirst(new Error("old write failed"));
    await Promise.all([first, second]);
    const hook = renderHook(() => useTableFilters("c1", POD));
    expect(hook.result.current.filters).toEqual(selected("CronJob"));
    expect(hook.result.current.error).toBeNull();
    hook.unmount();
  });

  it("does not replay an already saved edit over a settings import queued between table writes", async () => {
    mockBackend();
    await loadSettings();
    const first = setTableFilters("c1", POD, selected("Job"));
    const imported = updateSettings((s) => ({ ...s, clusters: {
      ...s.clusters, c1: { ...s.clusters.c1!, tableFilters: { [POD]: selected("imported") } },
    } }));
    const second = setTableFilters("c1", DEPLOYMENT, selected("ReplicaSet"));
    await Promise.all([first, imported, second]);
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters).toEqual({ [POD]: selected("imported"), [DEPLOYMENT]: selected("ReplicaSet") });
  });

  it("keeps mounted filter identity across unrelated settings serialization and sees imports or backend reloads", async () => {
    const backend = mockBackend({}, { settings: stored({ [POD]: selected("Job") }) });
    await loadSettings();
    const hook = renderHook(() => useTableFilters("c1", POD));
    const before = hook.result.current.filters;
    await act(async () => { await updateSettings((s) => ({ ...s, theme: "dark" })); });
    expect(hook.result.current.filters).toBe(before);
    await act(async () => { await setTableFilters("c1", POD, selected("CronJob")); });
    backend.on("settings_get", () => ({ ...defaultAppSettings(), ...stored({ [POD]: selected("DaemonSet") }) }));
    await act(async () => { await withBackendSettingsChange(async () => undefined); });
    expect(hook.result.current.filters).toEqual(selected("DaemonSet"));
    await act(async () => { await updateSettings((s) => ({ ...s, clusters: { ...s.clusters, c1: { ...s.clusters.c1!, tableFilters: { [POD]: selected("StatefulSet") } } } })); });
    expect(hook.result.current.filters).toEqual(selected("StatefulSet"));
    hook.unmount();
  });

  it("keeps the optimistic filter identity when the backend stores column keys in sorted order", async () => {
    const backend = mockBackend();
    await loadSettings();
    let finish!: () => void;
    backend.on("settings_update", ({ settings }) => new Promise<AppSettings>((resolve) => {
      const saved = structuredClone(settings as AppSettings);
      const filters = saved.clusters.c1!.tableFilters![POD]!;
      filters.columns = Object.fromEntries(Object.keys(filters.columns).sort().map((key) => [key, filters.columns[key]!]));
      finish = () => resolve(saved);
    }));
    const hook = renderHook(() => useTableFilters("c1", POD));
    let saving!: Promise<void>;
    act(() => { saving = setTableFilters("c1", POD, {
      columns: {
        zebra: { values: null, condition: { operator: "eq", value: "Job" } },
        alpha: { values: null, condition: { operator: "eq", value: true } },
      }, advanced: null,
    }); });
    const optimistic = hook.result.current.filters;
    expect(Object.keys(optimistic.columns)).toEqual(["zebra", "alpha"]);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await act(async () => { finish(); await saving; });
    expect(Object.keys(getSettingsSnapshot()!.clusters.c1!.tableFilters![POD]!.columns)).toEqual(["alpha", "zebra"]);
    expect(hook.result.current.filters).toBe(optimistic);
    hook.unmount();
  });

  it("does not load settings while disabled and reads the right target when navigation enables it", async () => {
    const backend = mockBackend({}, { settings: stored({ [POD]: selected("Job") }) });
    const hook = renderHook(({ enabled, view }) => useTableFilters("c1", view, enabled), { initialProps: { enabled: false, view: DEPLOYMENT } });
    expect(hook.result.current.filters).toBe(EMPTY_TABLE_FILTERS);
    expect(backend.calls).toEqual([]);
    hook.rerender({ enabled: true, view: POD });
    await waitFor(() => expect(hook.result.current.filters).toEqual(selected("Job")));
    await act(async () => { await hook.result.current.setFilters(selected("CronJob")); });
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters![POD]).toEqual(selected("CronJob"));
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters![DEPLOYMENT]).toBeUndefined();
    hook.unmount();
  });

  it("reports initial settings load failures", async () => {
    mockBackend({ settings_get: () => { throw new Error("cannot read settings"); } });
    const hook = renderHook(() => useTableFilters("c1", POD));
    await waitFor(() => expect(hook.result.current.error).toBeInstanceOf(Error));
    expect(hook.result.current.filters).toBe(EMPTY_TABLE_FILTERS);
    hook.unmount();
  });

  it("rejects invalid nested expressions before saving with their precise path", async () => {
    const backend = mockBackend();
    await loadSettings();
    const bad = { columns: {}, advanced: { type: "group", operator: "or", children: [
      { type: "rule", column: "owner", condition: { operator: "eq", value: "Job" } },
      { type: "rule", column: "owner", condition: { operator: "regex", value: "x" } },
    ] } } as unknown as TableFilters;
    await expect(setTableFilters("c1", POD, bad)).rejects.toThrow(/advanced.children\[1\].condition.operator/);
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(0);
  });

  it("does not retain validation-only failures as session records", async () => {
    mockBackend();
    await loadSettings();
    const invalid = { columns: {}, advanced: { type: "rule", column: "owner", condition: { operator: "regex", value: "x" } } } as unknown as TableFilters;
    for (let i = 0; i < 600; i++) await expect(setTableFilters("c1", `kind:/Invalid${i}`, invalid)).rejects.toThrow("unknown operator");
    const hook = renderHook(() => useTableFilters("c1", "kind:/Invalid599"));
    expect(hook.result.current.filters).toBe(EMPTY_TABLE_FILTERS);
    expect(hook.result.current.error).toBeNull();
    hook.unmount();
  });

  it("does not replace an in-flight valid edit when a later edit fails validation", async () => {
    const backend = mockBackend();
    await loadSettings();
    let finish!: () => void;
    let writes = 0;
    backend.on("settings_update", ({ settings }) => ++writes === 1
      ? new Promise<AppSettings>((resolve) => { finish = () => resolve(structuredClone(settings as AppSettings)); })
      : structuredClone(settings));
    const saving = setTableFilters("c1", POD, selected("Job"));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const invalid = { columns: {}, advanced: { type: "rule", column: "owner", condition: { operator: "regex", value: "x" } } } as unknown as TableFilters;
    await expect(setTableFilters("c1", POD, invalid)).rejects.toThrow("unknown operator");
    finish();
    await saving;
    await updateSettings((s) => ({ ...s, clusters: { ...s.clusters, c1: { ...s.clusters.c1!, tableFilters: { [POD]: selected("imported") } } } }));
    expect(getTableFilters("c1", POD)).toEqual(selected("imported"));
    await setTableFilters("c1", DEPLOYMENT, selected("ReplicaSet"));
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters![POD]).toEqual(selected("imported"));
  });

  it("counts valid failed overlays before accepting another table edit", async () => {
    const map = Object.fromEntries(Array.from({ length: 511 }, (_, i) => [`kind:/Kind${i}`, selected("Job")]));
    const backend = mockBackend({}, { settings: stored(map) });
    await loadSettings();
    backend.on("settings_update", () => { throw new Error("disk full"); });
    await expect(setTableFilters("c1", POD, selected("CronJob"))).rejects.toThrow("disk full");
    for (let i = 0; i < 600; i++) {
      const view = `kind:/Rejected${i}`;
      await expect(setTableFilters("c1", view, selected("rejected"))).rejects.toThrow("too many tables");
      expect(getTableFilters("c1", view)).toBe(EMPTY_TABLE_FILTERS);
    }
    expect(getTableFilters("c1", POD)).toEqual(selected("CronJob"));
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(1);
    backend.on("settings_update", ({ settings }) => structuredClone(settings));
    await setTableFilters("c1", POD, selected("CronJob"));
    expect(Object.keys(getSettingsSnapshot()!.clusters.c1!.tableFilters!)).toHaveLength(512);
  });

  it("can clear a failed filter after an import fills the map with other tables", async () => {
    const backend = mockBackend();
    await loadSettings();
    backend.on("settings_update", () => { throw new Error("disk full"); });
    await expect(setTableFilters("c1", POD, selected("Job"))).rejects.toThrow("disk full");
    backend.on("settings_update", ({ settings }) => structuredClone(settings));
    const imported = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`kind:/Imported${i}`, selected("other")]));
    await updateSettings((s) => ({ ...s, ...stored(imported) }));
    expect(getTableFilters("c1", POD)).toEqual(selected("Job"));
    await setTableFilters("c1", POD, EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters).toEqual(imported);
  });

  it("can independently discard two failed filters after a disjoint full-map import without another write", async () => {
    const backend = mockBackend();
    await loadSettings();
    backend.on("settings_update", () => { throw new Error("disk full"); });
    await expect(setTableFilters("c1", POD, selected("Job"))).rejects.toThrow("disk full");
    await expect(setTableFilters("c1", DEPLOYMENT, selected("ReplicaSet"))).rejects.toThrow("disk full");
    backend.on("settings_update", ({ settings }) => structuredClone(settings));
    const imported = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`kind:/Imported${i}`, selected("other")]));
    await updateSettings((s) => ({ ...s, ...stored(imported) }));
    backend.on("settings_update", () => { throw new Error("disk still full"); });
    const writes = backend.calls.filter((call) => call.cmd === "settings_update").length;
    await setTableFilters("c1", POD, EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", DEPLOYMENT)).toEqual(selected("ReplicaSet"));
    await setTableFilters("c1", DEPLOYMENT, EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", DEPLOYMENT)).toBe(EMPTY_TABLE_FILTERS);
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters).toEqual(imported);
    expect(backend.calls.filter((call) => call.cmd === "settings_update")).toHaveLength(writes);
  });

  it("clears only a persisted target while retaining failed sibling edits that exceed an imported map's cap", async () => {
    const backend = mockBackend();
    await loadSettings();
    const statefulSet = "kind:apps/StatefulSet";
    backend.on("settings_update", () => { throw new Error("disk full"); });
    await expect(setTableFilters("c1", DEPLOYMENT, selected("ReplicaSet"))).rejects.toThrow("disk full");
    await expect(setTableFilters("c1", statefulSet, selected("StatefulSet"))).rejects.toThrow("disk full");
    backend.on("settings_update", ({ settings }) => structuredClone(settings));
    const imported = { ...Object.fromEntries(Array.from({ length: 511 }, (_, i) => [`kind:/Imported${i}`, selected("other")])), [POD]: selected("imported") };
    await updateSettings((s) => ({ ...s, ...stored(imported) }));
    await setTableFilters("c1", POD, EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", DEPLOYMENT)).toEqual(selected("ReplicaSet"));
    expect(getTableFilters("c1", statefulSet)).toEqual(selected("StatefulSet"));
    const persisted = getSettingsSnapshot()!.clusters.c1!.tableFilters!;
    expect(Object.keys(persisted)).toHaveLength(511);
    expect(persisted[POD]).toBeUndefined();
    expect(persisted[DEPLOYMENT]).toBeUndefined();
    expect(persisted[statefulSet]).toBeUndefined();
  });

  it("orders a clear after a sibling retry that is already writing the failed target", async () => {
    const backend = mockBackend();
    await loadSettings();
    backend.on("settings_update", () => { throw new Error("disk full"); });
    await expect(setTableFilters("c1", POD, selected("Job"))).rejects.toThrow("disk full");
    let finish!: () => void;
    let retries = 0;
    backend.on("settings_update", ({ settings }) => ++retries === 1
      ? new Promise<AppSettings>((resolve) => { finish = () => resolve(structuredClone(settings as AppSettings)); })
      : structuredClone(settings));
    const retrying = setTableFilters("c1", DEPLOYMENT, selected("ReplicaSet"));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const clearing = setTableFilters("c1", POD, EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", POD)).toEqual(EMPTY_TABLE_FILTERS);
    finish();
    await Promise.all([retrying, clearing]);
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", DEPLOYMENT)).toEqual(selected("ReplicaSet"));
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters![POD]).toBeUndefined();
  });

  it("loads an unknown persisted map before retaining an optimistic table that could exceed the cap", async () => {
    const map = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`kind:/Kind${i}`, selected("Job")]));
    const saved = { ...defaultAppSettings(), ...stored(map) };
    let finish!: () => void;
    const backend = mockBackend({ settings_get: () => new Promise<AppSettings>((resolve) => { finish = () => resolve(saved); }) });
    const saving = setTableFilters("c1", POD, selected("CronJob")).catch((error: unknown) => error);
    const beforeLoad = getTableFilters("c1", POD);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    finish();
    expect(await saving).toBeInstanceOf(Error);
    expect(beforeLoad).toBe(EMPTY_TABLE_FILTERS);
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(0);
  });

  it("does not retain empty resets of tables that have never had filters", async () => {
    const backend = mockBackend({ settings_update: () => { throw new Error("disk full"); } });
    await loadSettings();
    for (let i = 0; i < 600; i++) await setTableFilters("c1", `kind:/NeverFiltered${i}`, EMPTY_TABLE_FILTERS);
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(0);
  });

  it("removes a newly rejected optimistic edit when an earlier queued import fills the table map", async () => {
    mockBackend();
    await loadSettings();
    const map = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`kind:/Kind${i}`, selected("Job")]));
    const imported = updateSettings((s) => ({ ...s, ...stored(map) }));
    const saving = setTableFilters("c1", POD, selected("CronJob"));
    await expect(saving).rejects.toThrow("too many tables");
    await expect(saving).rejects.toBeInstanceOf(TableFilterLimitError);
    await imported;
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    expect(Object.keys(getSettingsSnapshot()!.clusters.c1!.tableFilters!)).toHaveLength(512);
  });

  it("caps per-cluster tables before saving without discarding previous entries", async () => {
    const map = Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`kind:/Kind${i}`, selected("Job")]));
    const backend = mockBackend({}, { settings: stored(map) });
    await loadSettings();
    const saving = setTableFilters("c1", POD, selected("CronJob"));
    await expect(saving).rejects.toThrow("too many tables");
    await expect(saving).rejects.toBeInstanceOf(TableFilterLimitError);
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(0);
    expect(Object.keys(getSettingsSnapshot()!.clusters.c1!.tableFilters!)).toHaveLength(512);
    expect(getTableFilters("c1", POD)).toBe(EMPTY_TABLE_FILTERS);
    // A rejected edit was never retained; removing a saved table frees space for an explicit new edit.
    await setTableFilters("c1", "kind:/Kind0", EMPTY_TABLE_FILTERS);
    expect(Object.keys(getSettingsSnapshot()!.clusters.c1!.tableFilters!)).toHaveLength(511);
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters![POD]).toBeUndefined();
    await setTableFilters("c1", POD, selected("CronJob"));
    expect(Object.keys(getSettingsSnapshot()!.clusters.c1!.tableFilters!)).toHaveLength(512);
    expect(getSettingsSnapshot()!.clusters.c1!.tableFilters![POD]).toEqual(selected("CronJob"));
  });
});
