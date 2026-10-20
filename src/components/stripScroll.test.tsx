import { fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { cssRule } from "../test/css";
import { Tabs } from "./Tabs";

const TABS = ["one", "two", "three", "four"].map((id) => ({ id, label: id }));

function Harness() {
  const [selected, setSelected] = useState("one");
  return (
    <Tabs label="Sections" tabs={TABS} selected={selected} onSelect={setSelected}>
      <p>{selected}</p>
    </Tabs>
  );
}

/** Gives `el` the box of a strip `view` px wide over `content` px of tabs (jsdom lays nothing out). */
function overflow(el: HTMLElement, view: number, content: number): void {
  let left = 0;
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => view });
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => content });
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (v: number) => void (left = Math.max(0, Math.min(content - view, v))),
  });
}

describe("a sideways-scrolling tab strip", () => {
  it("hides its scrollbar (GTK draws it over the labels) and fades the edges with tabs behind them", () => {
    for (const [file, selector] of [
      ["src/components/tabs.css", ".tabs__list"],
      ["src/layout/layout.css", ".dock__tabs"],
    ] as const) {
      expect(cssRule(file, selector)).toMatchObject({ "overflow-x": "auto", "scrollbar-width": "none" });
      expect(cssRule(file, `${selector}::-webkit-scrollbar`)).toMatchObject({ display: "none" });
      expect(cssRule(file, `${selector}[data-fade="end"]`)["mask-image"]).toMatch(/linear-gradient/);
    }
    // No strip sets its own scrollbar width: WebKit then ignores `::-webkit-scrollbar` and draws the bar again.
    const css = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? css(`${dir}/${e.name}`) : e.name.endsWith(".css") ? [`${dir}/${e.name}`] : [],
      );
    const widths = css("src").flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/([^{}]*\.tabs__list[^{}]*)\{[^}]*scrollbar-width:\s*(?!\s|none)/g)].map(
        (m) => `${file}: ${m[1]!.trim()}`,
      ),
    );
    expect(widths).toEqual([]);
  });

  it("scrolls sideways with the mouse wheel while it overflows, and marks the edges", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Sections" });
    overflow(list, 200, 500);
    fireEvent.scroll(list);
    expect(list.dataset.fade).toBe("end");

    const wheel = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    list.dispatchEvent(wheel);
    expect(list.scrollLeft).toBe(100);
    expect(wheel.defaultPrevented).toBe(true);
    fireEvent.scroll(list); // a browser fires it after the scroll; jsdom does not
    expect(list.dataset.fade).toBe("both");

    // At the end the wheel is left to the page.
    list.scrollLeft = 300;
    const more = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    list.dispatchEvent(more);
    expect(more.defaultPrevented).toBe(false);
  });

  it("leaves the wheel alone when nothing overflows", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Sections" });
    overflow(list, 500, 500);
    const wheel = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
    list.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(list.dataset.fade).toBeUndefined();
  });

  it("brings the tab selected from the keyboard into view", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Sections" });
    overflow(list, 200, 500);
    list.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, width: 200, height: 30 });
    const four = screen.getByRole("tab", { name: "four" });
    four.getBoundingClientRect = () => DOMRect.fromRect({ x: 400 - list.scrollLeft, width: 100, height: 30 });
    screen.getByRole("tab", { name: "one" }).focus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(four).toHaveAttribute("aria-selected", "true");
    // Its right edge (500) and the room kept beside it fit in the 200 px view.
    expect(list.scrollLeft).toBe(300);
  });
});
