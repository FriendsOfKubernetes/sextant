import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppStore, useAppStore } from "../../app/store";
import { axeViolations } from "../../test/axe";
import { layOutPopups, placed } from "../../test/popupLayout";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
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

describe("the order of the namespace list (#219)", () => {
  const NAMES = ["default", "kube-system", "shop", "payments", "web"];

  /** The namespace names of the open list, top to bottom, with "|" where the separator is. */
  function listed(dialog: HTMLElement): string[] {
    const list = dialog.querySelector(".ns-filter__list")!;
    return [...list.children].map((el) => (el.getAttribute("role") === "separator" ? "|" : (el.textContent ?? "")));
  }

  async function renderWithNamespaces(selected: string[] | null): Promise<HTMLElement> {
    useAppStore.getState().setNamespaces("c1", selected);
    render(
      <main>
        <NamespaceFilter clusterId="c1" />
      </main>,
    );
    const id = await watchOf(wb, "Namespace");
    emitSnapshot(
      wb,
      id,
      NAMES.map((name) => ({ apiVersion: "v1", kind: "Namespace", metadata: { name, uid: name } })),
    );
    return screen.getByRole("button", { name: /^Namespaces: / });
  }

  function toggleOpen(button: HTMLElement): HTMLElement | null {
    fireEvent.click(button);
    return screen.queryByRole("dialog", { name: "Choose namespaces" });
  }

  it("lists the selected namespaces first on opening, does not move them while open, and sorts again on reopening", async () => {
    const button = await renderWithNamespaces(["web", "payments"]);
    const dialog = toggleOpen(button)!;
    expect(listed(dialog)).toEqual(["payments", "web", "|", "default", "kube-system", "shop"]);

    // Unticking "web" and ticking "shop" while the list is open moves nothing.
    fireEvent.click(screen.getByRole("checkbox", { name: "web" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "shop" }));
    expect(useAppStore.getState().clusterViews.c1?.namespaces).toEqual(["payments", "shop"]);
    expect(listed(dialog)).toEqual(["payments", "web", "|", "default", "kube-system", "shop"]);

    // Closed and opened again: the new selection is on top.
    expect(toggleOpen(button)).toBeNull();
    const reopened = toggleOpen(button)!;
    expect(listed(reopened)).toEqual(["payments", "shop", "|", "default", "kube-system", "web"]);
  });

  it("keeps the split while filtering, and the focus order follows the list", async () => {
    const button = await renderWithNamespaces(["web", "kube-system"]);
    const dialog = toggleOpen(button)!;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "e" } });
    expect(listed(dialog)).toEqual(["kube-system", "web", "|", "default", "payments"]);
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].map(
      (box) => box.closest("label")?.textContent,
    );
    expect(boxes).toEqual(["All namespaces", "kube-system", "web", "default", "payments"]);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "web" } });
    expect(listed(dialog)).toEqual(["web"]);
  });

  it("has no axe violations with both groups shown", async () => {
    const button = await renderWithNamespaces(["web"]);
    toggleOpen(button);
    expect(await axeViolations(document)).toEqual([]);
  });

  it("shows no separator while all namespaces are selected", async () => {
    const button = await renderWithNamespaces(null);
    const dialog = toggleOpen(button)!;
    expect(listed(dialog)).toEqual(["default", "kube-system", "payments", "shop", "web"]);
  });
});
