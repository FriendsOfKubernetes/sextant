import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { axeViolations } from "../../test/axe";
import { AppShell } from "../AppShell";
import { registerPage, unregisterPage } from "../pages";
import { registerDetailsSection, unregisterDetailsSection } from "./registry";

const pod = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "apps", name: "web" };
let backend: MockBackend;
let workspaceWidth = 1000;
const resizeCallbacks = new Set<() => void>();

beforeEach(() => {
  resetAppStore();
  workspaceWidth = 1000;
  resizeCallbacks.clear();
  backend = mockBackend({ resource_get: () => ({ metadata: { name: "web", uid: "u1" } }) });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("workspace__top") ? workspaceWidth : 0;
  });
  vi.stubGlobal("ResizeObserver", class {
    private notify: (() => void) | undefined;
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (!target.classList.contains("workspace__top")) return;
      this.notify = () => this.callback([{ target, contentRect: { width: workspaceWidth } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      resizeCallbacks.add(this.notify);
      this.notify();
    }
    disconnect() { if (this.notify) resizeCallbacks.delete(this.notify); }
    unobserve() {}
  });
});

afterEach(() => { backend.restore(); vi.unstubAllGlobals(); });

function open() {
  render(<AppShell />);
  act(() => {
    useAppStore.getState().setActiveCluster("c1");
    useAppStore.getState().openDetails(pod);
  });
}

const handle = () => screen.getByRole("separator", { name: "Resize resource details" });
function resizeWorkspace(width: number) { act(() => { workspaceWidth = width; for (const notify of resizeCallbacks) notify(); }); }

