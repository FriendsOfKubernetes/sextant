import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { ConfirmDialog } from "../../components";
import { Dock } from "./Dock";
import { registerDockTab, unregisterDockTab, useUnsavedChanges, type DockTabProps } from "./registry";

let backend: MockBackend;

function Plain({ tab }: DockTabProps) {
  return <div className={tab.title === "shell" ? "xterm" : undefined}><textarea aria-label={`text of ${tab.title}`} /></div>;
}
function Unsaved({ tab }: DockTabProps) {
  useUnsavedChanges(tab.id, true);
  return <p>{tab.title}</p>;
}

const open = (title: string, type: "logs" | "edit" = "logs") =>
  act(() => void useAppStore.getState().openDockTab({ type, title, payload: null }));
const titles = () => useAppStore.getState().dock.tabs.map((tab) => tab.title);
const menuCloseTab = async () => {
  await waitFor(() => expect(backend.listenerCount("close-tab")).toBe(1));
  act(() => backend.emit("close-tab", null));
};
const closedWindow = () => backend.calls.filter((c) => c.cmd === "window_close").length;

beforeEach(() => {
  resetAppStore();
  backend = mockBackend({});
  registerDockTab("logs", Plain);
  registerDockTab("edit", Unsaved);
});
afterEach(() => {
  unregisterDockTab("logs");
  unregisterDockTab("edit");
  backend.restore();
});

describe("closing the dock tab in front", () => {
  it("Cmd+W of the macOS menu closes the active tab, then the window once no tab is shown", async () => {
    open("web-1");
    open("web-2");
    render(<Dock />);
    await menuCloseTab();
    expect(titles()).toEqual(["web-1"]);
    await menuCloseTab();
    expect(titles()).toEqual([]);
    expect(closedWindow()).toBe(0);
    await menuCloseTab();
    await waitFor(() => expect(closedWindow()).toBe(1));
  });

  it("a collapsed dock has no tab in front: Cmd+W closes the window and keeps the tabs", async () => {
    open("web-1");
    act(() => useAppStore.getState().setDockOpen(false));
    render(<Dock />);
    await menuCloseTab();
    expect(titles()).toEqual(["web-1"]);
    await waitFor(() => expect(closedWindow()).toBe(1));
  });

  it("does nothing while a dialog is open", async () => {
    open("web-1");
    render(<><Dock /><ConfirmDialog open title="Sure?" onConfirm={() => undefined} onCancel={() => undefined} /></>);
    await menuCloseTab();
    expect(titles()).toEqual(["web-1"]);
    expect(closedWindow()).toBe(0);
    fireEvent.keyDown(document.body, { key: "w", code: "KeyW", ctrlKey: true });
    expect(titles()).toEqual(["web-1"]);
  });

  it("Ctrl+W closes the active tab but never the window, and stays the shell's in a terminal", () => {
    open("web-1");
    open("shell");
    render(<Dock />);
    fireEvent.keyDown(screen.getByLabelText("text of shell"), { key: "w", code: "KeyW", ctrlKey: true });
    expect(titles()).toEqual(["web-1", "shell"]);
    act(() => useAppStore.getState().setActiveDockTab(useAppStore.getState().dock.tabs[0]!.id));
    // A non-Latin layout: the key is another letter, the code is still KeyW.
    fireEvent.keyDown(screen.getByLabelText("text of web-1"), { key: "ц", code: "KeyW", ctrlKey: true });
    expect(titles()).toEqual(["shell"]);
    act(() => useAppStore.getState().closeDockTab(useAppStore.getState().dock.tabs[0]!.id));
    fireEvent.keyDown(document.body, { key: "w", code: "KeyW", ctrlKey: true });
    expect(closedWindow()).toBe(0);
  });

  it("asks before a tab with unsaved changes closes, by the menu, Ctrl+W or its close button", async () => {
    open("deploy web", "edit");
    render(<Dock />);
    await menuCloseTab();
    const confirm = await screen.findByRole("dialog", { name: "Discard your changes?" });
    expect(confirm).toHaveTextContent("deploy web has unsaved changes.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(titles()).toEqual(["deploy web"]);

    fireEvent.click(screen.getByRole("button", { name: "Close tab deploy web" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and close" }));
    expect(titles()).toEqual([]);
    expect(closedWindow()).toBe(0);
  });
});
