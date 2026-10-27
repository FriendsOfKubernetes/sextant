import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import type { TableFilters } from "../../api/generated/TableFilters";
import type { CellContext, ColumnDef } from "../../resources/registry";
import { axeViolations } from "../../test/axe";
import { EMPTY_TABLE_FILTERS } from "./model";
import { useFilterControls } from "./useFilterControls";
import { TableFilterLimitError } from "./validation";

const ctx: CellContext = { clusterId: "c", kind: { group: "", version: "v1", kind: "Pod" }, now: 1_000_000 };
const columns: ColumnDef[] = [
  { id: "owner", title: "Owner", value: (o) => o.owner as string | undefined },
  { id: "count", title: "Count", value: (o) => o.count as number, filter: { type: "number" } },
  { id: "age", title: "Age", value: () => 0, filter: { type: "age", value: () => 60_000 } },
  { id: "enabled", title: "Enabled", value: (o) => o.enabled as boolean },
  { id: "scalar", title: "Scalar number", value: (o) => o.count as number },
  { id: "cpu", title: "CPU", value: () => 1500, filter: { type: "number", unit: "cpu" } },
  { id: "memory", title: "Memory", value: () => 0, filter: { type: "number", unit: "bytes" } },
];
const objects = new Map<string, KubeObject>([["1", { owner: "Job", count: 1, enabled: true }], ["2", { owner: "ReplicaSet", count: 2, enabled: false }], ["3", { count: 0, enabled: false }]]);
const accept = () => true;
function Harness({ initial = EMPTY_TABLE_FILTERS, saved = true, capacity = false, data = objects, definitions = columns }: { initial?: TableFilters; saved?: boolean; capacity?: boolean; data?: ReadonlyMap<string, KubeObject>; definitions?: ColumnDef[] }) {
  const [filters, setFilters] = useState(initial);
  const ui = useFilterControls({ enabled: true, filters, error: !saved, onChange: (next) => capacity ? Promise.reject(new TableFilterLimitError("capacity")) : setFilters(next), columns: definitions, objects: data, context: ctx, accept, revision: 0 });
  return <main>{ui.button}<div role="table"><div role="row"><div role="columnheader">{ui.headerButton(columns[0]!)}</div></div></div>
    <output data-testid="shown">{[...data.values()].filter((obj) => ui.compiled.matches(obj, ctx)).length}</output>
    <output data-testid="stored">{JSON.stringify(filters)}</output>{ui.bar}{ui.overlays}</main>;
}
const excludeJob: TableFilters = { columns: { owner: { values: { mode: "exclude", values: ["Job"] }, condition: null } }, advanced: null };
function openOwner() { fireEvent.click(screen.getByRole("button", { name: "Filter Owner" })); return screen.getByRole("dialog", { name: "Filter Owner" }); }
function openColumn(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Filters" })).getByRole("button", { name: new RegExp(`^${name}\\s*\\d*$`) }));
  return screen.getByRole("dialog", { name: `Filter ${name}` });
}
const stored = (): TableFilters => JSON.parse(screen.getByTestId("stored").textContent!);

