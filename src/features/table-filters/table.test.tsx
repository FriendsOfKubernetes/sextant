import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, getSettingsSnapshot, mockBackend, updateSettings, type KubeObject, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { ResourceTable } from "../../components/Table/ResourceTable";
import { ageColumn, type ColumnDef } from "../../resources";
import { registerAction } from "../actions/registry";
import { podColumns } from "../metrics/columns";
import { POLL_INTERVAL_MS, resetMetricsCache } from "../metrics/hooks";
import { getTableFilters, resetTableFiltersState, setTableFilters } from "./state";

const KIND = { group: "", version: "v1", kind: "Pod" };
const VIEW = "kind:/Pod";
let backend: MockBackend;
let streams = 0;
let filterReads = 0;
const columns: ColumnDef[] = [
  { id: "name", title: "Name", value: (obj) => obj.metadata?.name },
  { id: "owner", title: "Owner", value: (obj) => obj.owner as string | undefined, filter: { type: "string", value: (obj) => { filterReads++; return obj.owner as string | undefined; } } },
];
const row = (n: number): KubeObject => ({ metadata: { name: `pod-${n}`, uid: `p${n}`, namespace: "demo" }, owner: n % 2 ? "Job" : "ReplicaSet" });
const exclusion = { columns: { owner: { values: { mode: "exclude" as const, values: ["Job"] }, condition: null } }, advanced: null };
beforeEach(() => {
  resetAppStore(); resetTableFiltersState(); streams = 0; filterReads = 0;
  backend = mockBackend({ watch_start: () => `watch-${++streams}`, watch_stop: () => undefined }, { settings: defaultAppSettings() });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("rt__scroll") ? 660 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("rt__scroll") ? 1200 : 0; });
});
afterEach(() => { backend.restore(); resetTableFiltersState(); resetMetricsCache(); vi.useRealTimers(); });
async function snapshot(rows: KubeObject[]) {
  await waitFor(() => expect(backend.listenerCount("watch:watch-1")).toBe(1));
  act(() => backend.emit("watch:watch-1", { type: "snapshot", items: rows }));
}

