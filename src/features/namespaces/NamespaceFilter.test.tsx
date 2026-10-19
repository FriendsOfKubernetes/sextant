import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppStore } from "../../app/store";
import { layOutPopups, placed } from "../../test/popupLayout";
import { watchBackend, type WatchBackend } from "../details/testing";
import { NamespaceFilter } from "./NamespaceFilter";
import { resetNamespaceRestore } from "./namespaces";

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  wb = watchBackend();
});

afterEach(() => {
  wb.backend.restore();
  vi.restoreAllMocks();
});

/** Places the window, the main area, the filter and its popup on the screen (jsdom lays nothing out). */
function layout(main: { left: number }, filter: { right: number; top?: number }, popupWidth = 260): void {
  layOutPopups({
    window: { width: 1280, height: 720 },
    isPopup: (el) => el.classList.contains("ns-filter__popup"),
    popupSize: () => ({ width: popupWidth, height: 300 }),
    anchorOf: (el) =>
      el.tagName === "MAIN"
        ? { left: main.left, top: 0, width: 1280 - main.left, height: 720 }
        : { left: filter.right - 140, top: filter.top ?? 0, width: 140, height: 32 },
  });
}

function openFilter(): HTMLElement {
  render(
    <main>
      <NamespaceFilter clusterId="c1" />
    </main>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Namespaces: All namespaces" }));
  return screen.getByRole("dialog", { name: "Choose namespaces" });
}

describe("the namespace filter popup", () => {
  it("opens under the button's right edge when there is room on the left", () => {
    layout({ left: 300 }, { right: 1100 });
    const { box, inside } = placed(openFilter());
    expect(box.right).toBe(1100);
    expect(box.top).toBe(36);
    expect(inside).toBe(true);
  });

  it("opens under the left edge when the right-aligned popup would cross into the sidebar", () => {
    // A filter at the left of a page (Right-sizing): 475 − 260 < 335 would put the popup under the sidebar.
    layout({ left: 335 }, { right: 475 });
    const { box } = placed(openFilter());
    expect(box.left).toBeGreaterThanOrEqual(335);
    expect(box.left).toBe(335 + 8);
  });

  it("opens upwards when the filter sits near the bottom of the window (#176)", () => {
    layout({ left: 300 }, { right: 1100, top: 600 });
    const { box, inside } = placed(openFilter());
    expect(box.bottom).toBe(596);
    expect(inside).toBe(true);
  });
});
