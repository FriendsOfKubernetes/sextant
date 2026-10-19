import { describe, expect, it } from "vitest";
import {
  coveredHours,
  filterNamespaces,
  findWorkload,
  GIB,
  isLabelKey,
  MAX_FILTER_NAMESPACES,
  monthlyEstimate,
  rowLabel,
  rowObjectRef,
  savingsEstimate,
  shownParts,
  totalsOf,
  unitPrices,
} from "./model";
import { costRow } from "./testing";

describe("totals", () => {
  it("sum the parts of the rows and keep the idle cost apart", () => {
    const rows = [
      costRow({ cpuCost: 1, ramCost: 2, pvCost: 0.5, totalCost: 3.5 }),
      costRow({ name: "ops", cpuCost: 4, networkCost: 1, otherCost: 0.25, totalCost: 5.25 }),
    ];
    const totals = totalsOf(rows, costRow({ name: "__idle__", totalCost: 2 }));
    expect(totals.parts).toEqual({ cpu: 5, memory: 2, storage: 0.5, network: 1, gpu: 0, other: 0.25 });
    expect([totals.allocated, totals.idle, totals.total]).toEqual([8.75, 2, 10.75]);
    // GPU has no cost here, so it gets no column; "other" does.
    expect(shownParts(totals)).toEqual(["cpu", "memory", "storage", "network", "other"]);
    expect(totalsOf([], null)).toMatchObject({ allocated: 0, idle: 0, total: 0 });
  });
});

describe("monthly estimate", () => {
  it("scales the period's cost to 30 days", () => {
    expect(monthlyEstimate(costRow({ totalCost: 7 }), "week")).toBeCloseTo(30);
    expect(monthlyEstimate(costRow({ totalCost: 2 }), "day")).toBeCloseTo(60);
    expect(monthlyEstimate(costRow({ totalCost: 90 }), "month")).toBeCloseTo(90);
  });

  it("uses the time the group ran when it started inside the period, at least an hour", () => {
    // Ran 2 of the 7 days: 2 per day.
    expect(coveredHours(costRow({ minutes: 2 * 1440 }), "week")).toBe(48);
    expect(monthlyEstimate(costRow({ totalCost: 4, minutes: 2 * 1440 }), "week")).toBeCloseTo(60);
    expect(coveredHours(costRow({ minutes: 5 }), "day")).toBe(1);
    // More minutes than the period (rounding in the API) count as the period.
    expect(coveredHours(costRow({ minutes: 1500 }), "day")).toBe(24);
  });
});

describe("unit prices and savings", () => {
  const row = costRow({ cpuCost: 4.8, cpuCoreHours: 160, ramCost: 1.6, ramByteHours: 320 * GIB });

  it("derive the CPU price per core-hour and the memory price per GiB-hour from the allocation", () => {
    const prices = unitPrices(row);
    expect(prices.cpuPerCoreHour).toBeCloseTo(0.03);
    expect(prices.ramPerGiBHour).toBeCloseTo(0.005);
    expect(unitPrices(costRow())).toEqual({ cpuPerCoreHour: null, ramPerGiBHour: null });
  });

  it("are (current requests − recommended) × unit price over 30 days", () => {
    // 1760m CPU and 1.75 GiB above the recommendation.
    const savings = savingsEstimate({ cpuMillicores: 1760, memoryBytes: 1.75 * GIB }, unitPrices(row))!;
    expect(savings.cpu).toBeCloseTo(1.76 * 0.03 * 720);
    expect(savings.memory).toBeCloseTo(1.75 * 0.005 * 720);
    expect(savings.total).toBeCloseTo(savings.cpu + savings.memory);
    expect(savingsEstimate({ cpuMillicores: 0, memoryBytes: 0 }, unitPrices(row))).toEqual({ cpu: 0, memory: 0, total: 0 });
  });

  it("cannot be estimated without a price for a resource that is lowered", () => {
    const cpuOnly = unitPrices(costRow({ cpuCost: 1, cpuCoreHours: 10 }));
    expect(savingsEstimate({ cpuMillicores: 500, memoryBytes: GIB }, cpuOnly)).toBeNull();
    expect(savingsEstimate({ cpuMillicores: 500, memoryBytes: 0 }, cpuOnly)!.total).toBeCloseTo(0.05 * 720);
  });
});

describe("rows", () => {
  const web = costRow({ name: "shop/deployment:web", controllerKind: "deployment", controller: "web", totalCost: 3 });

  it("find a workload by namespace, kind and name", () => {
    const db = costRow({ name: "ops/statefulset:db", namespace: "ops" });
    expect(findWorkload([db, web], "shop", "Deployment", "web")).toBe(web);
    expect(findWorkload([db, web], "ops", "StatefulSet", "db")).toBe(db);
    expect(findWorkload([db, web], "shop", "StatefulSet", "web")).toBeNull();
  });

  it("are labelled and linked by what they stand for", () => {
    expect(rowLabel(web, { type: "workload" })).toEqual({ kind: "Deployment", name: "web" });
    expect(rowObjectRef(web, { type: "workload" })).toEqual({
      kind: { group: "apps", version: "v1", kind: "Deployment" },
      namespace: "shop",
      name: "web",
    });
    const pod = costRow({ name: "shop/web-1", pod: null });
    expect(rowLabel(pod, { type: "pod" }).name).toBe("web-1");
    expect(rowObjectRef(pod, { type: "pod" })?.kind.kind).toBe("Pod");
    const node = costRow({ name: "node-a", namespace: null, node: "node-a" });
    expect(rowObjectRef(node, { type: "node" })).toEqual({ kind: { group: "", version: "v1", kind: "Node" }, namespace: null, name: "node-a" });
    expect(rowLabel(costRow({ name: "app=web" }), { type: "label", key: "app" }).name).toBe("web");
    expect(rowObjectRef(costRow({ name: "app=web" }), { type: "label", key: "app" })).toBeNull();
    expect(rowObjectRef(costRow({ name: "__unallocated__", namespace: null }), { type: "namespace" })).toBeNull();
  });
});

describe("query input", () => {
  it("accepts label keys only", () => {
    expect(isLabelKey("app")).toBe(true);
    expect(isLabelKey("app.kubernetes.io/name")).toBe(true);
    for (const bad of ["", "a b", "-a", "a/b/c", "a&b", "x/"]) expect(isLabelKey(bad)).toBe(false);
  });

  it("sends a namespace filter only when namespaces are chosen, sorted and capped", () => {
    expect(filterNamespaces(null)).toBeNull();
    expect(filterNamespaces([])).toBeNull();
    expect(filterNamespaces(["b", "a"])).toEqual(["a", "b"]);
    const many = Array.from({ length: MAX_FILTER_NAMESPACES + 5 }, (_, i) => `ns-${String(i).padStart(3, "0")}`);
    expect(filterNamespaces(many)).toHaveLength(MAX_FILTER_NAMESPACES);
  });
});
