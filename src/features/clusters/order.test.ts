import { describe, expect, it } from "vitest";
import { gapTarget, MAX_CLUSTER_ORDER, moveCluster, orderClusters, stepTarget } from "./order";
import { edgeScrollStep, EDGE_SCROLL_MAX_STEP, gapAt } from "./railDrag";

const ids = (list: { id: string }[]) => list.map((c) => c.id);
const of = (...names: string[]) => names.map((id) => ({ id }));

describe("orderClusters", () => {
  it("keeps the default order without a saved one", () => {
    expect(ids(orderClusters(of("a", "b", "c"), []))).toEqual(["a", "b", "c"]);
    expect(ids(orderClusters(of("a", "b", "c"), undefined))).toEqual(["a", "b", "c"]);
  });

  it("puts the saved ones first in the saved order, then new clusters in the default order", () => {
    expect(ids(orderClusters(of("a", "b", "c", "d"), ["c", "a"]))).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores saved ids of clusters that are gone, and repeats", () => {
    expect(ids(orderClusters(of("a", "b"), ["gone", "b", "b", "a"]))).toEqual(["b", "a"]);
  });
});

describe("moveCluster", () => {
  const all = ["a", "b", "c", "d"];

  it("moves to a place among the visible clusters", () => {
    expect(moveCluster(all, all, "c", 0)).toEqual(["c", "a", "b", "d"]);
    expect(moveCluster(all, all, "a", 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveCluster(all, all, "b", 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("returns null when nothing changes or the cluster is not shown", () => {
    expect(moveCluster(all, all, "a", 0)).toBeNull();
    expect(moveCluster(all, all, "a", -1)).toBeNull();
    expect(moveCluster(all, all, "d", 9)).toBeNull();
    expect(moveCluster(all, ["a", "b"], "c", 0)).toBeNull();
  });

  it("in a filtered rail moves relative to the visible neighbours and leaves hidden clusters where they are", () => {
    // The workspace shows a, c and d; b is hidden.
    expect(moveCluster(all, ["a", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveCluster(all, ["a", "c", "d"], "a", 1)).toEqual(["b", "c", "a", "d"]);
    expect(moveCluster(all, ["a", "c", "d"], "a", 2)).toEqual(["b", "c", "d", "a"]);
  });

  it("writes only the clusters there are (the ids of removed ones are dropped) and stays under the cap", () => {
    const saved = ["gone", "b", "a"];
    const current = ids(orderClusters(of("a", "b", "new"), saved));
    expect(moveCluster(current, current, "new", 0)).toEqual(["new", "b", "a"]);
    const many = Array.from({ length: MAX_CLUSTER_ORDER + 3 }, (_, i) => `c${i}`);
    expect(moveCluster(many, many, "c1", 0)).toHaveLength(MAX_CLUSTER_ORDER);
  });
});

describe("move targets", () => {
  it("steps up, down, to the top and to the bottom", () => {
    expect(stepTarget("up", 2, 4)).toBe(1);
    expect(stepTarget("down", 2, 4)).toBe(3);
    expect(stepTarget("top", 2, 4)).toBe(0);
    expect(stepTarget("bottom", 2, 4)).toBe(3);
  });

  it("turns a drop gap into a place (the dragged item itself does not count)", () => {
    expect(gapTarget(0, 2)).toBe(0);
    expect(gapTarget(2, 2)).toBe(2);
    expect(gapTarget(3, 2)).toBe(2);
    expect(gapTarget(4, 2)).toBe(3);
  });

  it("finds the gap from the items' middles", () => {
    const boxes = [0, 50, 100].map((top) => ({ top, height: 40 }));
    expect(gapAt(5, boxes)).toBe(0);
    expect(gapAt(25, boxes)).toBe(1);
    expect(gapAt(119, boxes)).toBe(2);
    expect(gapAt(121, boxes)).toBe(3);
  });

  it("scrolls near the edges only, faster closer to them", () => {
    expect(edgeScrollStep(300, 0, 600)).toBe(0);
    expect(edgeScrollStep(0, 0, 600)).toBe(-EDGE_SCROLL_MAX_STEP);
    expect(edgeScrollStep(600, 0, 600)).toBe(EDGE_SCROLL_MAX_STEP);
    const near = edgeScrollStep(590, 0, 600);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(EDGE_SCROLL_MAX_STEP);
  });
});
