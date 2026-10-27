// The metrics-server sample rings (#280, ADR-0125): one sample per poll answer, an hour and MAX_SAMPLES at most, the caps
// per cluster and overall, kept KEEP_MS after the last view, dropped when the cluster's connection comes or goes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeUsage, PodUsage, Usage } from "../../api";
import { useClustersStore } from "../clusters/clustersStore";
import {
  acquireHistory,
  hasHistory,
  HISTORY_MS,
  historyEpochOf,
  historySeries,
  historyStats,
  KEEP_MS,
  MAX_SAMPLES,
  MAX_TARGETS,
  MAX_TARGETS_PER_CLUSTER,
  MIN_SAMPLE_GAP_MS,
  recordSample,
  resetHistory,
  targetUsage,
} from "./history";
import { POLL_INTERVAL_MS } from "./hooks";

let now = 1_700_000_000_000;
const use = (cpu: number, memory = cpu * 1024): Usage => ({ cpuMillicores: cpu, memoryBytes: memory });

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_700_000_000_000;
  resetHistory(() => now);
});

afterEach(() => {
  resetHistory();
  vi.useRealTimers();
  useClustersStore.setState({ states: {} });
});

/** One poll answer `ms` after the last. */
function answer(target: string, usage: Usage | undefined, ms = POLL_INTERVAL_MS, cluster = "c1") {
  now += ms;
  recordSample(cluster, target, {}, usage);
}

describe("a sample ring", () => {
  it("takes one sample per poll answer, however many charts show it", () => {
    acquireHistory("c1", "pod");
    acquireHistory("c1", "pod");
    const source = {};
    recordSample("c1", "pod", source, use(10));
    recordSample("c1", "pod", source, use(10));
    // A new answer right after (a remount, another namespace filter) is not a sample either.
    now += MIN_SAMPLE_GAP_MS - 1;
    recordSample("c1", "pod", {}, use(11));
    answer("pod", use(12));
    expect(historySeries("c1", "pod").cpu).toEqual([
      [Math.floor((now - POLL_INTERVAL_MS - MIN_SAMPLE_GAP_MS + 1) / 1000), 10],
      [Math.floor(now / 1000), 12],
    ]);
    expect(historySeries("c1", "pod").memory.map((p) => p[1])).toEqual([10 * 1024, 12 * 1024]);
  });

  it("records nothing for a target nobody holds, or a missing value", () => {
    recordSample("c1", "other", {}, use(1));
    expect(hasHistory("c1", "other")).toBe(false);
    acquireHistory("c1", "pod");
    answer("pod", undefined);
    expect(historySeries("c1", "pod").cpu).toEqual([]);
  });

  it("keeps the last hour, at most MAX_SAMPLES samples", () => {
    acquireHistory("c1", "pod");
    for (let i = 0; i < 200; i++) answer("pod", use(i));
    const points = historySeries("c1", "pod").cpu;
    expect(points.length).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(points.at(-1)![1]).toBe(199);
    expect((points.at(-1)![0] - points[0]![0]) * 1000).toBeLessThanOrEqual(HISTORY_MS);
    // Quicker answers stop at MAX_SAMPLES.
    for (let i = 0; i < 400; i++) answer("pod", use(i), MIN_SAMPLE_GAP_MS);
    expect(historySeries("c1", "pod").cpu).toHaveLength(MAX_SAMPLES);
  });

  it("is kept KEEP_MS after its last view, so a reopen shows the recent past, then dropped", () => {
    const release = acquireHistory("c1", "pod");
    answer("pod", use(5));
    release();
    release(); // twice is once
    vi.advanceTimersByTime(KEEP_MS - 1000);
    const again = acquireHistory("c1", "pod");
    expect(historySeries("c1", "pod").cpu).toHaveLength(1);
    again();
    vi.advanceTimersByTime(KEEP_MS);
    expect(hasHistory("c1", "pod")).toBe(false);
    expect(historySeries("c1", "pod").cpu).toEqual([]);
  });

  it("holds at most MAX_TARGETS_PER_CLUSTER rings of a cluster: a new one pushes out the one shown longest ago", () => {
    for (let i = 0; i < MAX_TARGETS_PER_CLUSTER; i++) {
      now += 1;
      acquireHistory("c1", `t${i}`)();
    }
    expect(historyStats("c1").ofCluster).toBe(MAX_TARGETS_PER_CLUSTER);
    acquireHistory("c1", "new");
    expect(historyStats("c1").ofCluster).toBe(MAX_TARGETS_PER_CLUSTER);
    expect(hasHistory("c1", "t0")).toBe(false);
    expect(hasHistory("c1", "t1")).toBe(true);
    expect(hasHistory("c1", "new")).toBe(true);
  });

  it("never pushes out a shown ring: without room a new target gets none", () => {
    for (let i = 0; i < MAX_TARGETS_PER_CLUSTER; i++) acquireHistory("c1", `t${i}`);
    acquireHistory("c1", "new");
    expect(hasHistory("c1", "new")).toBe(false);
    answer("new", use(1));
    expect(historySeries("c1", "new").cpu).toEqual([]);
  });

  it("holds at most MAX_TARGETS rings over all clusters", () => {
    let cluster = 0;
    for (let i = 0; i < MAX_TARGETS + 10; i++) {
      if (i % 20 === 0) cluster++;
      now += 1;
      acquireHistory(`c${cluster}`, `t${i}`)();
    }
    expect(historyStats().rings).toBe(MAX_TARGETS);
  });

  it("never pushes out another cluster's ring for one its own cap refuses", () => {
    for (let i = 0; i < MAX_TARGETS_PER_CLUSTER; i++) acquireHistory("c1", `t${i}`);
    // The other rings of the overall cap, idle, in other clusters (each under its own cap).
    for (let i = MAX_TARGETS_PER_CLUSTER; i < MAX_TARGETS; i++) {
      now += 1;
      acquireHistory(`o${Math.floor(i / 20)}`, `t${i}`)();
    }
    expect(historyStats().rings).toBe(MAX_TARGETS);
    acquireHistory("c1", "new");
    expect(hasHistory("c1", "new")).toBe(false);
    expect(historyStats().rings).toBe(MAX_TARGETS);
    expect(hasHistory("o1", `t${MAX_TARGETS_PER_CLUSTER}`)).toBe(true);
    // Room overall is still made from another cluster's idle ring when the cluster's own cap allows one more.
    acquireHistory("c9", "new");
    expect(hasHistory("c9", "new")).toBe(true);
    expect(hasHistory("o1", `t${MAX_TARGETS_PER_CLUSTER}`)).toBe(false);
    expect(historyStats().rings).toBe(MAX_TARGETS);
  });

  it("goes when the cluster's connection comes or goes, and its epoch moves on", () => {
    useClustersStore.setState({ states: { c1: { state: "connected" } as never } });
    acquireHistory("c1", "pod");
    acquireHistory("c2", "pod");
    answer("pod", use(1));
    expect(historyEpochOf("c1")).toBe(0);
    useClustersStore.setState({ states: { c1: { state: "disconnected" } as never } });
    expect(hasHistory("c1", "pod")).toBe(false);
    expect(hasHistory("c2", "pod")).toBe(true);
    expect(historyEpochOf("c1")).toBe(1);
    expect(historyEpochOf("c2")).toBe(0);
  });
});

