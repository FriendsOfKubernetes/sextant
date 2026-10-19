// Resizing columns: the resource table (drag, keyboard, saved widths, the reset in the Columns menu, no render of the
// rows while a column is dragged, even with 20 000 rows) and plain tables (`ResizableTable`).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, mockBackend, resetWatchRegistry, type KindRef, type KubeObject, type MockBackend } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore } from "../../app/store";
import { resetActions } from "../../features/actions/registry";
import "../../resources";
import type { ColumnDef } from "../../resources/registry";
import { axeViolations } from "../../test/axe";
import { asItems, scalePods } from "../../test/scale";
import { SAVE_WIDTHS_DELAY_MS, WIDTH_STEP, WIDTH_STEP_LARGE } from "./columnWidths";
import { ResizableTable } from "./ResizableTable";
import { ResourceTable } from "./ResourceTable";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const HEAD_WIDTH = 200;
let backend: MockBackend;
let watchCount = 0;
/** How far the wrapper of a plain table is scrolled sideways: its cells move left in the viewport by as much. */
let scrolled = 0;

beforeEach(async () => {
  resetAppStore();
  resetActions();
  resetWatchRegistry();
  resetSettingsCache();
  watchCount = 0;
  scrolled = 0;
  backend = mockBackend({ watch_start: () => `watch-${++watchCount}`, watch_stop: () => undefined });
  await loadSettings();
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 1200 : 0;
  });
  // jsdom has no layout: header cells are 200 px wide, plain table header cells 100 px, side by side.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("rt__resizer")) return new DOMRect(0, 0, HEAD_WIDTH, 33);
    if (this.tagName === "TH") {
      const index = [...(this.parentElement?.children ?? [])].indexOf(this);
      return new DOMRect(index * 100 - scrolled, 0, 100, 30);
    }
    if (this.tagName === "TABLE") return new DOMRect(-scrolled, 0, 300, 90);
    if (this.tagName === "THEAD") return new DOMRect(-scrolled, 0, 300, 30);
    return new DOMRect(0, 0, 0, 0);
  });
  // Frames run at once, so a drag's preview is applied before the next event.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => {
    fn(0);
    return 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  backend.restore();
  resetSettingsCache();
});

async function snapshot(items: unknown[], id = "watch-1") {
  await waitFor(() => expect(backend.listenerCount(`watch:${id}`)).toBe(1));
  act(() => backend.emit(`watch:${id}`, { type: "snapshot", items }));
}

function pod(name: string): KubeObject {
  return { apiVersion: "v1", kind: "Pod", metadata: { name, namespace: "default", uid: `uid-${name}` } };
}

const columnsTemplate = () =>
  screen.getByRole("table").closest<HTMLElement>(".rt__frame")!.style.getPropertyValue("--rt-columns");

