import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Tabs } from "./Tabs";

type Id = "init" | "app" | "sidecar";
const TABS: Array<{ id: Id; label: string; title?: string }> = [
  { id: "init", label: "init", title: "Init container" },
  { id: "app", label: "app" },
  { id: "sidecar", label: "sidecar" },
];

function Harness({ start = "app" as Id }) {
  const [selected, setSelected] = useState<Id>(start);
  return (
    <Tabs label="Containers" tabs={TABS} selected={selected} onSelect={setSelected}>
      <p>{`Content of ${selected}`}</p>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("is a labelled tab list; the selected tab owns the one panel, which shows the children", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Containers" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["init", "app", "sidecar"]);
    expect(list).toContainElement(tabs[0]!);
    const app = screen.getByRole("tab", { name: "app" });
    expect(app).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "init" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "init" })).toHaveAttribute("title", "Init container");

    const panel = screen.getByRole("tabpanel", { name: "app" });
    expect(panel).toHaveTextContent("Content of app");
    expect(app).toHaveAttribute("aria-controls", panel.id);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  });

  it("only the selected tab names a controlled panel: the others have no panel to point at", () => {
    render(<Harness />);
    expect(screen.getByRole("tab", { name: "init" })).not.toHaveAttribute("aria-controls");
    expect(screen.getByRole("tab", { name: "sidecar" })).not.toHaveAttribute("aria-controls");

    fireEvent.click(screen.getByRole("tab", { name: "sidecar" }));
    const panel = screen.getByRole("tabpanel", { name: "sidecar" });
    expect(screen.getByRole("tab", { name: "sidecar" })).toHaveAttribute("aria-controls", panel.id);
    expect(screen.getByRole("tab", { name: "app" })).not.toHaveAttribute("aria-controls");
    // Every aria-controls points at an element that exists.
    for (const tab of screen.getAllByRole("tab")) {
      const controls = tab.getAttribute("aria-controls");
      if (controls) expect(document.getElementById(controls)).not.toBeNull();
    }
  });

  it("only the selected tab is in the tab order (roving tabindex)", () => {
    render(<Harness />);
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("a click selects a tab", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: "sidecar" }));
    expect(screen.getByRole("tab", { name: "sidecar" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Content of sidecar");
  });

  it("arrows move to the next and previous tab with wrap-around, Home and End to the ends; focus follows", () => {
    render(<Harness start="init" />);
    const tab = (name: string) => screen.getByRole("tab", { name });
    tab("init").focus();

    fireEvent.keyDown(tab("init"), { key: "ArrowRight" });
    expect(tab("app")).toHaveAttribute("aria-selected", "true");
    expect(tab("app")).toHaveFocus();

    fireEvent.keyDown(tab("app"), { key: "End" });
    expect(tab("sidecar")).toHaveAttribute("aria-selected", "true");
    expect(tab("sidecar")).toHaveFocus();

    fireEvent.keyDown(tab("sidecar"), { key: "ArrowRight" });
    expect(tab("init")).toHaveAttribute("aria-selected", "true");
    expect(tab("init")).toHaveFocus();

    fireEvent.keyDown(tab("init"), { key: "ArrowLeft" });
    expect(tab("sidecar")).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Content of sidecar");

    fireEvent.keyDown(tab("sidecar"), { key: "Home" });
    expect(tab("init")).toHaveAttribute("aria-selected", "true");
    expect(tab("init")).toHaveFocus();
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it("uses the id prefix for the ids of tabs and panel", () => {
    render(
      <Tabs label="X" idPrefix="pod-c" tabs={TABS} selected="app" onSelect={() => {}}>
        x
      </Tabs>,
    );
    expect(screen.getByRole("tab", { name: "app" }).id).toBe("pod-c-tab-app");
    expect(screen.getByRole("tabpanel").id).toBe("pod-c-panel-app");
  });
});
