// Putting the clusters of the rail in order: by dragging (pointer events), with Alt+Up / Alt+Down, and from the
// cluster menu; the order is saved in `settings.clusterOrder` and is global (a workspace shows its clusters in it).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type AppSettings, type ClusterInfo, type MockBackend } from "../../api";
import { getSettingsSnapshot, resetSettingsCache } from "../../api/settings";
import { resetAppStore } from "../../app/store";
import { ClusterRail } from "../../layout/ClusterRail";
import { axeViolations } from "../../test/axe";
import { resetClustersStore } from "./clustersStore";
import "./index";

function cluster(id: string): ClusterInfo {
  return {
    id,
    context: `kind-${id}`,
    clusterName: id,
    server: `https://${id}.example:6443`,
    user: "admin",
    namespace: null,
    sourceId: "src",
  };
}

let backend: MockBackend;

function setup(ids: string[], settings: Partial<AppSettings> = {}) {
  backend = mockBackend(
    {
      clusters_list: () => ids.map(cluster),
      kubeconfig_sources: () => [{ id: "src", path: "/k.yaml", kind: "default", error: null }],
      cluster_state: () => ({ state: "disconnected" }),
      cluster_connect: () => new Promise(() => undefined),
    },
    { settings },
  );
}

const list = () => screen.getByRole("list", { name: "Cluster list" });
const railOrder = () => within(list()).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
const button = (id: string) => within(list()).getByRole("button", { name: `kind-${id}` });
const savedOrder = () => getSettingsSnapshot()?.clusterOrder;
const connects = () => backend.calls.filter((c) => c.cmd === "cluster_connect");
const announced = () => screen.getByTestId("rail-announce").textContent;

/** Lays the rail's items out 50 px apart, 40 px high (jsdom has no layout). */
function layOut() {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const li = this.tagName === "LI" ? this : null;
    const index = li?.parentElement ? Array.from(li.parentElement.children).indexOf(li) : 0;
    return { top: index * 50, height: 40, bottom: index * 50 + 40, left: 0, right: 40, width: 40, x: 0, y: index * 50, toJSON: () => ({}) } as DOMRect;
  });
}

const pointer = { pointerId: 1, button: 0, buttons: 1 };

async function renderRail(ids: string[], settings: Partial<AppSettings> = {}) {
  setup(ids, settings);
  render(<ClusterRail />);
  await within(screen.getByRole("navigation", { name: "Clusters" })).findByRole("button", { name: `kind-${ids[0]}` });
  await waitFor(() => expect(getSettingsSnapshot()).not.toBeNull());
}

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
  resetSettingsCache();
});
afterEach(() => {
  resetClustersStore();
  backend.restore();
  vi.restoreAllMocks();
});

