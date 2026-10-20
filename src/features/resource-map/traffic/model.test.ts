import { describe, expect, it } from "vitest";
import { edge, SHOP_EDGES, unknown, workload } from "./fixtures";
import {
  errorLevel,
  layoutTraffic,
  matchesFilters,
  MAX_STROKE,
  MIN_STROKE,
  NO_FILTERS,
  peerId,
  strokeWidth,
  worstLevel,
} from "./model";

describe("the traffic model", () => {
  it("draws one node per end, an unknown end per namespace (or one without)", () => {
    expect(peerId(workload("shop", "web"))).toBe("workload|shop|web");
    expect(peerId(unknown())).toBe("unknown||");
    expect(peerId(unknown("shop"))).toBe("unknown|shop|");
    const layout = layoutTraffic(SHOP_EDGES);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual([
      "service||api.example.com",
      "unknown||",
      "workload|cache|redis",
      "workload|pay|db",
      "workload|shop|frontend",
      "workload|shop|web",
    ]);
  });

  it("puts callers left of what they call, one column per hop", () => {
    const layout = layoutTraffic(SHOP_EDGES);
    const column = (id: string) => layout.nodes.find((n) => n.id === id)!.column;
    expect(column("workload|shop|frontend")).toBe(0);
    expect(column("unknown||")).toBe(0);
    expect(column("workload|shop|web")).toBe(1);
    expect(column("workload|pay|db")).toBe(2);
    const x = (id: string) => layout.nodes.find((n) => n.id === id)!.x;
    expect(x("workload|shop|frontend")).toBeLessThan(x("workload|shop|web"));
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.maxRate).toBe(12);
  });

  it("a cycle nobody else calls still gets columns", () => {
    const a = workload("shop", "a");
    const b = workload("shop", "b");
    const layout = layoutTraffic([edge(a, b), edge(b, a)]);
    expect(layout.nodes.map((n) => n.column).sort()).toEqual([0, 1]);
  });

  it("merges the edges of one pair into one line with the worst error level", () => {
    const from = workload("shop", "web");
    const to = workload("pay", "db");
    const layout = layoutTraffic([
      edge(from, to, { source: "istio", rate: 2, errorRatio: 0 }),
      edge(from, to, { source: "hubble", rate: 3, errorRatio: 0.2 }),
    ]);
    expect(layout.links).toHaveLength(1);
    expect(layout.links[0]!.level).toBe("bad");
  });

  it("does not add up two sources seeing the same calls, nor connections to requests", () => {
    const from = workload("shop", "web");
    const to = workload("pay", "db");
    const layout = layoutTraffic([
      // Istio and Hubble on Cilium both see these calls: the busier source's, not 5.
      edge(from, to, { source: "istio", rate: 2 }),
      edge(from, to, { source: "istio", protocol: "grpc", rate: 1 }),
      edge(from, to, { source: "hubble", rate: 2.5 }),
      // Connections per second are another unit: kept apart, never added to the requests.
      edge(from, to, { source: "istio", protocol: "tcp", rate: 40, errorRatio: null }),
    ]);
    const link = layout.links[0]!;
    // Istio's HTTP and gRPC are different calls: 3 req/s, the busier of 3 (Istio) and 2.5 (Hubble).
    expect(link.rate).toBe(3);
    expect(link.tcpRate).toBe(40);
    expect(layout.maxRate).toBe(3);
    const node = (id: string) => layout.nodes.find((n) => n.id === id)!;
    expect(node("workload|shop|web").outRate).toBe(3);
    expect(node("workload|pay|db").inRate).toBe(3);
    // A pair seen only as TCP connections is drawn thin.
    const tcpOnly = layoutTraffic([edge(from, to, { protocol: "tcp", rate: 100, errorRatio: null })]);
    expect(tcpOnly.links[0]!.rate).toBe(0);
    expect(strokeWidth(tcpOnly.links[0]!.rate, tcpOnly.maxRate)).toBe(MIN_STROKE);
  });

  it("colours by error share: under 1 %, up to 5 %, above; TCP is unknown", () => {
    expect(errorLevel(0)).toBe("ok");
    expect(errorLevel(0.009)).toBe("ok");
    expect(errorLevel(0.01)).toBe("warn");
    expect(errorLevel(0.05)).toBe("bad");
    expect(errorLevel(null)).toBe("unknown");
    expect(worstLevel(["unknown", "ok"])).toBe("ok");
    expect(worstLevel([])).toBe("unknown");
  });

  it("thickness grows with the rate on a log scale, within bounds", () => {
    expect(strokeWidth(0, 100)).toBe(MIN_STROKE);
    expect(strokeWidth(100, 100)).toBe(MAX_STROKE);
    const mid = strokeWidth(1, 100);
    expect(mid).toBeGreaterThan(MIN_STROKE);
    expect(mid).toBeLessThan(MAX_STROKE);
    expect(strokeWidth(5, 0)).toBe(MIN_STROKE);
  });

  it("filters by namespace, protocol and status", () => {
    const keep = (filters: Partial<typeof NO_FILTERS>) =>
      SHOP_EDGES.filter((e) => matchesFilters(e, { ...NO_FILTERS, ...filters })).length;
    expect(keep({})).toBe(5);
    expect(keep({ namespace: "pay" })).toBe(1);
    expect(keep({ protocol: "grpc" })).toBe(1);
    expect(keep({ protocol: "tcp" })).toBe(1);
    expect(keep({ status: "errors" })).toBe(2);
    expect(keep({ status: "5xx" })).toBe(1);
    expect(keep({ status: "4xx" })).toBe(1);
    // TCP has no status class: only "any status" shows it.
    expect(keep({ status: "2xx", protocol: "tcp" })).toBe(0);
  });
});
