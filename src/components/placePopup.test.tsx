import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { layOutPopups, placed } from "../test/popupLayout";
import { placePopup, pointRect, usePopupPosition, type PopupRect } from "./placePopup";

const WINDOW: PopupRect = { left: 0, top: 0, right: 1000, bottom: 700 };
const MENU = { width: 200, height: 150 };

function button(left: number, top: number, width = 24, height = 24): PopupRect {
  return { left, top, right: left + width, bottom: top + height };
}

describe("placePopup", () => {
  it("opens under the anchor, lined up with its left edge, when there is room", () => {
    expect(placePopup(button(100, 100), MENU, WINDOW)).toEqual({ left: 100, top: 124 });
  });

  it("near the right edge flips to line up with the anchor's right edge (the ⋮ of the last column, #176)", () => {
    // 960 + 200 > 992: opening rightwards would cross the window edge.
    expect(placePopup(button(960, 100), MENU, WINDOW)).toEqual({ left: 984 - 200, top: 124 });
  });

  it("is shifted by the overflow when neither edge of the anchor leaves room", () => {
    // A wide anchor near the right edge: both alignments cross the window, so it is shifted inside.
    const wide = { left: 700, top: 100, right: 1000, bottom: 124 };
    expect(placePopup(wide, { width: 400, height: 150 }, WINDOW)).toEqual({ left: 1000 - 8 - 400, top: 124 });
  });

  it("near the bottom flips up above the anchor", () => {
    expect(placePopup(button(100, 600), MENU, WINDOW)).toEqual({ left: 100, top: 600 - 150 });
  });

  it("a context menu at the bottom-right corner opens up and to the left of the pointer", () => {
    expect(placePopup(pointRect(990, 690), MENU, WINDOW)).toEqual({ left: 790, top: 540 });
    // A pointer within the margin itself: the flipped menu is shifted the last few pixels in.
    expect(placePopup(pointRect(998, 698), MENU, WINDOW)).toEqual({ left: 792, top: 542 });
  });

  it("a context menu with room on neither side is clamped inside the window", () => {
    // 500 px tall in a 520 px window: neither above nor below the pointer fits, so it is shifted up from the bottom.
    const small: PopupRect = { left: 0, top: 0, right: 300, bottom: 520 };
    expect(placePopup(pointRect(150, 260), { width: 250, height: 500 }, small)).toEqual({ left: 42, top: 12 });
  });

  it("taller than the window: starts at the top margin and gets a max-height to scroll", () => {
    expect(placePopup(button(100, 300), { width: 200, height: 900 }, WINDOW)).toEqual({
      left: 100,
      top: 8,
      maxHeight: 700 - 16,
    });
  });

  it("wider than the window: gets a max-width", () => {
    expect(placePopup(button(100, 100), { width: 1200, height: 100 }, WINDOW)).toMatchObject({
      left: 8,
      maxWidth: 1000 - 16,
    });
  });

  it("align end: lined up with the anchor's right edge, flipped to its left edge near the left of the area", () => {
    expect(placePopup(button(500, 100), MENU, WINDOW, { align: "end", gap: 4 })).toEqual({ left: 324, top: 128 });
    const main: PopupRect = { left: 300, top: 0, right: 1000, bottom: 700 };
    expect(placePopup(button(320, 100, 120), MENU, main, { align: "end" })).toEqual({ left: 320, top: 124 });
  });

  it("side right: beside the anchor, flipped to its left at the window edge, raised at the bottom", () => {
    expect(placePopup(button(10, 100, 40, 40), MENU, WINDOW, { side: "right", gap: 4 })).toEqual({ left: 54, top: 100 });
    expect(placePopup(button(900, 100, 40, 40), MENU, WINDOW, { side: "right", gap: 4 })).toEqual({ left: 696, top: 100 });
    // Top-aligned it would cross the bottom: lined up with the anchor's bottom instead.
    expect(placePopup(button(10, 640, 40, 40), MENU, WINDOW, { side: "right" })).toEqual({ left: 50, top: 680 - 150 });
  });
});

function Menu({ anchor, label }: { anchor: PopupRect; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  usePopupPosition(ref, anchor);
  return (
    <div ref={ref} role="menu" className="test-popup">
      {label}
    </div>
  );
}

describe("usePopupPosition", () => {
  const popupLayout = (width: { current: number }) =>
    layOutPopups({
      window: { width: 1000, height: 700 },
      isPopup: (el) => el.classList.contains("test-popup"),
      popupSize: () => ({ width: width.current, height: 150 }),
    });

  it("places the popup inside the window before it is painted, as a fixed box", () => {
    popupLayout({ current: 200 });
    render(<Menu anchor={pointRect(990, 690)} label="menu" />);
    const menu = screen.getByRole("menu");
    expect(menu.style.position).toBe("fixed");
    expect(placed(menu).inside).toBe(true);
  });

  it("places it again when the window is resized", () => {
    popupLayout({ current: 200 });
    render(<Menu anchor={pointRect(500, 100)} label="menu" />);
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("500px");
    act(() => {
      layOutPopups({
        window: { width: 600, height: 700 },
        isPopup: (el) => el.classList.contains("test-popup"),
        popupSize: () => ({ width: 200, height: 150 }),
      });
      window.dispatchEvent(new Event("resize"));
    });
    expect(menu.style.left).toBe("300px");
    expect(placed(menu).inside).toBe(true);
  });

  it("a longer label (another language) that makes the popup wider is still kept inside", () => {
    const width = { current: 160 };
    popupLayout(width);
    const { rerender } = render(<Menu anchor={button(820, 100)} label="Logs" />);
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("820px");
    width.current = 320;
    rerender(<Menu anchor={button(820, 100)} label="Перезапустить развёртывание" />);
    expect(placed(menu).inside).toBe(true);
    expect(menu.style.left).toBe(`${844 - 320}px`);
  });
});
