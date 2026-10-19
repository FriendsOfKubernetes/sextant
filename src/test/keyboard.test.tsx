// Keyboard access (#158): dialogs trap and return the focus, the details panel and the dock take it and give it back,
// the terminal has a key that leaves it, popups return the focus to their opener.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend } from "../api";
import { resetAppStore, useAppStore } from "../app/store";
import { Button, Checkbox, ConfirmDialog, Dialog, useFocusTrap, usePopup } from "../components";
import { isLeaveTerminalKey } from "../features/terminal/useTerminal";
import { AppShell } from "../layout/AppShell";
import { Dock } from "../layout/dock/Dock";
import { ResourceTable } from "../components/Table";
import "../features/actions";
import { ActionDialogHost } from "../layout/main/ActionDialogHost";
import { cssRule } from "./css";

let backend: MockBackend;
beforeEach(() => {
  resetAppStore();
  backend = mockBackend({ resource_get: () => ({ metadata: { name: "web-1", uid: "u1" } }) });
});
afterEach(() => backend.restore());

function Opener({ confirm = false }: { confirm?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {confirm ? (
        <ConfirmDialog open={open} title="Delete?" danger onConfirm={close} onCancel={close} />
      ) : (
        <Dialog open={open} title="Scale" onClose={close} footer={<Button onClick={close}>Save</Button>}>
          <input aria-label="Replicas" />
        </Dialog>
      )}
    </>
  );
}

