import { describe, expect, it } from "vitest";
import { CONFIG_MAP, POD, REPLICA_SET } from "./kinds";
import { HIDDEN_BY_DEFAULT, KIND_GROUP_MIN, layoutMap, MAX_NODES, NODE_W, OWNER_GROUP_MIN, type MapOptions } from "./layout";
import { buildGraph } from "./relations";
import * as data from "./testData";

const NOW = Date.parse("2026-01-01T01:00:00Z");
const options = (extra: Partial<MapOptions> = {}): MapOptions => ({
  hidden: new Set(HIDDEN_BY_DEFAULT),
  expanded: new Set(),
  now: NOW,
  ...extra,
});

describe("the namespace map layout", () => {
  const graph = buildGraph(data.SHOP);

  it("puts kinds in their columns, left to right from the way in", () => {
    const layout = layoutMap(graph, options());
    const x = (kind: string, name: string) => layout.nodes.find((n) => n.kind === kind && n.name === name)!.x;
    expect(x("Ingress", "shop")).toBeLessThan(x("Service", "web"));
    expect(x("Service", "web")).toBeLessThan(x("Deployment", "web"));
    expect(x("Deployment", "web")).toBeLessThan(x("ReplicaSet", "web-7d9f8c6b5"));
    expect(x("ReplicaSet", "web-7d9f8c6b5")).toBeLessThan(x("Pod", "web-7d9f8c6b5-a1"));
    expect(x("Pod", "web-7d9f8c6b5-a1")).toBeLessThan(x("ConfigMap", "web-config"));
    expect(layout.nodes.every((n) => n.x % 1 === 0 && n.y >= 0)).toBe(true);
  });

  it("hides cluster objects and EndpointSlices until asked, and lists every kind for the filter", () => {
    const layout = layoutMap(graph, options());
    expect(layout.nodes.some((n) => n.kind === "Node" || n.kind === "EndpointSlice")).toBe(false);
    expect(layout.kinds.find((k) => k.kind === "Node")?.count).toBe(2);
    const all = layoutMap(graph, options({ hidden: new Set() }));
    expect(all.nodes.filter((n) => n.kind === "Node")).toHaveLength(2);
  });

  it("merges edges between the same drawn nodes and never draws a self edge", () => {
    const layout = layoutMap(graph, options());
    const ids = layout.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(layout.edges.every((e) => e.from !== e.to)).toBe(true);
  });

  it("keeps a small owner's pods apart", () => {
    const layout = layoutMap(graph, options());
    expect(layout.nodes.filter((n) => n.kind === "Pod" && n.node)).toHaveLength(4);
  });
});

describe("a namespace with 2000 pods", () => {
  const pods = data.manyPods(2000);
  const graph = buildGraph([
    { kind: REPLICA_SET, items: [{ metadata: { name: "big-5c8d7f9b6", namespace: "shop", uid: "uid-rs-big" } }] },
    { kind: POD, items: pods },
  ]);

  it("collapses the pods of one owner into one node with their health", () => {
    const started = performance.now();
    const layout = layoutMap(buildGraph([{ kind: POD, items: pods }]), options());
    const elapsed = performance.now() - started;
    const group = layout.nodes.find((n) => n.kind === "Pod")!;
    expect(layout.nodes.filter((n) => n.kind === "Pod")).toHaveLength(1);
    expect(group.members).toHaveLength(2000);
    expect(group.health).toBe("problem");
    expect(group.healthCounts.problem).toBe(200);
    expect(group.healthCounts.ok).toBe(1800);
    // Graph + layout of 2000 pods stays well under a frame budget's worth of seconds on a loaded CI machine.
    expect(elapsed).toBeLessThan(1500);
  });

  it("expanding a group draws at most EXPANDED_MAX members and keeps the rest grouped", () => {
    const groupId = layoutMap(graph, options()).nodes.find((n) => n.kind === "Pod")!.groupId!;
    const layout = layoutMap(graph, options({ expanded: new Set([groupId]) }));
    const podNodes = layout.nodes.filter((n) => n.kind === "Pod");
    expect(podNodes.filter((n) => n.node)).toHaveLength(100);
    const rest = podNodes.find((n) => n.remainder)!;
    expect(rest.members).toHaveLength(1900);
    expect(layout.nodes.length).toBeLessThanOrEqual(MAX_NODES);
  });

  it("the drawn nodes stay bounded whatever the namespace holds", () => {
    const configMaps = Array.from({ length: 500 }, (_, i) => ({ metadata: { name: `cm-${i}`, namespace: "shop" } }));
    const layout = layoutMap(buildGraph([{ kind: CONFIG_MAP, items: configMaps }, { kind: POD, items: pods }]), options());
    expect(layout.nodes.length).toBeLessThan(10);
    expect(layout.nodes.find((n) => n.kind === "ConfigMap")?.members.length).toBeGreaterThan(KIND_GROUP_MIN);
  });

  it("groups only past the threshold", () => {
    const few = buildGraph([{ kind: POD, items: data.manyPods(OWNER_GROUP_MIN) }]);
    expect(layoutMap(few, options()).nodes.filter((n) => n.kind === "Pod" && n.node)).toHaveLength(OWNER_GROUP_MIN);
    expect(NODE_W).toBeGreaterThan(0);
  });
});