describe("filters in the live resource table", () => {
  it("filters before selection/sorting and follows watch deltas while hidden columns remain active", async () => {
    const { rerender } = render(<ResourceTable filtering clusterId="c1" kind={KIND} columns={columns} namespaces={["demo"]} />);
    await snapshot([row(0), row(1), row(2)]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    await act(async () => { await setTableFilters("c1", VIEW, exclusion); });
    expect(screen.getByTestId("rt-count")).toHaveTextContent("2 of 3");
    expect(screen.queryByText("pod-1")).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Selected objects" })).toHaveTextContent("2 selected");
    rerender(<ResourceTable filtering clusterId="c1" kind={KIND} columns={columns} namespaces={["demo"]} hiddenColumns={["owner"]} />);
    expect(screen.getByTestId("rt-count")).toHaveTextContent("2 of 3");
    act(() => backend.emit("watch:watch-1", { type: "delta", upserted: [{ ...row(1), owner: "ReplicaSet" }], deleted: [] }));
    expect(screen.getByTestId("rt-count")).toHaveTextContent("3 items");
    expect(screen.getByText("pod-1")).toBeInTheDocument();
    rerender(<ResourceTable filtering clusterId="c1" kind={KIND} columns={[columns[0]!]} namespaces={["demo"]} />);
    expect(screen.getByText("This column is unavailable. Its quick filters are paused.")).toBeInTheDocument();
    expect(getTableFilters("c1", VIEW).columns.owner).toBeDefined();
    act(() => backend.emit("watch:watch-1", { type: "delta", upserted: [row(1)], deleted: [] }));
    expect(screen.getByTestId("rt-count")).toHaveTextContent("3 items");
    rerender(<ResourceTable filtering clusterId="c1" kind={KIND} columns={columns} namespaces={["demo"]} />);
    expect(screen.queryByText(/quick filters are paused/)).toBeNull();
    expect(screen.getByTestId("rt-count")).toHaveTextContent("2 of 3");
    expect(screen.queryByText("pod-1")).toBeNull();
    expect(streams).toBe(1);
  });
  it("combines filters with the 0.25 search over displayed column text", async () => {
    await setTableFilters("c1", VIEW, exclusion);
    const status: ColumnDef = { id: "phase", title: "Phase", value: (obj) => obj.phase as string };
    const { rerender } = render(<ResourceTable filtering clusterId="c1" kind={KIND} columns={[...columns, status]} namespaces={["demo"]} search="Running" />);
    await snapshot([{ ...row(0), phase: "Running" }, { ...row(1), phase: "Running" }, { ...row(2), phase: "Pending" }]);
    expect(screen.getByTestId("rt-count")).toHaveTextContent("1 of 3");
    expect(screen.getByText("pod-0")).toBeInTheDocument();
    expect(screen.queryByText("pod-1")).toBeNull();
    expect(screen.queryByText("pod-2")).toBeNull();
    // The upstream search uses shown columns; hiding one keeps its filter but removes its searchable text.
    rerender(<ResourceTable filtering clusterId="c1" kind={KIND} columns={[...columns, status]} namespaces={["demo"]} search="Running" hiddenColumns={["phase"]} />);
    expect(screen.getByTestId("rt-count")).toHaveTextContent("0 of 3");
  });
  it("runs a 0.25 selection action on only the rows retained by filters", async () => {
    const copy = vi.fn();
    const dispose = registerAction("copyNamespacedName", { labelKey: "Copy", icon: "copy", multiple: true, appliesTo: () => true, run: copy });
    try {
      render(<ResourceTable filtering clusterId="c1" kind={KIND} columns={columns} namespaces={["demo"]} actions={["copyNamespacedName"]} />);
      await snapshot([row(0), row(1), row(2)]);
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
      await act(async () => { await setTableFilters("c1", VIEW, exclusion); });
      const selection = screen.getByRole("toolbar", { name: "Selected objects" });
      expect(selection).toHaveTextContent("2 selected");
      fireEvent.click(within(selection).getByRole("button", { name: "Copy" }));
      expect(copy).toHaveBeenCalledTimes(1);
      expect(copy.mock.calls[0]![0].objects.map((obj: KubeObject) => obj.metadata?.name)).toEqual(["pod-0", "pod-2"]);
      const firstRow = screen.getByText("pod-0").closest("[role='row']")!;
      fireEvent.keyDown(firstRow, { key: "c", ctrlKey: true });
      expect(copy).toHaveBeenCalledTimes(2);
      expect(copy.mock.calls[1]![0].objects.map((obj: KubeObject) => obj.metadata?.name)).toEqual(["pod-0", "pod-2"]);
      fireEvent.click(within(selection).getByRole("button", { name: "Clear selection" }));
      expect(screen.queryByRole("toolbar", { name: "Selected objects" })).toBeNull();
      expect(screen.getByTestId("rt-count")).toHaveTextContent("2 of 3");
    } finally { act(dispose); }
  });
  it("updates the 0.25 age-text search together with an active raw age filter", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    await setTableFilters("c1", VIEW, { columns: { age: { values: null, condition: { operator: "gte", value: 60_000 } } }, advanced: null });
    render(<ResourceTable filtering clusterId="c1" kind={KIND} columns={[columns[0]!, ageColumn]} namespaces={["demo"]} search="5m" />);
    await act(async () => { await Promise.resolve(); });
    act(() => backend.emit("watch:watch-1", { type: "snapshot", items: [{ ...row(0), metadata: { ...row(0).metadata, creationTimestamp: new Date(Date.now() - 295_000).toISOString() } }] }));
    expect(screen.getByTestId("rt-count")).toHaveTextContent("0 of 1");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByTestId("rt-count")).toHaveTextContent("1 item");
    expect(screen.getByText("pod-0")).toBeInTheDocument();
    expect(streams).toBe(1);
  });
  it("keeps a failed save active in this session and retries through the real settings queue", async () => {
    await updateSettings((settings) => ({ ...settings, theme: "light" }));
    render(<ResourceTable filtering clusterId="c1" kind={KIND} columns={columns} namespaces={["demo"]} />);
    await snapshot([row(0), row(1)]);
    backend.on("settings_update", () => { throw { code: "io", message: "synthetic write failure" }; });
    fireEvent.click(screen.getByRole("button", { name: "Filter Owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Everything except selected" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Job" }));
    expect(screen.getByTestId("rt-count")).toHaveTextContent("1 of 2");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("only to this session"));
    expect(getSettingsSnapshot()?.clusters.c1?.tableFilters?.[VIEW]).toBeUndefined();
    backend.on("settings_update", ({ settings }) => settings);
    fireEvent.click(screen.getByRole("button", { name: "Try saving again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(getSettingsSnapshot()?.clusters.c1?.tableFilters?.[VIEW]).toEqual(exclusion);
    expect(getSettingsSnapshot()?.theme).toBe("light");
    expect(screen.getByTestId("rt-count")).toHaveTextContent("1 of 2");
    expect(streams).toBe(1);
  });
  it("reads each used column once per row; menu opening and unrelated saves do not scan it again", async () => {
    await setTableFilters("c1", VIEW, { ...exclusion, advanced: { type: "rule", column: "owner", condition: { operator: "neq", value: "DaemonSet" } } });
    render(<ResourceTable filtering clusterId="c1" kind={KIND} columns={columns} namespaces={["demo"]} />);
    await snapshot(Array.from({ length: 20_000 }, (_, i) => row(i)));
    expect(screen.getByTestId("rt-count")).toHaveTextContent("10000 of 20000");
    expect(filterReads).toBe(20_000);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    expect(filterReads).toBe(20_000);
    await act(async () => { await updateSettings((settings) => ({ ...settings, theme: "light" })); });
    expect(filterReads).toBe(20_000);
    fireEvent.click(screen.getByRole("button", { name: /Owner.*2/ }));
    expect(filterReads).toBe(40_000);
    const editor = screen.getByRole("dialog", { name: "Filter Owner" });
    fireEvent.click(within(editor).getByRole("checkbox", { name: "ReplicaSet" }));
    await waitFor(() => expect(screen.getByTestId("rt-count")).toHaveTextContent("0 of 20000"));
    expect(filterReads).toBe(60_000);
  });
  it("keeps namespace/search when clearing and reports that capped filtering uses loaded rows", async () => {
    await setTableFilters("c1", VIEW, exclusion);
    render(<ResourceTable filtering clusterId="c1" kind={KIND} columns={columns} namespaces={["demo"]} search="pod-1" />);
    await snapshot([row(0), row(1)]);
    expect(screen.getByTestId("rt-count")).toHaveTextContent("0 of 2");
    act(() => backend.emit("watch:watch-1", { type: "capped", total: 100_000 }));
    expect(screen.getByText("Filters apply to the loaded part of this list.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    await waitFor(() => expect(screen.getByText("pod-1")).toBeInTheDocument());
    expect(screen.queryByText("pod-0")).toBeNull();
    // Without a filter the capped table says nothing about filters (#294).
    expect(screen.queryByText("Filters apply to the loaded part of this list.")).toBeNull();
  });
  it("re-evaluates age on the existing table tick without starting another watch", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    await setTableFilters("c1", VIEW, { columns: { age: { values: null, condition: { operator: "gt", value: 15_000 } } }, advanced: null });
    render(<ResourceTable filtering clusterId="c1" kind={KIND} columns={[columns[0]!, ageColumn]} namespaces={["demo"]} />);
    await act(async () => { await Promise.resolve(); });
    act(() => backend.emit("watch:watch-1", { type: "snapshot", items: [{ ...row(1), metadata: { ...row(1).metadata, creationTimestamp: new Date(Date.now() - 10_000).toISOString() } }] }));
    expect(screen.getByTestId("rt-count")).toHaveTextContent("0 of 1");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByTestId("rt-count")).toHaveTextContent("1 item");
    expect(screen.getByText("pod-1")).toBeInTheDocument();
    expect(streams).toBe(1);
  });
  it("keeps the shared metrics poller live with zero visible rows and both metric columns hidden", async () => {
    vi.useFakeTimers();
    useAppStore.getState().setNamespaces("c1", ["demo"]);
    let usage = 250;
    backend.on("metrics_pods", () => [{ namespace: "demo", name: "pod-1", usage: { cpuMillicores: usage, memoryBytes: 0 }, containers: [] }]);
    await setTableFilters("c1", VIEW, { columns: { cpu: { values: null, condition: { operator: "gt", value: 500 } } }, advanced: null });
    render(<ResourceTable filtering clusterId="c1" kind={KIND} columns={[columns[0]!, ...podColumns]} namespaces={["demo"]} hiddenColumns={["cpu", "memory"]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    act(() => backend.emit("watch:watch-1", { type: "snapshot", items: [row(1)] }));
    expect(screen.getByTestId("rt-count")).toHaveTextContent("0 of 1");
    expect(backend.calls.filter((call) => call.cmd === "metrics_pods")).toHaveLength(1);
    usage = 750;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(screen.getByText("pod-1")).toBeInTheDocument();
    expect(screen.getByTestId("rt-count")).toHaveTextContent("1 item");
    expect(backend.calls.filter((call) => call.cmd === "metrics_pods")).toHaveLength(2);
    expect(streams).toBe(1);
  });
});