describe("resizing a resource table's columns", () => {
  it("drags a column wider: the grid follows the pointer and the width is saved per kind and column", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod("a")]);
    const handle = screen.getByRole("separator", { name: "Resize column Name" });
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuemin", "48");
    expect(handle).toHaveAttribute("aria-valuenow", String(HEAD_WIDTH));
    // The header text stays what it was (e2e and screen readers read it).
    expect(screen.getByRole("columnheader", { name: "Name" }).textContent).toBe("Name");

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140 });
    expect(columnsTemplate()).toMatch(/^32px 240px /);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 160 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 160 });
    expect(columnsTemplate()).toMatch(/^32px 260px /);
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    await waitFor(() => expect(backend.settings.columnWidths?.["kind:/Pod"]?.columns).toEqual({ name: 260 }), {
      timeout: SAVE_WIDTHS_DELAY_MS + 1000,
    });
  });

  it("resizes from the keyboard and resets with Enter or a double click", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod("a")]);
    const handle = screen.getByRole("separator", { name: "Resize column Name" });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(columnsTemplate()).toMatch(new RegExp(`^32px ${HEAD_WIDTH + WIDTH_STEP}px `));
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(columnsTemplate()).toMatch(new RegExp(`^32px ${HEAD_WIDTH + WIDTH_STEP - WIDTH_STEP_LARGE}px `));
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(columnsTemplate()).toMatch(/^32px minmax/);

    fireEvent.keyDown(handle, { key: "Home" });
    expect(columnsTemplate()).toMatch(/^32px 48px /);
    fireEvent.doubleClick(handle);
    expect(columnsTemplate()).toMatch(/^32px minmax/);
    // The handle's keys never sort or move between rows.
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending");
  });

  it("offers \"Reset column widths\" in the Columns menu once a width was changed", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod("a")]);
    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize column Namespace" }), { key: "End" });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    const menu = screen.getByRole("menu", { name: "Columns" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Reset column widths" }));
    expect(columnsTemplate()).not.toMatch(/1600px/);
    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
  });

  it("uses saved widths and keeps the Columns menu's checkboxes with the reset", async () => {
    resetSettingsCache();
    backend.restore();
    backend = mockBackend(
      { watch_start: () => `watch-${++watchCount}`, watch_stop: () => undefined },
      { settings: { columnWidths: { "kind:/Pod": { columns: { namespace: 300 }, used: 1 } } } },
    );
    await loadSettings();
    render(<ResourceTable clusterId="c1" kind={POD} hiddenColumns={[]} onHiddenColumnsChange={() => undefined} />);
    await snapshot([pod("a")]);
    expect(columnsTemplate()).toContain(" 300px ");
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    const menu = screen.getByRole("menu", { name: "Columns" });
    expect(within(menu).getAllByRole("menuitemcheckbox").length).toBeGreaterThan(1);
    expect(within(menu).getByRole("menuitem", { name: "Reset column widths" })).toBeEnabled();
  });

  it("has no accessibility violations with the handles", async () => {
    const { container } = render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod("a")]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("does not render the rows while a column of 20 000 rows is dragged", async () => {
    let renders = 0;
    const columns: ColumnDef[] = [
      {
        id: "name",
        titleKey: "resources:columns.name",
        value: (o) => o.metadata?.name ?? "",
        render: (o) => {
          renders += 1;
          return o.metadata?.name ?? "";
        },
      },
    ];
    render(<ResourceTable clusterId="c1" kind={POD} columns={columns} namespaces={["team-1"]} />);
    await snapshot(asItems(scalePods(20_000)));
    await waitFor(() => expect(renders).toBeGreaterThan(0));
    const drawn = renders;
    expect(drawn).toBeLessThan(200);
    const handle = screen.getByRole("separator", { name: "Resize column Name" });
    renders = 0;
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 0 });
    for (let x = 1; x <= 50; x++) fireEvent.pointerMove(handle, { pointerId: 1, clientX: x * 4 });
    expect(columnsTemplate()).toMatch(/^32px 400px /);
    expect(renders).toBe(0);
    // The end of the drag is one render of the drawn rows, not of the list.
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 200 });
    expect(renders).toBeLessThanOrEqual(drawn);
  });
});

function Plain({ id = "test.plain", first = "Name", check = false }: { id?: string; first?: string; check?: boolean }) {
  return (
    <ResizableTable tableId={id} aria-label="Plain">
      <thead>
        <tr>
          {check && <th data-col="check" />}
          <th>{first}</th>
          <th data-col="status">Status</th>
          <th>Age</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          {check && <td />}
          <td>web</td>
          <td>a very long status text</td>
          <td>3d</td>
        </tr>
      </tbody>
    </ResizableTable>
  );
}

