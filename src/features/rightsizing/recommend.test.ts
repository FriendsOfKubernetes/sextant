import { describe, expect, it } from "vitest";
import type { ContainerAmounts } from "../metrics/requests";
import { assess, MIN_HISTORY_SECS, recommend, type Flag, type UsageStats } from "./recommend";
import { cpuQuantity, GI, memoryQuantity, MI, roundCpuUp, roundMemoryUp } from "./units";
import { resourcesYaml } from "./yaml";

const WEEK = 7 * 24 * 3600;

function amounts(cpu: { request?: number; limit?: number }, memory: { request?: number; limit?: number }): ContainerAmounts {
  return { cpu, memory };
}

function history(patch: Partial<Extract<UsageStats, { kind: "history" }>> = {}): UsageStats {
  return { kind: "history", cpuP95: 100, memoryMax: 100 * MI, coverageSecs: WEEK, windowSecs: WEEK, ...patch };
}

describe("units", () => {
  it.each([
    [0, 10],
    [1, 10],
    [10, 10],
    [10.0000001, 10],
    [11, 20],
    [114.99, 120],
    [1234, 1240],
    [Number.NaN, 10],
  ])("CPU %s m rounds up to %s m", (input, expected) => {
    expect(roundCpuUp(input)).toBe(expected);
  });

  it.each([
    [0, 16 * MI],
    [1, 16 * MI],
    [16 * MI, 16 * MI],
    [16 * MI + 1024, 32 * MI],
    [115 * MI, 128 * MI],
    [1000 * MI, 1008 * MI],
  ])("memory %s B rounds up to %s B", (input, expected) => {
    expect(roundMemoryUp(input)).toBe(expected);
  });

  it.each([
    [10, "10m"],
    [250, "250m"],
    [1000, "1"],
    [1500, "1500m"],
    [2000, "2"],
  ])("CPU %s m is the quantity %s", (m, q) => expect(cpuQuantity(m)).toBe(q));

  it.each([
    [16 * MI, "16Mi"],
    [1008 * MI, "1008Mi"],
    [GI, "1Gi"],
    [3 * GI, "3Gi"],
    [1000, "1000"],
  ])("memory %s B is the quantity %s", (b, q) => expect(memoryQuantity(b)).toBe(q));
});

describe("recommend", () => {
  it.each([
    {
      name: "p95 and peak plus headroom, rounded",
      amounts: amounts({ request: 500 }, { request: 512 * MI, limit: 512 * MI }),
      usage: { cpuP95: 100, memoryMax: 100 * MI },
      oom: false,
      expected: { cpuRequest: 120, memoryRequest: 128 * MI, memoryLimit: 144 * MI },
    },
    {
      name: "a CPU limit is recommended only when one is set",
      amounts: amounts({ request: 500, limit: 1000 }, { request: 512 * MI }),
      usage: { cpuP95: 100, memoryMax: 100 * MI },
      oom: false,
      expected: { cpuRequest: 120, memoryRequest: 128 * MI, memoryLimit: 144 * MI, cpuLimit: 200 },
    },
    {
      name: "throttling raises the CPU limit",
      amounts: amounts({ limit: 400 }, {}),
      usage: { cpuP95: 100, memoryMax: 100 * MI, throttledRatio: 0.5 },
      oom: false,
      expected: { cpuRequest: 120, memoryRequest: 128 * MI, memoryLimit: 144 * MI, cpuLimit: 600 },
    },
    {
      name: "a recent OOMKill raises the memory limit above the current one",
      amounts: amounts({}, { limit: 128 * MI }),
      usage: { cpuP95: 5, memoryMax: 127 * MI },
      oom: true,
      expected: { cpuRequest: 10, memoryRequest: 160 * MI, memoryLimit: 176 * MI },
    },
    {
      name: "tiny usage still gets the minimum step",
      amounts: amounts({}, {}),
      usage: { cpuP95: 0, memoryMax: 1024 },
      oom: false,
      expected: { cpuRequest: 10, memoryRequest: 16 * MI, memoryLimit: 16 * MI },
    },
  ])("$name", ({ amounts: a, usage, oom, expected }) => {
    expect(recommend(a, usage, oom)).toEqual(expected);
  });

  it("without CPU or memory there is no recommendation", () => {
    expect(recommend(amounts({}, {}), { cpuP95: 10 }, false)).toBeUndefined();
    expect(recommend(amounts({}, {}), { memoryMax: 10 }, false)).toBeUndefined();
  });
});

