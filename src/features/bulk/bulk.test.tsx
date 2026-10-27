// The selection bar of a resource table (ADR-0126): shown while rows are selected, the actions for every selected
// object, a mixed selection explained before an action runs on its part, the keyboard and the live region.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KindRef, type KubeObject, type MockBackend } from "../../api";
import { resetAppStore } from "../../app/store";
import { ResourceTable } from "../../components/Table/ResourceTable";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import "../../resources";
import { axeViolations } from "../../test/axe";
import "../actions";
import { registerAction, type ActionId } from "../actions/registry";
import "../restart";
import { selectionActions } from "./selection";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const ACTIONS: ActionId[] = ["logs", "edit", "restart", "delete", "copyNamespacedName"];

const rsOwner = { apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-5d8f", uid: "rs-1", controller: true };
const jobOwner = { apiVersion: "batch/v1", kind: "Job", name: "migrate", uid: "job-1", controller: true };

function pod(name: string, owner?: Record<string, unknown>): KubeObject {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: "demo", uid: `uid-${name}`, creationTimestamp: "2026-10-01T00:00:00Z", ownerReferences: owner ? [owner] : [] },
    spec: { nodeName: "node-1", containers: [{ name: "app" }] },
    status: { phase: "Running" },
  };
}

let backend: MockBackend;
let watches = 0;
const logs = vi.fn();
const copy = vi.fn();

beforeEach(() => {
  resetAppStore();
  watches = 0;
  logs.mockReset();
  copy.mockReset();
  backend = mockBackend({ watch_start: () => `watch-${++watches}`, watch_stop: () => undefined });
  // Stand-ins of the logs and copy actions (their features are not loaded here): both run on several objects.
  registerAction("logs", { labelKey: "Logs", icon: "logs", multiple: true, appliesTo: () => true, run: logs });
  registerAction("copyNamespacedName", { labelKey: "Copy", icon: "copy", multiple: true, appliesTo: () => true, run: copy });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 1200 : 0;
  });
});
afterEach(() => {
  // Dialogs live in the registry's module state: close the ones a test left open.
  while (screen.queryAllByRole("dialog").length > 0) fireEvent.keyDown(window, { key: "Escape" });
  backend.restore();
  vi.restoreAllMocks();
});

async function table(items: KubeObject[]) {
  render(
    <>
      <ResourceTable clusterId="c1" kind={POD} actions={ACTIONS} />
      <ActionDialogHost />
    </>,
  );
  await waitFor(() => expect(backend.listenerCount("watch:watch-1")).toBe(1));
  act(() => backend.emit("watch:watch-1", { type: "snapshot", items }));
}
const select = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
const bar = () => screen.queryByRole("toolbar", { name: "Selected objects" });
const barButtons = () => within(bar()!).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);

describe("selectionActions", () => {
  it("offers only actions for several objects, the ones applying to all first as they are, danger last", () => {
    registerAction("edit", { labelKey: "Edit", icon: "edit", appliesTo: () => true, run: vi.fn() });
    const pods = [pod("a", rsOwner), pod("b")];
    const entries = selectionActions(pods, POD, ["delete", ...ACTIONS]);
    // "edit" is for one object only; "delete" (danger) goes last although listed first; Restart applies to "a" only.
    expect(entries.map((e) => e.action.id)).toEqual(["logs", "restart", "copyNamespacedName", "delete"]);
    const restart = entries.find((e) => e.action.id === "restart")!;
    expect(restart.applying.map((o) => o.metadata?.name)).toEqual(["a"]);
    expect(restart.left.map((o) => o.metadata?.name)).toEqual(["b"]);
    // An action applying to none of them is not offered.
    expect(selectionActions([pod("b")], POD, ["restart"])).toEqual([]);
  });
});

