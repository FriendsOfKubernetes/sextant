import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { ColumnFilter } from "../../api/generated/ColumnFilter";
import { ColumnEditor } from "./ColumnEditor";

// Exercise a full transient-history budget without thousands of redundant DOM updates.
// The real 1,000-value persisted-selection boundary is covered in controls.test.tsx.
vi.mock("./validation", async (original) => {
  const actual = await original<typeof import("./validation")>();
  return { ...actual, FILTER_LIMITS: { ...actual.FILTER_LIMITS, values: 3 } };
});
const objects = new Map([...["Original", "Alpha", "Beta", "Gamma", "Delta"].map((owner) => [owner, { owner }] as const)]);
const accept = () => true;
function Harness() {
  const [filter, setFilter] = useState<ColumnFilter>({ values: { mode: "include", values: ["Original"] }, condition: null });
  return <ColumnEditor column={{ id: "owner", title: "Owner", value: (obj) => obj.owner as string }} filter={filter}
    objects={objects} context={{ clusterId: "c", kind: { group: "", version: "v1", kind: "Pod" }, now: 0 }}
    revision={0} accept={accept} onChange={setFilter} onClose={() => {}} onClear={() => {}} />;
}
it("bounds fresh history separately and lets original or remembered choices be reselected at that bound", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Original" }));
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    fireEvent.click(screen.getByRole("checkbox", { name }));
    fireEvent.click(screen.getByRole("checkbox", { name }));
  }
  fireEvent.click(screen.getByRole("checkbox", { name: "Original" }));
  expect(screen.getByRole("checkbox", { name: "Original" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Delta" }));
  expect(screen.getByRole("checkbox", { name: "Delta" })).not.toBeChecked();
  expect(screen.getByRole("alert")).toHaveTextContent("reached its limit");
  fireEvent.click(screen.getByRole("checkbox", { name: "Alpha" }));
  expect(screen.getByRole("checkbox", { name: "Alpha" })).toBeChecked();
  expect(screen.queryByRole("alert")).toBeNull();
});