describe("ResizableTable", () => {
  it("puts a handle on every header cell and keeps the header text", async () => {
    render(<Plain />);
    const handles = await screen.findAllByRole("separator");
    expect(handles.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Resize column Name",
      "Resize column Status",
      "Resize column Age",
    ]);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Status", "Age"]);
    expect(screen.getByRole("table", { name: "Plain" })).not.toHaveClass("tbl-resize__table--fixed");
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("fixes the layout after a resize, keeps the other columns' widths, saves by column and resets", async () => {
    render(<Plain />);
    const handle = await screen.findByRole("separator", { name: "Resize column Status" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    const table = screen.getByRole("table", { name: "Plain" });
    expect(table).toHaveClass("tbl-resize__table--fixed");
    const cols = [...table.querySelectorAll("col")].map((c) => c.style.width);
    expect(cols).toEqual(["100px", `${100 + WIDTH_STEP}px`, "100px"]);
    expect(table.style.width).toBe(`${300 + WIDTH_STEP}px`);
    await waitFor(() => expect(backend.settings.columnWidths?.["test.plain"]?.columns).toEqual({ status: 100 + WIDTH_STEP }), {
      timeout: SAVE_WIDTHS_DELAY_MS + 1000,
    });

    fireEvent.doubleClick(handle);
    expect(table).not.toHaveClass("tbl-resize__table--fixed");
    expect(table.style.width).toBe("");
  });

  it("drags a column and shows the cut text of a narrowed cell as its tooltip", async () => {
    render(<Plain />);
    const handle = await screen.findByRole("separator", { name: "Resize column Name" });
    fireEvent.pointerDown(handle, { pointerId: 7, button: 0, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 50 });
    const table = screen.getByRole("table", { name: "Plain" });
    expect(table.querySelector("col")!.style.width).toBe("50px");
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 50 });
    expect(table.querySelector("col")!.style.width).toBe("50px");

    const cell = screen.getByText("a very long status text");
    vi.spyOn(cell, "scrollWidth", "get").mockReturnValue(300);
    vi.spyOn(cell, "clientWidth", "get").mockReturnValue(80);
    fireEvent.mouseOver(cell);
    expect(cell).toHaveAttribute("title", "a very long status text");
  });

  it("starts with saved widths", async () => {
    resetSettingsCache();
    backend.restore();
    backend = mockBackend({}, { settings: { columnWidths: { "test.saved": { columns: { "0": 180 }, used: 1 } } } });
    await loadSettings();
    render(<Plain id="test.saved" />);
    const table = await screen.findByRole("table", { name: "Plain" });
    await waitFor(() => expect(table).toHaveClass("tbl-resize__table--fixed"));
    expect(table.querySelector("col")!.style.width).toBe("180px");
  });

  it("places the handles from the table, not the scrolled wrapper, and keeps the last one inside the table", async () => {
    const { rerender } = render(<Plain />);
    const lefts = () => screen.getAllByRole("separator").map((h) => h.style.left);
    await waitFor(() => expect(lefts()).toEqual(["96px", "196px", "292px"]));
    // The wrapper scrolls sideways (the cells move left on screen), then the header changes: the handles stay on
    // the column edges.
    scrolled = 150;
    rerender(<Plain first="Object" />);
    await waitFor(() => expect(screen.getByRole("separator", { name: "Resize column Object" })).toBeInTheDocument());
    expect(lefts()).toEqual(["96px", "196px", "292px"]);
  });

  it("gives a header cell without text no handle", async () => {
    render(<Plain check />);
    await waitFor(() => expect(screen.getAllByRole("separator")).toHaveLength(3));
    expect(screen.getAllByRole("separator").map((h) => h.getAttribute("aria-label"))).toEqual([
      "Resize column Name",
      "Resize column Status",
      "Resize column Age",
    ]);
  });

  it("updates or removes a tooltip it wrote, and leaves a cell's own tooltip alone", async () => {
    render(<Plain />);
    const cell = await screen.findByText("a very long status text");
    const width = vi.spyOn(cell, "scrollWidth", "get").mockReturnValue(300);
    vi.spyOn(cell, "clientWidth", "get").mockReturnValue(80);
    fireEvent.mouseOver(cell);
    expect(cell).toHaveAttribute("title", "a very long status text");
    cell.textContent = "Running";
    fireEvent.mouseOver(cell);
    expect(cell).toHaveAttribute("title", "Running");
    // Now it fits: the tooltip goes.
    width.mockReturnValue(40);
    fireEvent.mouseOver(cell);
    expect(cell).not.toHaveAttribute("title");
    // A tooltip of the cell's own stays.
    cell.setAttribute("title", "own");
    width.mockReturnValue(300);
    fireEvent.mouseOver(cell);
    expect(cell).toHaveAttribute("title", "own");
  });
});

describe("the handles of a table are one tab stop", () => {
  it("has one handle in the tab order, Ctrl+arrows move between them, and the keys are described", async () => {
    render(<ResourceTable clusterId="c1" kind={POD} />);
    await snapshot([pod("a")]);
    const handles = screen.getAllByRole("separator");
    expect(handles.length).toBeGreaterThan(2);
    expect(handles.filter((h) => h.tabIndex === 0)).toEqual([handles[0]]);
    expect(handles[0]).toHaveAccessibleDescription(/Control with Left or Right moves to another column/);

    act(() => handles[0]!.focus());
    fireEvent.keyDown(handles[0]!, { key: "ArrowRight", ctrlKey: true });
    expect(document.activeElement).toBe(handles[1]);
    expect(handles[1]!.tabIndex).toBe(0);
    expect(handles[0]!.tabIndex).toBe(-1);
    // Moving does not resize.
    expect(columnsTemplate()).toMatch(/^32px minmax/);
    fireEvent.keyDown(handles[1]!, { key: "ArrowLeft", metaKey: true });
    expect(document.activeElement).toBe(handles[0]);
    fireEvent.keyDown(handles[0]!, { key: "ArrowLeft", ctrlKey: true });
    expect(document.activeElement).toBe(handles[0]);
  });
});