describe("resource details width", () => {
  it("has no accessibility violations with the resize boundary visible", async () => {
    await act(async () => { open(); });
    expect(handle()).toBeInTheDocument();
    expect(await axeViolations(document)).toEqual([]);
  });

  it("provides a keyboard-accessible left resize boundary with a reasonable minimum", () => {
    open();
    const handle = screen.getByRole("separator", { name: "Resize resource details" });
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-valuemin", "480");
    expect(handle).toHaveAttribute("aria-valuemax", "1000");
    expect(handle).toHaveAttribute("aria-valuenow", "725");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "741");
  });

  it("drags both ways, clamps to the workspace and minimum, and stops after release", () => {
    open();
    fireEvent.pointerDown(handle(), { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 400, pointerId: 1 });
    expect(handle()).toHaveAttribute("aria-valuenow", "825");
    fireEvent.pointerMove(handle(), { clientX: -200, pointerId: 1 });
    expect(handle()).toHaveAttribute("aria-valuenow", "1000");
    fireEvent.pointerMove(handle(), { clientX: 1500, pointerId: 1 });
    expect(handle()).toHaveAttribute("aria-valuenow", "480");
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientX: 0, pointerId: 1 });
    expect(handle()).toHaveAttribute("aria-valuenow", "480");
    expect(document.body).not.toHaveClass("resizing-x");
  });

  it("clamps only the visible size when available space changes, preserving the preference", () => {
    useAppStore.getState().setDetailsWidth("/Pod", 900);
    open();
    resizeWorkspace(600);
    expect(handle()).toHaveAttribute("aria-valuenow", "600");
    expect(handle()).toHaveAttribute("aria-valuemax", "600");
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(useAppStore.getState().detailsWidths["/Pod"]).toBe(900);
    resizeWorkspace(1200);
    expect(handle()).toHaveAttribute("aria-valuenow", "900");
    resizeWorkspace(400);
    expect(screen.queryByRole("separator", { name: "Resize resource details" })).toBeNull();
    expect(document.querySelector(".details-frame")).toHaveStyle({ width: "100%" });
    expect(useAppStore.getState().detailsWidths["/Pod"]).toBe(900);
    resizeWorkspace(1000);
    expect(handle()).toHaveAttribute("aria-valuenow", "900");
  });

  it("uses a full-width card without a handle in the narrow window layout", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    open();
    expect(screen.getByRole("complementary", { name: "Details" })).toBeInTheDocument();
    expect(document.querySelector(".details-frame")).toHaveStyle({ width: "100%" });
    expect(screen.queryByRole("separator", { name: "Resize resource details" })).toBeNull();
  });

  it("shares a kind across objects, namespaces, API versions and clusters, but keeps other groups independent", () => {
    open();
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    act(() => useAppStore.getState().openDetails({ ...pod, namespace: "other", name: "second", kind: { ...pod.kind, version: "v2" } }));
    expect(handle()).toHaveAttribute("aria-valuenow", "741");
    act(() => { useAppStore.getState().setActiveCluster("c2"); useAppStore.getState().openDetails(pod); });
    expect(handle()).toHaveAttribute("aria-valuenow", "741");
    act(() => useAppStore.getState().openDetails({ ...pod, kind: { ...pod.kind, group: "example.test" } }));
    expect(handle()).toHaveAttribute("aria-valuenow", "725");
    act(() => useAppStore.getState().setDetailsWidthPreferences("global", false, {}));
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    act(() => useAppStore.getState().openDetails(pod));
    expect(handle()).toHaveAttribute("aria-valuenow", "741");
  });

  it("cleans up pointer capture state and its observer when the card closes mid-drag", () => {
    open();
    fireEvent.pointerDown(handle(), { clientX: 500, pointerId: 1 });
    expect(document.body).toHaveClass("resizing-x");
    act(() => useAppStore.getState().closeDetails());
    expect(document.body).not.toHaveClass("resizing-x");
    expect(resizeCallbacks.size).toBe(0);
  });

  it("keeps the main table and active section mounted without rerenders, losing scroll, or restarting subscriptions", async () => {
    const mainRenders = vi.fn();
    const detailRenders = vi.fn();
    const Table = () => { mainRenders(); return <p>Table contents</p>; };
    const Content = () => {
      detailRenders();
      const [draft, setDraft] = useState("");
      return <input aria-label="Draft" value={draft} onChange={e => setDraft(e.target.value)} />;
    };
    registerPage({ id: "resize-table", section: "cluster", label: "Table", order: 1, Component: Table });
    registerDetailsSection({ id: "resize-content", label: "Extra", placement: "tab", order: 1, appliesTo: () => true, Component: Content });
    try {
      await act(async () => { open(); useAppStore.getState().setView("c1", "resize-table"); });
      fireEvent.click(screen.getByRole("tab", { name: "Extra" }));
      const input = screen.getByRole("textbox", { name: "Draft" });
      fireEvent.change(input, { target: { value: "keep me" } });
      const body = input.closest(".details__body") as HTMLElement;
      body.scrollTop = 250;
      mainRenders.mockClear(); detailRenders.mockClear();
      const calls = backend.calls.filter(c => c.cmd === "watch_start" || c.cmd === "watch_stop" || c.cmd === "resource_get").length;
      fireEvent.pointerDown(handle(), { clientX: 500, pointerId: 1 });
      for (const clientX of [450, 400, 350]) fireEvent.pointerMove(handle(), { clientX, pointerId: 1 });
      fireEvent.pointerUp(handle(), { pointerId: 1 });
      expect(handle()).toHaveAttribute("aria-valuenow", "875");
      expect(mainRenders).not.toHaveBeenCalled();
      expect(detailRenders).not.toHaveBeenCalled();
      expect(within(screen.getByRole("complementary", { name: "Details" })).getByRole("textbox", { name: "Draft" })).toBe(input);
      expect(input).toHaveValue("keep me");
      expect(body.scrollTop).toBe(250);
      expect(screen.getByRole("tab", { name: "Extra" })).toHaveAttribute("aria-selected", "true");
      expect(backend.calls.filter(c => c.cmd === "watch_start" || c.cmd === "watch_stop" || c.cmd === "resource_get")).toHaveLength(calls);
    } finally { unregisterPage("resize-table"); unregisterDetailsSection("resize-content"); }
  });
});
