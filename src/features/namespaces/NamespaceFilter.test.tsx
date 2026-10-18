import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppStore } from "../../app/store";
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

/** Places the main area, the filter and its popup on the screen (jsdom lays nothing out). */
function layout(main: { left: number }, filter: { right: number }, popupWidth = 260): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = this.tagName === "MAIN" ? main.left : filter.right - 140;
    const right = this.tagName === "MAIN" ? 1200 : filter.right;
    return { left, right, top: 0, bottom: 32, width: right - left, height: 32, x: left, y: 0, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("ns-filter__popup") ? popupWidth : 140;
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
    expect(openFilter()).not.toHaveClass("ns-filter__popup--left");
  });

  it("opens under the left edge when the right-aligned popup would cross into the sidebar", () => {
    // A filter at the left of a page (Right-sizing): 475 − 260 < 335 would put the popup under the sidebar.
    layout({ left: 335 }, { right: 475 });
    expect(openFilter()).toHaveClass("ns-filter__popup--left");
  });
});