describe("assess", () => {
  const full = amounts({ request: 100, limit: 200 }, { request: 128 * MI, limit: 256 * MI });

  it.each<{ name: string; amounts: ContainerAmounts; usage?: UsageStats; oom?: boolean; flags: Flag[]; confidence: string }>([
    {
      name: "a container without requests or limits",
      amounts: amounts({}, {}),
      usage: history(),
      flags: ["noCpuRequest", "noMemoryRequest", "noMemoryLimit", "noCpuLimit"],
      confidence: "history",
    },
    {
      name: "a well-sized container has no flags",
      amounts: full,
      usage: history({ cpuP95: 80, memoryMax: 100 * MI }),
      flags: [],
      confidence: "history",
    },
    {
      name: "requests far above use are over-provisioned",
      amounts: amounts({ request: 1000, limit: 2000 }, { request: 2 * GI, limit: 2 * GI }),
      usage: history({ cpuP95: 50, memoryMax: 100 * MI }),
      flags: ["cpuOverProvisioned", "memoryOverProvisioned"],
      confidence: "history",
    },
    {
      name: "twice the recommendation but a small difference is not flagged",
      amounts: amounts({ request: 40, limit: 100 }, { request: 64 * MI, limit: 64 * MI }),
      usage: history({ cpuP95: 10, memoryMax: 10 * MI }),
      flags: [],
      confidence: "history",
    },
    {
      name: "memory near the limit, throttled CPU, recent OOMKill and requests below use",
      amounts: amounts({ request: 50, limit: 100 }, { request: 64 * MI, limit: 128 * MI }),
      usage: history({ cpuP95: 90, memoryMax: 120 * MI, throttledRatio: 0.4 }),
      oom: true,
      flags: ["oomKilled", "memoryNearLimit", "cpuThrottled", "memoryUnderRequested", "cpuUnderRequested"],
      confidence: "history",
    },
    {
      name: "a snapshot gives the current-value flags only",
      amounts: amounts({ request: 1000 }, { request: 2 * GI, limit: 256 * MI }),
      usage: { kind: "snapshot", cpuNow: 5, memoryNow: 250 * MI },
      flags: ["memoryNearLimit", "noCpuLimit"],
      confidence: "snapshot",
    },
    {
      name: "too little history recommends nothing",
      amounts: full,
      usage: history({ coverageSecs: MIN_HISTORY_SECS - 1 }),
      flags: [],
      confidence: "insufficientHistory",
    },
    {
      name: "a day of a week's window is partial history",
      amounts: full,
      usage: history({ coverageSecs: 24 * 3600, cpuP95: 80, memoryMax: 100 * MI }),
      flags: [],
      confidence: "partialHistory",
    },
    {
      name: "no usage at all",
      amounts: full,
      flags: [],
      confidence: "noData",
    },
  ])("$name", ({ amounts: a, usage, oom, flags, confidence }) => {
    const result = assess({ amounts: a, usage, oomKilled: oom ?? false });
    expect(result.flags).toEqual(flags);
    expect(result.confidence).toBe(confidence);
    const recommends = confidence === "history" || confidence === "partialHistory";
    expect(result.recommendation !== undefined).toBe(recommends);
    expect(result.waste !== null).toBe(recommends);
  });

  it("waste is the request above the recommendation, never negative, zero without a request", () => {
    const over = assess({
      amounts: amounts({ request: 1000 }, { request: 2 * GI }),
      usage: history({ cpuP95: 100, memoryMax: 100 * MI }),
      oomKilled: false,
    });
    expect(over.waste).toEqual({ cpu: 880, memory: 2 * GI - 128 * MI });
    const under = assess({ amounts: amounts({ request: 10 }, {}), usage: history(), oomKilled: false });
    expect(under.waste).toEqual({ cpu: 0, memory: 0 });
  });
});

describe("resourcesYaml", () => {
  it("writes requests and limits; a CPU limit only when recommended", () => {
    expect(resourcesYaml({ cpuRequest: 120, memoryRequest: 128 * MI, memoryLimit: GI })).toBe(
      "resources:\n  requests:\n    cpu: 120m\n    memory: 128Mi\n  limits:\n    memory: 1Gi\n",
    );
    expect(resourcesYaml({ cpuRequest: 1000, memoryRequest: 16 * MI, memoryLimit: 32 * MI, cpuLimit: 1500 })).toBe(
      "resources:\n  requests:\n    cpu: 1\n    memory: 16Mi\n  limits:\n    cpu: 1500m\n    memory: 32Mi\n",
    );
  });
});