describe("dragging a cluster in the rail", () => {
  it("moves the third cluster to the top, saves the order and says so; the release does not open it", async () => {
    await renderRail(["a", "b", "c"]);
    layOut();
    const c = button("c");
    fireEvent.pointerDown(c, { ...pointer, clientX: 20, clientY: 120 });
    fireEvent.pointerMove(c, { ...pointer, clientX: 20, clientY: 60 });
    // Over the first item's upper half: the line is drawn before it.
    fireEvent.pointerMove(c, { ...pointer, clientX: 20, clientY: 5 });
    expect(c).toHaveAttribute("data-dragging", "true");
    expect(list().children[0]).toHaveAttribute("data-drop", "before");
    fireEvent.pointerUp(c, { ...pointer, clientX: 20, clientY: 5 });
    fireEvent.click(c);

    expect(railOrder()).toEqual(["kind-c", "kind-a", "kind-b"]);
    await waitFor(() => expect(savedOrder()).toEqual(["c", "a", "b"]));
    expect(announced()).toBe("kind-c moved to position 1 of 3");
    expect(connects()).toHaveLength(0);
    expect(list().querySelector("[data-drop]")).toBeNull();
    expect(c).not.toHaveAttribute("data-dragging");
  });

  it("drops after the last cluster", async () => {
    await renderRail(["a", "b", "c"]);
    layOut();
    const a = button("a");
    fireEvent.pointerDown(a, { ...pointer, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(a, { ...pointer, clientX: 20, clientY: 130 });
    expect(list().children[2]).toHaveAttribute("data-drop", "after");
    fireEvent.pointerUp(a, { ...pointer, clientX: 20, clientY: 130 });
    await waitFor(() => expect(savedOrder()).toEqual(["b", "c", "a"]));
  });

  it("a press that moves less than the threshold is a click: it opens the cluster and moves nothing", async () => {
    await renderRail(["a", "b", "c"]);
    layOut();
    const c = button("c");
    fireEvent.pointerDown(c, { ...pointer, clientX: 20, clientY: 120 });
    fireEvent.pointerMove(c, { ...pointer, clientX: 22, clientY: 117 });
    expect(c).not.toHaveAttribute("data-dragging");
    fireEvent.pointerUp(c, { ...pointer, clientX: 22, clientY: 117 });
    fireEvent.click(c);
    await waitFor(() => expect(connects()).toHaveLength(1));
    expect(railOrder()).toEqual(["kind-a", "kind-b", "kind-c"]);
    expect(savedOrder()).toEqual([]);
  });

  it("Escape cancels the drag: nothing moves and the release does not open the cluster", async () => {
    await renderRail(["a", "b", "c"]);
    layOut();
    const c = button("c");
    fireEvent.pointerDown(c, { ...pointer, clientX: 20, clientY: 120 });
    fireEvent.pointerMove(c, { ...pointer, clientX: 20, clientY: 5 });
    expect(list().querySelector("[data-drop]")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(list().querySelector("[data-drop]")).toBeNull();
    fireEvent.pointerMove(c, { ...pointer, clientX: 20, clientY: 2 });
    expect(list().querySelector("[data-drop]")).toBeNull();
    fireEvent.pointerUp(c, { ...pointer, clientX: 20, clientY: 2 });
    fireEvent.click(c);
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(railOrder()).toEqual(["kind-a", "kind-b", "kind-c"]);
    expect(savedOrder()).toEqual([]);
    expect(connects()).toHaveLength(0);
    // The next click is the user's again.
    fireEvent.click(c);
    await waitFor(() => expect(connects()).toHaveLength(1));
  });

  it("works in the expanded rail too", async () => {
    await renderRail(["a", "b", "c"], { window: { ...defaultWindow(), railExpanded: true } });
    layOut();
    const b = button("b");
    fireEvent.pointerDown(b, { ...pointer, clientX: 20, clientY: 70 });
    fireEvent.pointerMove(b, { ...pointer, clientX: 20, clientY: 140 });
    fireEvent.pointerUp(b, { ...pointer, clientX: 20, clientY: 140 });
    await waitFor(() => expect(savedOrder()).toEqual(["a", "c", "b"]));
  });
});

function defaultWindow(): AppSettings["window"] {
  return {
    sidebarWidth: 220,
    detailsWidths: {},
    dockHeight: 300,
    dockOpen: false,
    lastCluster: null,
    width: null,
    height: null,
    maximized: false,
    railExpanded: false,
  };
}

describe("moving a cluster from the keyboard", () => {
  it("Alt+Up and Alt+Down move the focused cluster, keep the focus on it and announce the new place", async () => {
    await renderRail(["a", "b", "c"]);
    const b = button("b");
    expect(b).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    expect(b).toHaveAccessibleDescription(/Alt\+Up Arrow/);
    b.focus();
    fireEvent.keyDown(b, { key: "ArrowUp", altKey: true });
    expect(railOrder()).toEqual(["kind-b", "kind-a", "kind-c"]);
    expect(document.activeElement).toBe(button("b"));
    expect(announced()).toBe("kind-b moved to position 1 of 3");
    await waitFor(() => expect(savedOrder()).toEqual(["b", "a", "c"]));

    fireEvent.keyDown(button("b"), { key: "ArrowUp", altKey: true });
    expect(railOrder()).toEqual(["kind-b", "kind-a", "kind-c"]);
    fireEvent.keyDown(button("b"), { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(button("b"), { key: "ArrowDown", altKey: true });
    expect(railOrder()).toEqual(["kind-a", "kind-c", "kind-b"]);
    expect(announced()).toBe("kind-b moved to position 3 of 3");
    await waitFor(() => expect(savedOrder()).toEqual(["a", "c", "b"]));
    // A plain arrow is not a move.
    fireEvent.keyDown(button("b"), { key: "ArrowUp" });
    expect(railOrder()).toEqual(["kind-a", "kind-c", "kind-b"]);
  });

  it("the cluster menu moves it up, down, to the top and to the bottom", async () => {
    await renderRail(["a", "b", "c"]);
    fireEvent.contextMenu(button("a"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Move up" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "Move to top" })).toBeDisabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move to bottom" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(railOrder()).toEqual(["kind-b", "kind-c", "kind-a"]);
    expect(announced()).toBe("kind-a moved to position 3 of 3");
    await waitFor(() => expect(savedOrder()).toEqual(["b", "c", "a"]));

    fireEvent.contextMenu(button("a"));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Move down" })).toBeDisabled();
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Move up" }));
    expect(railOrder()).toEqual(["kind-b", "kind-a", "kind-c"]);
    fireEvent.contextMenu(button("c"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Move to top" }));
    expect(railOrder()).toEqual(["kind-c", "kind-b", "kind-a"]);
    await waitFor(() => expect(savedOrder()).toEqual(["c", "b", "a"]));
  });

  it("offers no moves when the rail shows a single cluster", async () => {
    await renderRail(["a"]);
    fireEvent.contextMenu(button("a"));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Move up" })).toBeNull();
    expect(button("a")).not.toHaveAttribute("aria-keyshortcuts");
  });
});

describe("the saved order", () => {
  it("is applied on load: listed clusters first, a new one after them; a move drops the ids of clusters that are gone", async () => {
    await renderRail(["a", "b", "c", "new"], { clusterOrder: ["c", "gone", "a", "b"] });
    expect(railOrder()).toEqual(["kind-c", "kind-a", "kind-b", "kind-new"]);
    fireEvent.keyDown(button("new"), { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(savedOrder()).toEqual(["c", "a", "new", "b"]));
  });

  it("survives a restart (the backend keeps it)", async () => {
    await renderRail(["a", "b", "c"]);
    fireEvent.keyDown(button("c"), { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(savedOrder()).toEqual(["a", "c", "b"]));
    const stored = backend.calls.filter((c) => c.cmd === "settings_update").at(-1)?.args.settings as AppSettings;
    expect(stored.clusterOrder).toEqual(["a", "c", "b"]);
  });

  it("is global: a workspace shows its clusters in it, and a move there keeps the hidden clusters' places", async () => {
    await renderRail(["a", "b", "c", "d"], {
      workspaces: [{ id: "w1", name: "Team", clusters: ["d", "a", "c"] }],
      activeWorkspace: "w1",
    });
    // The workspace's own list order does not matter: the global order does.
    expect(railOrder()).toEqual(["kind-a", "kind-c", "kind-d"]);
    layOut();
    const d = button("d");
    fireEvent.pointerDown(d, { ...pointer, clientX: 20, clientY: 120 });
    fireEvent.pointerMove(d, { ...pointer, clientX: 20, clientY: 5 });
    fireEvent.pointerUp(d, { ...pointer, clientX: 20, clientY: 5 });
    expect(railOrder()).toEqual(["kind-d", "kind-a", "kind-c"]);
    expect(announced()).toBe("kind-d moved to position 1 of 3");
    // b, hidden, stays between a and c.
    await waitFor(() => expect(savedOrder()).toEqual(["d", "a", "b", "c"]));
  });
});

describe("accessibility (axe)", { timeout: 30_000 }, () => {
  it("the rail with its order hint and announcement, and the cluster menu with the moves, have no violations", async () => {
    await renderRail(["a", "b", "c"]);
    fireEvent.keyDown(button("b"), { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(savedOrder()).toEqual(["a", "c", "b"]));
    expect(await axeViolations(document)).toEqual([]);
    fireEvent.contextMenu(button("a"));
    expect(await axeViolations(document)).toEqual([]);
  });
});