describe("resource filter controls", () => {
  it("excludes Job immediately, keeps empty first, and keeps checkbox positions stable", () => {
    render(<Harness />);
    const editor = openOwner();
    expect(within(editor).getAllByRole("checkbox")[0]).toHaveAccessibleName("(empty)");
    fireEvent.click(within(editor).getByRole("button", { name: "Everything except selected" }));
    const before = within(editor).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"));
    fireEvent.click(within(editor).getByRole("checkbox", { name: "Job" }));
    expect(screen.getByTestId("shown")).toHaveTextContent("2");
    expect(within(editor).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))).toEqual(before);
    fireEvent.click(within(editor).getByRole("button", { name: "Only selected" }));
    expect(screen.getByTestId("shown")).toHaveTextContent("1");
  });
  it("lists active columns first without a funnel on every menu item", () => {
    render(<Harness initial={excludeJob} />);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    const manager = screen.getByRole("dialog", { name: "Filters" });
    expect(within(manager).getByRole("searchbox")).toHaveFocus();
    const choices = manager.querySelectorAll(".tf-column-choice");
    expect(choices[0]).toHaveTextContent("Owner");
    expect(manager.querySelector(".tf-column-list .lucide-funnel")).toBeNull();
    fireEvent.change(within(manager).getByRole("searchbox"), { target: { value: "Count" } });
    expect(manager.querySelectorAll(".tf-column-choice")).toHaveLength(1);
    fireEvent.change(within(manager).getByRole("searchbox"), { target: { value: "No such column" } });
    expect(within(manager).getByText("No matching columns")).toBeInTheDocument();
    fireEvent.click(within(manager).getByRole("button", { name: "Close filter" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("retains a typed absent value after unchecking it until the editor closes", () => {
    render(<Harness />);
    const editor = openOwner();
    const input = within(editor).getByRole("searchbox");
    fireEvent.change(input, { target: { value: "CronJob" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const checkbox = within(editor).getByRole("checkbox", { name: "CronJob" });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(within(editor).getByRole("checkbox", { name: "CronJob" })).not.toBeChecked();
  });
  it("retains saved absent selections and infers their type before any rows are loaded", () => {
    render(<Harness initial={excludeJob} data={new Map()} />);
    const editor = openOwner();
    expect(within(editor).getByRole("checkbox", { name: "Job" })).toBeChecked();
    fireEvent.click(within(editor).getByRole("tab", { name: "Condition" }));
    fireEvent.change(screen.getByLabelText("Comparison"), { target: { value: "contains" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "cron" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(stored().columns.owner).toEqual({ values: { mode: "exclude", values: ["Job"] }, condition: { operator: "contains", value: "cron" } });
  });
  it("applies conditions explicitly and discards unapplied drafts on Escape", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Count" }));
    const editor = screen.getByRole("dialog", { name: "Filter Count" });
    fireEvent.click(within(editor).getByRole("tab", { name: "Condition" }));
    fireEvent.change(within(editor).getByLabelText("Comparison"), { target: { value: "gte" } });
    fireEvent.change(within(editor).getByLabelText("Value"), { target: { value: "2" } });
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Count" }));
    fireEvent.click(screen.getByRole("tab", { name: "Condition" }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByTestId("shown")).toHaveTextContent("1"));
  });
  it("clears quick and advanced column conditions with right-click and supports Undo", () => {
    render(<Harness initial={{ ...excludeJob, advanced: { type: "rule", column: "owner", condition: { operator: "neq", value: "ReplicaSet" } } }} />);
    expect(screen.getByTestId("shown")).toHaveTextContent("1");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Filter Owner" }));
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
    expect(screen.getByTestId("stored")).toHaveTextContent('"advanced":null');
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByTestId("shown")).toHaveTextContent("1");
  });
  it("invalidates a previous Undo after another committed change", () => {
    render(<Harness initial={excludeJob} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Filter Owner" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    const editor = openOwner();
    fireEvent.click(within(editor).getByRole("checkbox", { name: "ReplicaSet" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
  it("uses the standard advanced dialog with nested groups and preview, then applies", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Advanced conditions…" }));
    const dialog = screen.getByRole("dialog", { name: "Advanced filter conditions" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add group" }));
    const groups = within(dialog).getAllByRole("group");
    fireEvent.click(within(groups[groups.length - 1]!).getByRole("button", { name: "Add condition" }));
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "Job" } });
    expect(within(dialog).getByRole("status")).toHaveTextContent("1 of 3");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByTestId("shown")).toHaveTextContent("1"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("explicitly reports session-only saving failure", () => {
    render(<Harness saved={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("only to this session");
  });
  it("initializes inferred boolean conditions to the value shown by the editor", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
    fireEvent.click(screen.getByRole("tab", { name: "Condition" }));
    expect(screen.getByLabelText("Value")).toHaveValue("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByTestId("stored")).toHaveTextContent('"value":true');
    expect(screen.getByTestId("shown")).toHaveTextContent("1");
  });
  it.each([["Scalar number", "3", '"values":[3]'], ["Enabled", "true", '"values":[true]']])(
    "preserves the inferred type when searching for an absent value in %s", (column, text, expected) => {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
      fireEvent.click(screen.getByRole("button", { name: column }));
      const input = screen.getByRole("searchbox");
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByTestId("stored")).toHaveTextContent(expected);
    },
  );
  it("moves keyboard focus into newly added conditions and groups", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Advanced conditions…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    expect(screen.getByLabelText("Column")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Add group" }));
    const groups = screen.getAllByRole("group");
    expect(within(groups[groups.length - 1]!).getByRole("combobox", { name: "Condition" })).toHaveFocus();
  });
  it("adopts the first available scalar type if the editor was opened before rows arrived", () => {
    const { rerender } = render(<Harness data={new Map()} />);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Enabled" }));
    fireEvent.click(screen.getByRole("tab", { name: "Condition" }));
    rerender(<Harness data={new Map([["first", { enabled: false }]])} />);
    expect(screen.getByLabelText("Value")).toHaveValue("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByTestId("stored")).toHaveTextContent('"value":true');
  });
  it.each([["enabled", "", '"value":true'], ["scalar", "3", '"value":3']])(
    "adopts late scalar data in an existing advanced %s rule without losing entered input", (column, entered, expected) => {
      const { rerender } = render(<Harness data={new Map()} />);
      fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
      fireEvent.click(screen.getByRole("button", { name: "Advanced conditions…" }));
      fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
      fireEvent.change(screen.getByLabelText("Column"), { target: { value: column } });
      if (entered) fireEvent.change(screen.getByLabelText("Value"), { target: { value: entered } });
      rerender(<Harness data={new Map([["a", { enabled: true, count: 1 }], ["b", { enabled: false, count: 3 }]])} />);
      if (column === "enabled") expect(screen.getByLabelText("Value")).toHaveValue("true");
      else expect(screen.getByLabelText("Value")).toHaveValue(entered);
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      expect(screen.getByTestId("stored")).toHaveTextContent(expected);
      expect(screen.getByTestId("shown")).toHaveTextContent("1");
    },
  );
  it("reports rejected capacity without claiming the unapplied filter is active", async () => {
    render(<Harness capacity />);
    const editor = openOwner();
    fireEvent.click(within(editor).getByRole("checkbox", { name: "Job" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("reached its limit"));
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
  });
  it("rejects a reversed range without applying it, then applies inclusive bounds including zero", () => {
    render(<Harness />);
    const editor = openColumn("Count");
    fireEvent.click(within(editor).getByRole("tab", { name: "Condition" }));
    fireEvent.change(screen.getByLabelText("Comparison"), { target: { value: "between" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Upper bound"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(within(editor).getByRole("alert")).toHaveTextContent("upper bound");
    expect(stored()).toEqual(EMPTY_TABLE_FILTERS);
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(stored().columns.count?.condition).toEqual({ operator: "between", value: 0, upper: 1 });
    expect(screen.getByTestId("shown")).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Count: 0 to 1" })).toBeInTheDocument();
  });
  it("normalizes CPU decimals and preserves both range bounds when changing units", () => {
    render(<Harness />);
    openColumn("CPU");
    fireEvent.click(screen.getByRole("tab", { name: "Condition" }));
    fireEvent.change(screen.getByLabelText("Comparison"), { target: { value: "between" } });
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "cores" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "1,5" } });
    fireEvent.change(screen.getByLabelText("Upper bound"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "millicores" } });
    expect(screen.getByLabelText("Value")).toHaveValue("1500");
    expect(screen.getByLabelText("Upper bound")).toHaveValue("2000");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(stored().columns.cpu?.condition).toEqual({ operator: "between", value: 1500, upper: 2000 });
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
  });
  it.each([["Memory", "MiB", "1.5", "memory", 1_572_864], ["Age", "seconds", "120", "age", 120_000]] as const)(
    "normalizes a typed absent %s value using the selected unit", (column, unit, value, id, expected) => {
      render(<Harness />);
      openColumn(column);
      fireEvent.click(screen.getByRole("tab", { name: "Values" }));
      fireEvent.change(screen.getByLabelText("Unit"), { target: { value: unit } });
      const input = screen.getByRole("searchbox");
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(stored().columns[id]?.values?.values).toEqual([expected]);
      expect(screen.getByTestId("shown")).toHaveTextContent("0");
    },
  );
  it("changes a boolean condition and applies the selected false value", () => {
    render(<Harness />);
    openColumn("Enabled");
    fireEvent.click(screen.getByRole("tab", { name: "Condition" }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(stored().columns.enabled?.condition).toEqual({ operator: "eq", value: false });
    expect(screen.getByTestId("shown")).toHaveTextContent("2");
  });
  it.each([["empty", "is empty", 1], ["notEmpty", "is not empty", 2]])("applies %s without an operand", (operator, label, shown) => {
    render(<Harness />);
    const editor = openOwner();
    fireEvent.click(within(editor).getByRole("tab", { name: "Condition" }));
    fireEvent.change(screen.getByLabelText("Comparison"), { target: { value: operator } });
    expect(screen.queryByLabelText("Value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(stored().columns.owner?.condition).toEqual({ operator });
    expect(screen.getByTestId("shown")).toHaveTextContent(String(shown));
    expect(screen.getByRole("button", { name: `Owner: ${label}` })).toBeInTheDocument();
  });
  it("rejects an invalid typed number without adding it to the current filter", () => {
    render(<Harness />);
    openColumn("Count");
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "1,2.3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("valid value");
    expect(stored()).toEqual(EMPTY_TABLE_FILTERS);
  });
  it("rejects a quick rule when the table has exhausted its combined condition budget", () => {
    const initial = { columns: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`column-${i}`, { values: null, condition: { operator: "eq" as const, value: "x" } }])), advanced: null };
    render(<Harness initial={initial} />);
    const editor = openOwner();
    fireEvent.click(within(editor).getByRole("checkbox", { name: "Job" }));
    expect(screen.getByRole("alert")).toHaveTextContent("reached its limit");
    expect(stored()).toEqual(initial);
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
  });
  it("keeps value and condition chips independent and discards drafts on outside click and Cancel", () => {
    render(<Harness initial={{ columns: { count: { values: { mode: "include", values: [1, 2] }, condition: { operator: "gte", value: 2 } } }, advanced: null }} />);
    expect(screen.getByTestId("shown")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "Remove Count: at least 2" }));
    expect(stored().columns.count?.condition).toBeNull();
    expect(screen.getByTestId("shown")).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: /^Count: only/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Condition" }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "99" } });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stored().columns.count?.condition).toBeNull();
    openColumn("Count");
    fireEvent.click(screen.getByRole("tab", { name: "Condition" }));
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(stored().columns.count?.condition).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Remove Count: only/ }));
    expect(stored()).toEqual(EMPTY_TABLE_FILTERS);
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
  });
  it("changes nested AND to OR, previews its meaning, cancels edits and removes a group", () => {
    const advanced: TableFilters["advanced"] = { type: "group", operator: "and", children: [
      { type: "rule", column: "count", condition: { operator: "gte", value: 1 } },
      { type: "group", operator: "and", children: [
        { type: "rule", column: "owner", condition: { operator: "eq", value: "Job" } },
        { type: "rule", column: "owner", condition: { operator: "eq", value: "ReplicaSet" } },
      ] },
    ] };
    render(<Harness initial={{ columns: {}, advanced }} />);
    const open = () => fireEvent.click(screen.getByRole("button", { name: /^Advanced:/ }));
    open();
    const nested = screen.getAllByRole("group")[1]!;
    fireEvent.change(within(nested).getByRole("combobox", { name: "Condition" }), { target: { value: "or" } });
    expect(within(screen.getByRole("dialog", { name: "Advanced filter conditions" })).getByRole("status")).toHaveTextContent("2 of 3");
    expect(screen.getByTestId("shown")).toHaveTextContent("0");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByTestId("shown")).toHaveTextContent("2");
    expect(JSON.stringify(stored().advanced)).toContain('"operator":"or"');
    const applied = stored();
    open();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove condition" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Remove group" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(stored()).toEqual(applied);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Remove group" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(stored().advanced).toEqual({ type: "rule", column: "count", condition: { operator: "gte", value: 1 } });
    fireEvent.click(screen.getByRole("button", { name: /^Remove Advanced:/ }));
    expect(stored()).toEqual(EMPTY_TABLE_FILTERS);
  });
  it("clears an unavailable column from its chip and prunes its advanced rules without changing the others", () => {
    const advanced: TableFilters["advanced"] = { type: "group", operator: "or", children: [
      { type: "rule", column: "owner", condition: { operator: "eq", value: "Job" } },
      { type: "rule", column: "count", condition: { operator: "eq", value: 2 } },
    ] };
    render(<Harness initial={{ ...excludeJob, advanced }} definitions={columns.filter((column) => column.id !== "owner")} />);
    expect(screen.getByText(/quick filters are paused/)).toBeInTheDocument();
    expect(screen.getByText(/Advanced conditions are paused/)).toBeInTheDocument();
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
    fireEvent.click(screen.getByRole("button", { name: "owner: except Job" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear this column" }));
    expect(stored().columns).toEqual({});
    expect(stored().advanced).toEqual({ type: "rule", column: "count", condition: { operator: "eq", value: 2 } });
    expect(screen.getByTestId("shown")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(stored().advanced).toEqual(advanced);
    expect(screen.getByTestId("shown")).toHaveTextContent("3");
  });
  it("allows replacing a selected value when an existing selection is at its limit", () => {
    const values = Array.from({ length: 1000 }, (_, i) => `kind-${i}`);
    render(<Harness initial={{ columns: { owner: { values: { mode: "include", values }, condition: null } }, advanced: null }} />);
    const editor = openOwner();
    fireEvent.click(within(editor).getByRole("checkbox", { name: "kind-0" }));
    const search = within(editor).getByRole("searchbox");
    fireEvent.change(search, { target: { value: "NewKind" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(stored().columns.owner?.values?.values).toHaveLength(1000);
    expect(stored().columns.owner?.values?.values).toContain("NewKind");
    expect(within(editor).queryByRole("alert")).toBeNull();
    fireEvent.change(search, { target: { value: "AnotherKind" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(stored().columns.owner?.values?.values).toHaveLength(1000);
    expect(stored().columns.owner?.values?.values).not.toContain("AnotherKind");
    expect(within(editor).getByRole("alert")).toHaveTextContent("reached its limit");
    // The removed original value remains available until close, as promised by the editor.
    fireEvent.change(search, { target: { value: "kind-0" } });
    expect(within(editor).getByRole("checkbox", { name: "kind-0" })).not.toBeChecked();
  });
  it("has no axe violations in the column editor and advanced dialog", async () => {
    const { container } = render(<Harness />);
    openOwner();
    expect(await axeViolations(document.body)).toEqual([]);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Advanced conditions…" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});
