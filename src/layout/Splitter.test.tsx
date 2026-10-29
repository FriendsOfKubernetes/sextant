import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Splitter } from "./Splitter";

afterEach(() => document.body.classList.remove("resizing-x", "resizing-y"));

describe("splitter interaction", () => {
  it.each([
    ["vertical", 1, "ArrowRight", "ArrowLeft"],
    ["vertical", -1, "ArrowLeft", "ArrowRight"],
    ["horizontal", 1, "ArrowDown", "ArrowUp"],
    ["horizontal", -1, "ArrowUp", "ArrowDown"],
  ] as const)("keyboard follows the %s direction %i", (orientation, direction, grow, shrink) => {
    const resize = vi.fn();
    render(<Splitter orientation={orientation} direction={direction} label="Resize" value={725} min={480} max={1000} onResize={resize} />);
    const handle = screen.getByRole("separator");
    fireEvent.keyDown(handle, { key: grow });
    expect(resize).toHaveBeenLastCalledWith(741);
    fireEvent.keyDown(handle, { key: shrink });
    expect(resize).toHaveBeenLastCalledWith(709);
  });

  it.each(["pointercancel", "lostpointercapture", "unmount"])("cleans up an active drag on %s", (event) => {
    const resize = vi.fn();
    const view = render(<Splitter orientation="vertical" direction={-1} label="Resize" value={725} min={480} max={1000} onResize={resize} />);
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    expect(document.body).toHaveClass("resizing-x");
    fireEvent.pointerMove(handle, { clientX: 450, pointerId: 1 });
    expect(resize).toHaveBeenLastCalledWith(775);
    if (event === "unmount") view.unmount();
    else fireEvent(handle, new Event(event, { bubbles: true }));
    expect(document.body).not.toHaveClass("resizing-x");
    resize.mockClear();
    if (event !== "unmount") fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    expect(resize).not.toHaveBeenCalled();
  });
});