describe("what a chart samples", () => {
  const pod = (namespace: string, name: string, cpu: number): PodUsage => ({ namespace, name, usage: use(cpu), containers: [] });
  const pods = new Map(
    [
      pod("shop", "web-7f9c6d5b8-x2b4z", 10),
      pod("shop", "web-7f9c6d5b8-q9w8r", 20),
      // Another Deployment whose name starts the same, and the same name in another namespace: not web's.
      pod("shop", "web-api-6d5b8c7f9-x2b4z", 100),
      pod("other", "web-7f9c6d5b8-zzzzz", 1000),
    ].map((p) => [`${p.namespace}/${p.name}`, p]),
  );
  const nodes = new Map<string, NodeUsage>([["n1", { name: "n1", usage: use(500) }]]);
  const twoNodes = new Map<string, NodeUsage>([...nodes, ["n3", { name: "n3", usage: use(250) }]]);

  it("a pod's own, a workload's pods summed by their controller's names, a node's, the cluster's as every node's", () => {
    expect(targetUsage({ type: "pod", namespace: "shop", name: "web-7f9c6d5b8-x2b4z" }, pods, null)).toEqual(use(10));
    expect(targetUsage({ type: "workload", namespace: "shop", kind: "Deployment", name: "web" }, pods, null)).toEqual(
      use(30, 30 * 1024),
    );
    expect(targetUsage({ type: "node", name: "n1" }, null, nodes)).toEqual(use(500));
    expect(targetUsage({ type: "node", name: "n2" }, null, nodes)).toBeUndefined();
    expect(targetUsage({ type: "cluster" }, pods, twoNodes)).toEqual(use(750));
    expect(targetUsage({ type: "cluster" }, pods, new Map())).toBeUndefined();
    expect(targetUsage({ type: "cluster" }, pods, null)).toBeUndefined();
  });
});