describe("the selection bar", () => {
  it("appears with the first selected row, counts them and goes with Clear selection", async () => {
    await table([pod("a", rsOwner), pod("b", rsOwner), pod("c", rsOwner)]);
    expect(bar()).not.toBeInTheDocument();
    select("a");
    expect(bar()).toHaveTextContent("1 selected");
    select("c");
    expect(bar()).toHaveTextContent("2 selected");
    expect(barButtons()).toEqual(["Logs", "Restart", "Copy", "Delete", "Clear selection"]);
    expect(within(bar()!).getByRole("button", { name: "Delete" })).toHaveClass("btn--danger");
    // The bar comes after the header in the tab order and before the table.
    const header = document.querySelector(".rt__header")!;
    const grid = screen.getByRole("table");
    expect(header.compareDocumentPosition(bar()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar()!.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await axeViolations(document.body)).toEqual([]);

    fireEvent.click(within(bar()!).getByRole("button", { name: "Clear selection" }));
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select a" })).not.toBeChecked();
    // The focus does not fall to the page: it goes to the table's row.
    expect(document.activeElement?.getAttribute("role")).toBe("row");
  });

  it("says the selection's size in a live region, and when it was cleared", async () => {
    await table([pod("a", rsOwner), pod("b", rsOwner)]);
    const region = screen.getByTestId("selection-announce");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(region).toHaveTextContent("2 selected");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    expect(region).toHaveTextContent("Selection cleared");
  });

  it("runs an action on every selected object, in the table's order", async () => {
    await table([pod("a", rsOwner), pod("b", rsOwner), pod("c", rsOwner)]);
    select("c");
    select("a");
    fireEvent.click(within(bar()!).getByRole("button", { name: "Logs" }));
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs.mock.calls[0]![0].refs.map((r: { name: string }) => r.name)).toEqual(["a", "c"]);
  });

  it("explains a mixed selection before Restart runs on the part it applies to", async () => {
    await table([pod("a", rsOwner), pod("bare"), pod("job-pod", jobOwner), pod("b", rsOwner)]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    const restart = within(bar()!).getByRole("button", { name: "Restart (for 2 of 4 selected)" });
    expect(restart).toHaveTextContent("Restart2 of 4");
    fireEvent.click(restart);

    const partial = screen.getByRole("dialog", { name: "Restart: only part of the selection" });
    expect(partial).toHaveTextContent("Restart applies to 2 of the 4 selected objects. These are left out:");
    const left = within(within(partial).getByRole("list", { name: "Left out" })).getAllByRole("listitem");
    expect(left.map((li) => li.textContent)).toEqual([
      "demo/bareNo controller would create it again.",
      "demo/job-podRestart does not work through its controller Job migrate.",
    ]);
    expect(await axeViolations(partial)).toEqual([]);
    expect(backend.calls.some((c) => c.cmd === "resource_delete")).toBe(false);

    fireEvent.click(within(partial).getByRole("button", { name: "Continue with 2 objects" }));
    const confirm = await screen.findByRole("dialog", { name: "Restart 2 objects?" });
    expect(within(confirm).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Pod demo/a is deleted, and its ReplicaSet demo/web-5d8f creates a new pod in its place.",
      "Pod demo/b is deleted, and its ReplicaSet demo/web-5d8f creates a new pod in its place.",
    ]);
    // Still nothing sent: Restart has its own confirmation.
    expect(backend.calls.some((c) => c.cmd === "resource_delete")).toBe(false);
  });

  it("Cancel in the explanation runs nothing", async () => {
    await table([pod("a", rsOwner), pod("bare")]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all rows" }));
    fireEvent.click(within(bar()!).getByRole("button", { name: "Restart (for 1 of 2 selected)" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens Delete for the selection with the Delete key on a selected row, and not on another row", async () => {
    await table([pod("a", rsOwner), pod("b", rsOwner), pod("c", rsOwner)]);
    const row = (name: string) => screen.getByText(name).closest<HTMLElement>("[role='row']")!;
    select("a");
    select("b");
    row("c").focus();
    fireEvent.keyDown(row("c"), { key: "Delete" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    row("b").focus();
    fireEvent.keyDown(row("b"), { key: "Delete", ctrlKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(row("b"), { key: "Delete" });
    const dialog = screen.getByRole("dialog", { name: "Delete 2 Pod objects?" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent?.split("comes back")[0])).toEqual(["demo/a", "demo/b"]);
    expect(backend.calls.some((c) => c.cmd === "resource_delete")).toBe(false);
  });
});
