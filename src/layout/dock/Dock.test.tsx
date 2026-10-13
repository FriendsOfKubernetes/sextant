import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppStore, useAppStore } from "../../app/store";
import { Dock } from "./Dock";
import { registerDockAction, unregisterDockAction } from "./registry";

const IDS = ["icon", "glyph", "text"];

beforeEach(() => {
  resetAppStore();
  registerDockAction({ id: "icon", order: 1, labelKey: "Create resource", icon: "add", run: vi.fn() });
  registerDockAction({ id: "glyph", order: 2, labelKey: "Glyph action", icon: "⌘", run: vi.fn() });
  registerDockAction({ id: "text", order: 3, labelKey: "Terminal", run: vi.fn() });
});

afterEach(() => IDS.forEach(unregisterDockAction));

describe("Dock", () => {
  it("draws a dock action's icon name as an SVG, a glyph as text, and the label when there is no icon", () => {
    render(<Dock />);
    const create = screen.getByRole("button", { name: "Create resource" });
    expect(create.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(create.textContent).toBe("");
    const glyph = screen.getByRole("button", { name: "Glyph action" });
    expect(glyph.querySelector("svg")).toBeNull();
    expect(glyph).toHaveTextContent("⌘");
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveTextContent("Terminal");
  });

  it("closes a tab and toggles the dock with icon buttons that keep their names", () => {
    act(() => {
      useAppStore.getState().openDockTab({ type: "logs", title: "web-1", payload: null });
    });
    render(<Dock />);
    const close = screen.getByRole("button", { name: "Close tab web-1" });
    expect(close.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(close.textContent).toBe("");
    const toggle = screen.getByRole("button", { name: "Close dock" });
    expect(toggle.querySelector("svg")).not.toBeNull();
    expect(toggle.textContent).toBe("");
  });
});
