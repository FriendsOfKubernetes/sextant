import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject } from "../../api";
import "../../resources";
import { extendActions } from "../../resources/registry";
import { axeViolations } from "../../test/axe";
import { registerAction, resetActions } from "../actions/registry";
import { ActionBar, menuKeyTarget } from "./ActionBar";
import podJson from "./fixtures/pod.json";

const POD = { group: "", version: "v1", kind: "Pod" };
const pod = podJson as KubeObject;

// Pod's own actions are logs, exec, portForward, restart, edit, delete; the tests add these after them.
let removeExtra: () => void = () => undefined;
beforeEach(() => {
  resetActions();
  removeExtra = extendActions(POD, ["setImage", "compareWith", "ext:demo:hello", "pin", "diagnose"]);
});
afterEach(() => removeExtra());

describe("ActionBar", () => {
  it("shows each action as a standard button with its icon and its label", async () => {
    const logs = vi.fn();
    registerAction("logs", { labelKey: "Logs", icon: "logs", placement: "primary", appliesTo: () => true, run: logs });
    registerAction("delete", {
      labelKey: "Delete",
      icon: "delete",
      danger: true,
      placement: "primary",
      appliesTo: () => true,
      run: vi.fn(),
    });
    render(<ActionBar clusterId="c1" kind={POD} obj={pod} />);

    const bar = screen.getByRole("toolbar");
    const logsButton = within(bar).getByRole("button", { name: "Logs" });
    expect(logsButton).toHaveClass("btn");
    expect(logsButton).not.toHaveClass("btn--small");
    expect(logsButton).not.toHaveClass("btn--compact");
    expect(logsButton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(logsButton).toHaveTextContent(/^Logs$/);

    const deleteButton = within(bar).getByRole("button", { name: "Delete" });
    expect(deleteButton).toHaveClass("btn", "btn--danger");
    expect(deleteButton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(deleteButton).toHaveTextContent(/^Delete$/);

    fireEvent.click(logsButton);
    await waitFor(() => expect(logs).toHaveBeenCalledTimes(1));
  });

  it("puts the main actions on buttons, Delete last, and the others in one Actions menu at the end (#275)", () => {
    registerAction("delete", { labelKey: "Delete", icon: "delete", danger: true, placement: "primary", appliesTo: () => true, run: vi.fn() });
    registerAction("logs", { labelKey: "Logs", icon: "logs", placement: "primary", appliesTo: () => true, run: vi.fn() });
    // After Delete in the kind's order, but a button before it.
    registerAction("diagnose", { labelKey: "Diagnose", icon: "connectivity", placement: "primary", appliesTo: () => true, run: vi.fn() });
    registerAction("setImage", { labelKey: "Set image…", icon: "image", placement: "more", appliesTo: () => true, run: vi.fn() });
    // No placement: secondary.
    registerAction("compareWith", { labelKey: "Compare with…", icon: "diff", appliesTo: () => true, run: vi.fn() });
    // An extension cannot make itself a main button.
    registerAction("ext:demo:hello", { label: "Say hello", icon: "logs", placement: "primary", appliesTo: () => true, run: vi.fn() });
    // Offered by the header (copy, pin): in neither.
    registerAction("pin", { labelKey: "Pin to favourites", icon: "pin", inDetails: false, appliesTo: () => true, run: vi.fn() });
    render(<ActionBar clusterId="c1" kind={POD} obj={pod} />);

    const bar = screen.getByRole("toolbar");
    const buttons = within(bar).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Logs", "Diagnose", "Delete", "Actions"]);
    const more = within(bar).getByRole("button", { name: "Actions" });
    expect(more).toHaveAttribute("aria-haspopup", "menu");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(within(bar).queryByRole("button", { name: "Pin to favourites" })).toBeNull();

    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Actions" });
    const items = within(menu).getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(expect.arrayContaining(["Set image…", "Compare with…", "Say hello"]));
    expect(items).toHaveLength(3);
    expect(items).not.toContain("Pin to favourites");
  });

  it("draws no Actions menu when nothing is secondary, and no bar when nothing applies", () => {
    registerAction("logs", { labelKey: "Logs", icon: "logs", placement: "primary", appliesTo: () => true, run: vi.fn() });
    registerAction("pin", { labelKey: "Pin to favourites", icon: "pin", inDetails: false, appliesTo: () => true, run: vi.fn() });
    const { unmount } = render(<ActionBar clusterId="c1" kind={POD} obj={pod} />);
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    unmount();

    resetActions();
    registerAction("pin", { labelKey: "Pin to favourites", icon: "pin", inDetails: false, appliesTo: () => true, run: vi.fn() });
    render(<ActionBar clusterId="c1" kind={POD} obj={pod} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("is a keyboard menu: focus on the first item, arrows, Escape gives the focus back, an item runs and closes", async () => {
    const setImage = vi.fn();
    registerAction("delete", { labelKey: "Delete", icon: "delete", danger: true, placement: "more", appliesTo: () => true, run: vi.fn() });
    registerAction("setImage", { labelKey: "Set image…", icon: "image", appliesTo: () => true, run: setImage });
    render(<ActionBar clusterId="c1" kind={POD} obj={pod} />);
    const more = screen.getByRole("button", { name: "Actions" });
    more.focus();
    fireEvent.keyDown(more, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    const [first, second] = within(menu).getAllByRole("menuitem");
    expect(document.activeElement).toBe(first);
    // The danger style stays in the menu.
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toHaveClass("rt-menu__item--danger");
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: "End" });
    expect(document.activeElement).toBe(second);
    expect(await axeViolations()).toEqual([]);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(more);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Set image…" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(setImage).toHaveBeenCalledTimes(1));
  });

  it("has no axe violations with buttons and the Actions button", async () => {
    registerAction("logs", { labelKey: "Logs", icon: "logs", placement: "primary", appliesTo: () => true, run: vi.fn() });
    registerAction("setImage", { labelKey: "Set image…", icon: "image", appliesTo: () => true, run: vi.fn() });
    render(<ActionBar clusterId="c1" kind={POD} obj={pod} />);
    expect(await axeViolations()).toEqual([]);
  });
});

describe("menuKeyTarget", () => {
  it("wraps the arrows and goes to the ends on Home and End", () => {
    expect(menuKeyTarget("ArrowDown", 2, 3)).toBe(0);
    expect(menuKeyTarget("ArrowUp", 0, 3)).toBe(2);
    expect(menuKeyTarget("ArrowDown", -1, 3)).toBe(0);
    expect(menuKeyTarget("Home", 2, 3)).toBe(0);
    expect(menuKeyTarget("End", 0, 3)).toBe(2);
    expect(menuKeyTarget("a", 0, 3)).toBeNull();
    expect(menuKeyTarget("ArrowDown", 0, 0)).toBeNull();
  });
});