describe("dialogs", () => {
  it("move the focus to the first field, keep Tab inside and give the focus back on close", async () => {
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Scale" });
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "Replicas" }));

    // Tab from the last element wraps to the first, Shift+Tab from the first to the last.
    within(dialog).getByRole("button", { name: "Save" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Save" }));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("a confirmation starts on Cancel, not on the dangerous button", () => {
    render(<Opener confirm />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
});

describe("stacked modals", () => {
  it("only the top one takes Tab and Escape: a confirmation opened from a dialog", async () => {
    function Files() {
      const [asking, setAsking] = useState(false);
      return (
        <Dialog open title="Files" onClose={() => undefined} footer={<Button onClick={() => setAsking(true)}>Delete file</Button>}>
          <input aria-label="Path" />
          <ConfirmDialog open={asking} title="Delete the file?" danger onConfirm={() => setAsking(false)} onCancel={() => setAsking(false)} />
        </Dialog>
      );
    }
    render(<Files />);
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    const confirm = screen.getByRole("dialog", { name: "Delete the file?" });
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Cancel" }));
    // Tab from its last button wraps inside the confirmation, not into the outer dialog.
    within(confirm).getByRole("button", { name: "Confirm" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(confirm).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Delete the file?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Files" })).toBeInTheDocument();
    // The outer dialog is on top again and gets the focus back.
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Files" })).toContainElement(document.activeElement as HTMLElement));
  });

  it("a pinned modal (an agent's confirmation) stays on top of one opened after it, earlier in the page or not", async () => {
    function Pinned({ open }: { open: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, open, { alwaysOnTop: true });
      return open ? (
        <div ref={ref} role="alertdialog" aria-modal="true" aria-label="Agent asks" tabIndex={-1}>
          <button>Deny</button>
          <button>Allow</button>
        </div>
      ) : null;
    }
    function Page() {
      const [pinned, setPinned] = useState(true);
      const [later, setLater] = useState(false);
      return (
        <>
          <Pinned open={pinned} />
          <button onClick={() => setLater(true)}>open later</button>
          <button onClick={() => setPinned(false)}>answer</button>
          <Dialog open={later} title="Later" onClose={() => setLater(false)}>
            <input aria-label="Name" />
          </Dialog>
        </>
      );
    }
    render(<Page />);
    const pinned = screen.getByRole("alertdialog", { name: "Agent asks" });
    expect(document.activeElement).toBe(within(pinned).getByRole("button", { name: "Deny" }));
    act(() => screen.getByRole("button", { name: "open later" }).click());
    // The dialog opened later does not take the focus, Tab or Escape while the confirmation is shown.
    expect(document.activeElement).toBe(within(pinned).getByRole("button", { name: "Deny" }));
    within(pinned).getByRole("button", { name: "Allow" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(within(pinned).getByRole("button", { name: "Deny" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Later" })).toBeInTheDocument();

    act(() => screen.getByRole("button", { name: "answer" }).click());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })));
  });
});

describe("initial focus of destructive dialogs", () => {
  it("lands on Cancel, never on a checkbox that makes the action more dangerous", () => {
    render(
      <Dialog
        open
        title="Drain node-1"
        onClose={() => undefined}
        footer={
          <>
            <Button>Cancel</Button>
            <Button variant="danger">Drain</Button>
          </>
        }
      >
        <label>
          <Checkbox /> Force
        </label>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("in a form dialog without a danger button goes to the first text field, past checkboxes", () => {
    render(
      <Dialog open title="Port forward" onClose={() => undefined} footer={<Button>Start</Button>}>
        <Checkbox aria-label="Open in browser" />
        <input aria-label="Local port" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Local port" }));
  });
});

describe("popups", () => {
  function Menu() {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    usePopup(ref, () => setOpen(false), open);
    return (
      <>
        <button onClick={() => setOpen(true)}>menu</button>
        {open && (
          <div ref={ref} role="menu">
            <button role="menuitem" autoFocus>
              item
            </button>
          </div>
        )}
      </>
    );
  }

  it("give the focus back to their opener when Escape closes them", () => {
    render(<Menu />);
    const opener = screen.getByRole("button", { name: "menu" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("menuitem"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("menu then dialog", () => {
  it("Scale from a row's menu: closing the dialog gives the focus back to the row's ⋮ button", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("rt__scroll") ? 660 : 0;
    });
    backend.on("watch_start", () => "w1");
    backend.on("watch_stop", () => undefined);
    const kind = { group: "apps", version: "v1", kind: "Deployment" };
    render(
      <>
        <ResourceTable clusterId="c1" kind={kind} actions={["scale"]} />
        <ActionDialogHost />
      </>,
    );
    await waitFor(() => expect(backend.listenerCount("watch:w1")).toBe(1));
    const web = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: "default", uid: "d1" }, spec: { replicas: 2 } };
    act(() => backend.emit("watch:w1", { type: "snapshot", items: [web] }));
    const more = await screen.findByRole("button", { name: "Actions for web" });
    more.focus();
    fireEvent.click(more);
    const item = await screen.findByRole("menuitem", { name: /Scale/ });
    expect(document.activeElement).toBe(item);
    fireEvent.click(item);
    const dialog = await screen.findByRole("dialog");
    // The replicas field focuses itself (autoFocus) while the menu goes away.
    expect(document.activeElement).toBe(within(dialog).getByRole("spinbutton"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Actions for web" })));
  });
});

describe("details panel", () => {
  const pod = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "default", name: "web-1" };

  it("takes the focus on its heading and gives it back to the trigger on Escape and on Close", () => {
    render(
      <>
        <button>row</button>
        <AppShell />
      </>,
    );
    act(() => useAppStore.getState().setActiveCluster("c1"));
    const row = screen.getByRole("button", { name: "row" });
    row.focus();
    act(() => useAppStore.getState().openDetails(pod));
    const panel = screen.getByRole("complementary", { name: "Details" });
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "web-1" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
    expect(document.activeElement).toBe(row);

    act(() => useAppStore.getState().openDetails(pod));
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(document.activeElement).toBe(row);
  });
});

describe("dock", () => {
  it("is a tab list of the tabs only; arrows move between tabs, Delete closes one, Escape returns the focus", () => {
    render(
      <>
        <button>trigger</button>
        <Dock />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "trigger" });
    trigger.focus();
    act(() => void useAppStore.getState().openDockTab({ id: "a", type: "logs", title: "web-1", payload: null }));
    act(() => void useAppStore.getState().openDockTab({ id: "b", type: "logs", title: "web-2", payload: null }));
    const list = screen.getByRole("tablist", { name: "Dock tabs" });
    expect(within(list).getAllByRole("tab").map((t) => t.textContent)).toEqual(["web-1", "web-2"]);
    expect(within(list).queryAllByRole("button")).toEqual([]);
    // A tab opened while the focus was outside the dock takes it.
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "web-2" }));
    expect(screen.getByRole("tab", { name: "web-1" })).toHaveAttribute("tabindex", "-1");
    // Only the active tab's close button is a tab stop; the tab list is a real box laid out by subgrid.
    expect(screen.getByRole("button", { name: "Close tab web-1" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Close tab web-2" })).toHaveAttribute("tabindex", "0");
    expect(cssRule("src/layout/layout.css", ".dock__tablist")).toMatchObject({ display: "grid", "grid-template-columns": "subgrid" });

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "web-1" }));
    expect(useAppStore.getState().dock.activeTabId).toBe("a");

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);

    screen.getByRole("tab", { name: "web-1" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    expect(useAppStore.getState().dock.tabs.map((t) => t.id)).toEqual(["b"]);
    expect(screen.getByRole("button", { name: "Close tab web-2" })).toBeInTheDocument();
  });
});

describe("terminal", () => {
  const key = (e: Partial<KeyboardEvent>) =>
    isLeaveTerminalKey({ type: "keydown", key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...e });

  it("Ctrl+Shift+E leaves it by the letter typed, by the physical key only without a Latin letter there", () => {
    expect(key({ key: "E", code: "KeyE", ctrlKey: true, shiftKey: true })).toBe(true);
    // Dvorak: E is on the physical D key; the physical E key types a period.
    expect(key({ key: "E", code: "KeyD", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(key({ key: ">", code: "KeyE", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(key({ key: "U", code: "KeyE", ctrlKey: true, shiftKey: true })).toBe(false);
    // Russian: the E key types У.
    expect(key({ key: "У", code: "KeyE", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(key({ key: "e", code: "KeyE", ctrlKey: true })).toBe(false);
    expect(key({ key: "Escape", code: "Escape" })).toBe(false);
    expect(key({ key: "E", code: "KeyE", ctrlKey: true, shiftKey: true, altKey: true })).toBe(false);
    expect(key({ type: "keyup", key: "E", code: "KeyE", ctrlKey: true, shiftKey: true })).toBe(false);
  });
});
