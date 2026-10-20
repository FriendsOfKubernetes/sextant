// Custom columns (#214) in a resource table: added from the Columns menu, read from the watched objects (no new
// watch), sorted numerically, matched by the search, removed again; the dialog passes axe.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend } from "../../api";
import { loadSettings, resetSettingsCache } from "../../api/settings";
import { resetAppStore } from "../../app/store";
import { ResourceTable } from "../../components/Table";
import "../../resources";
import { axeViolations } from "../../test/axe";
import type { CustomColumn } from "./model";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };

function pod(name: string, team: string, priority: number): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: "default", uid: `uid-${name}`, labels: { team }, creationTimestamp: "2026-10-01T00:00:00Z" },
    spec: { nodeName: `node-${name}`, priority, containers: [{ name: "app" }] },
    status: { phase: "Running" },
  };
}

let backend: MockBackend;
let watchCount = 0;

async function setUp(customColumns: CustomColumn[] = []) {
  backend = mockBackend(
    { watch_start: () => `watch-${++watchCount}`, watch_stop: () => undefined },
    { settings: { customColumns } },
  );
  await loadSettings();
}

beforeEach(() => {
  resetAppStore();
  resetSettingsCache();
  watchCount = 0;
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 1200 : 0;
  });
});

afterEach(() => backend.restore());

async function snapshot(items: KubeObject[]) {
  await waitFor(() => expect(backend.listenerCount("watch:watch-1")).toBe(1));
  act(() => backend.emit("watch:watch-1", { type: "snapshot", items }));
}

function column(header: string): string[] {
  const headers = screen.getAllByRole("columnheader");
  const index = headers.findIndex((h) => h.textContent === header);
  expect(index).toBeGreaterThan(0);
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((r) => r.children[index]!.textContent ?? "");
}

const PODS = [pod("a", "shop", 10), pod("b", "infra", 9), pod("c", "shop", 100)];

describe("custom columns in a table", () => {
  it("are added from the Columns menu and read from the watched objects", async () => {
    await setUp();
    render(<ResourceTable clusterId="c1" kind={POD} customColumns={{}} search="" />);
    await snapshot(PODS);
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add column…" }));
    const dialog = screen.getByRole("dialog", { name: "Add column" });
    expect(await axeViolations(dialog)).toEqual([]);

    fireEvent.click(within(dialog).getByRole("radio", { name: "Field path" }));
    const path = within(dialog).getByRole("textbox", { name: "Path" });
    fireEvent.change(path, { target: { value: ".spec.containers[*].image" } });
    expect(within(dialog).getByRole("alert").textContent).toContain("Wildcards");
    fireEvent.change(path, { target: { value: "spec.priority" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Header" }), { target: { value: "Priority" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(backend.settings.customColumns).toEqual([
      { cluster: "c1", group: "", kind: "Pod", source: "field", path: ".spec.priority", title: "Priority" },
    ]);
    // Sorted as numbers: 9 < 10 < 100.
    fireEvent.click(screen.getByRole("button", { name: "Priority" }));
    expect(column("Priority")).toEqual(["9", "10", "100"]);
    // No new watch was opened for the column.
    expect(backend.calls.filter((c) => c.cmd === "watch_start")).toHaveLength(1);
  });

  it("are matched by the search and removed from the menu", async () => {
    await setUp([{ cluster: null, group: "", kind: "Pod", source: "label", path: "team", title: "Team" }]);
    const { rerender } = render(<ResourceTable clusterId="c1" kind={POD} customColumns={{}} search="" />);
    await snapshot(PODS);
    expect(column("Team")).toEqual(["shop", "infra", "shop"]);
    rerender(<ResourceTable clusterId="c1" kind={POD} customColumns={{}} search="infra" />);
    expect(column("Team")).toEqual(["infra"]);

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.getByRole("group", { name: "Custom columns" }).textContent).toContain("All clusters");
    expect(await axeViolations(screen.getByRole("menu", { name: "Columns" }))).toEqual([]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove column Team" }));
    await waitFor(() => expect(backend.settings.customColumns).toEqual([]));
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "Team" })).toBeNull());
  });

  it("shows a saved view's columns, which can be kept for the cluster", async () => {
    await setUp();
    const onViewColumnsChange = vi.fn();
    render(
      <ResourceTable
        clusterId="c1"
        kind={POD}
        search=""
        customColumns={{ viewColumns: [{ source: "field", path: ".spec.nodeName", title: "" }], onViewColumnsChange }}
      />,
    );
    await snapshot(PODS);
    expect(column(".spec.nodeName")).toEqual(["node-a", "node-b", "node-c"]);
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Keep column .spec.nodeName for this cluster" }));
    await waitFor(() => expect(onViewColumnsChange).toHaveBeenCalledWith([]));
    expect(backend.settings.customColumns).toEqual([
      { cluster: "c1", group: "", kind: "Pod", source: "field", path: ".spec.nodeName", title: "" },
    ]);
  });

  it("refuse a path into a Secret's values and say why", async () => {
    await setUp();
    render(<ResourceTable clusterId="c1" kind={SECRET} customColumns={{}} search="" />);
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add column…" }));
    const dialog = screen.getByRole("dialog", { name: "Add column" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Field path" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Path" }), { target: { value: ".data.password" } });
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "The values of a Secret (data and stringData) cannot be shown in a column.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(within(dialog).getByRole("button", { name: "Add" })).toHaveProperty("disabled", true);
    expect(backend.settings.customColumns).toEqual([]);
  });
});
