import { describe, expect, it } from "vitest";
import type { ContainerHistory, KubeObject, UsageHistory } from "../../api";
import {
  buildRows,
  groupByNamespace,
  oomKilledContainers,
  podNameMatches,
  rowWaste,
  workloadOf,
  type RightsizingRow,
  type WorkloadRef,
} from "./group";
import { FLAG_SEVERITY } from "./recommend";
import { MI } from "./units";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const NOW_S = NOW / 1000;
const WEEK = 7 * 24 * 3600;

interface PodOpts {
  owner?: { kind: string; name: string };
  hash?: string;
  phase?: string;
  created?: string;
  containers?: { name: string; requests?: Record<string, string>; limits?: Record<string, string> }[];
  statuses?: unknown[];
}

function pod(namespace: string, name: string, opts: PodOpts = {}): KubeObject {
  return {
    metadata: {
      namespace,
      name,
      uid: `${namespace}/${name}`,
      creationTimestamp: opts.created ?? "2026-10-01T00:00:00Z",
      labels: opts.hash ? { "pod-template-hash": opts.hash } : {},
      ownerReferences: opts.owner ? [{ ...opts.owner, controller: true, apiVersion: "apps/v1", uid: "x" }] : [],
    },
    spec: {
      containers: (opts.containers ?? [{ name: "app", requests: { cpu: "500m", memory: "512Mi" }, limits: { memory: "512Mi" } }]).map(
        (c) => ({ name: c.name, resources: { requests: c.requests, limits: c.limits } }),
      ),
    },
    status: { phase: opts.phase ?? "Running", containerStatuses: opts.statuses ?? [] },
  };
}

function hist(namespace: string, podName: string, container: string, patch: Partial<ContainerHistory> = {}): ContainerHistory {
  return {
    namespace,
    pod: podName,
    container,
    cpuP95Millicores: 100,
    memoryMaxBytes: 100 * MI,
    throttledRatio: null,
    firstSeen: NOW_S - WEEK,
    lastSeen: null,
    ...patch,
  };
}

function history(containers: ContainerHistory[]): UsageHistory {
  return { windowSecs: WEEK, evaluatedAt: NOW_S, containers, truncated: false, coverageKnown: true, liveKnown: true };
}

const web = (suffix: string, extra: PodOpts = {}) =>
  pod("shop", `web-7d9f8c6b5-${suffix}`, { owner: { kind: "ReplicaSet", name: "web-7d9f8c6b5" }, hash: "7d9f8c6b5", ...extra });

describe("workloadOf", () => {
  it.each<[string, KubeObject, WorkloadRef]>([
    ["a Deployment's pod", web("abcde"), { kind: "Deployment", namespace: "shop", name: "web" }],
    [
      "a ReplicaSet without a template hash",
      pod("shop", "rs-x", { owner: { kind: "ReplicaSet", name: "rs" } }),
      { kind: "ReplicaSet", namespace: "shop", name: "rs" },
    ],
    ["a StatefulSet's pod", pod("shop", "db-0", { owner: { kind: "StatefulSet", name: "db" } }), { kind: "StatefulSet", namespace: "shop", name: "db" }],
    ["a DaemonSet's pod", pod("kube-system", "agent-x1", { owner: { kind: "DaemonSet", name: "agent" } }), { kind: "DaemonSet", namespace: "kube-system", name: "agent" }],
    ["a bare pod", pod("shop", "debug"), { kind: "Pod", namespace: "shop", name: "debug" }],
  ])("%s", (_, p, expected) => expect(workloadOf(p)).toEqual(expected));
});

describe("podNameMatches", () => {
  const deploy: WorkloadRef = { kind: "Deployment", namespace: "n", name: "web" };
  const sts: WorkloadRef = { kind: "StatefulSet", namespace: "n", name: "db" };
  const ds: WorkloadRef = { kind: "DaemonSet", namespace: "n", name: "agent" };
  it.each<[WorkloadRef, string, boolean]>([
    [deploy, "web-7d9f8c6b5-x2x4z", true],
    [deploy, "web-api-7d9f8c6b5-x2x4z", false],
    [deploy, "web-x2x4z", false],
    [deploy, "webby-7d9f8c6b5-x2x4z", false],
    // A StatefulSet `web-api`, a DaemonSet `web-agent` and a CronJob `web` (job `web-29845012`) are not `web`'s.
    [deploy, "web-api-0", false],
    [deploy, "web-agent-x7k2p", false],
    [deploy, "web-29845012-x7k2p", false],
    [sts, "db-0", true],
    [sts, "db-12", true],
    [sts, "db-x", false],
    [sts, "db-api-0", false],
    [ds, "agent-x7k2p", true],
    [ds, "agent-x7k2p-1", false],
    [ds, "agent-node-x7k2p", false],
  ])("%o / %s → %s", (w, name, expected) => expect(podNameMatches(w, name)).toBe(expected));
});

describe("oomKilledContainers", () => {
  it("counts recent OOMKills in the last or current state only", () => {
    const p = pod("n", "p", {
      statuses: [
        { name: "recent", lastState: { terminated: { reason: "OOMKilled", finishedAt: "2026-10-17T00:00:00Z" } } },
        { name: "old", lastState: { terminated: { reason: "OOMKilled", finishedAt: "2026-09-01T00:00:00Z" } } },
        { name: "now", state: { terminated: { reason: "OOMKilled" } } },
        { name: "error", lastState: { terminated: { reason: "Error", finishedAt: "2026-10-17T00:00:00Z" } } },
      ],
    });
    expect([...oomKilledContainers(p, NOW)].sort()).toEqual(["now", "recent"]);
  });
});

describe("buildRows", () => {
  it("joins the history of live and replaced pods to their workload and counts replicas", () => {
    const pods = [web("x2x4z"), web("q7w9z", { created: "2026-10-10T00:00:00Z" }), pod("shop", "done", { phase: "Succeeded" })];
    const rows = buildRows(
      pods,
      {
        kind: "history",
        history: history([
          hist("shop", "web-7d9f8c6b5-x2x4z", "app", { cpuP95Millicores: 80, firstSeen: NOW_S - 3600 }),
          // A pod of an earlier ReplicaSet, gone since: still the Deployment's history.
          hist("shop", "web-5c4b9b297-zz9zz", "app", { cpuP95Millicores: 150, memoryMaxBytes: 200 * MI, firstSeen: NOW_S - WEEK }),
          hist("shop", "web-api-5c4b9b297-zz9zz", "app", { cpuP95Millicores: 9999 }),
          hist("other", "web-7d9f8c6b5-x2x4z", "app", { cpuP95Millicores: 9999 }),
        ]),
      },
      NOW,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.workload).toEqual({ kind: "Deployment", namespace: "shop", name: "web" });
    expect(row.replicas).toBe(2);
    expect(row.usage).toMatchObject({ kind: "history", cpuP95: 150, memoryMax: 200 * MI, coverageSecs: WEEK });
    expect(row.assessment.confidence).toBe("history");
    // 500m requested, 150 × 1.15 → 180m recommended; 512Mi requested, 200Mi × 1.15 → 240Mi.
    expect(row.assessment.recommendation).toMatchObject({ cpuRequest: 180, memoryRequest: 240 * MI });
    expect(rowWaste(row)).toEqual({ cpu: 2 * 320, memory: 2 * 272 * MI });
  });

  it("counts a pod that is still running only for its owner, however its name looks", () => {
    const sts = pod("shop", "web-api-0", { owner: { kind: "StatefulSet", name: "web-api" } });
    const rows = buildRows(
      [web("x2x4z")],
      {
        kind: "history",
        history: history([
          hist("shop", "web-7d9f8c6b5-x2x4z", "app", { cpuP95Millicores: 50, lastSeen: NOW_S }),
          // Another workload's pod that is running now: not in the list given, so not `web`'s.
          hist("shop", "web-7d9f8c6b5-zz9zz", "app", { cpuP95Millicores: 9999, lastSeen: NOW_S }),
        ]),
      },
      NOW,
    );
    expect(rows[0]!.usage).toMatchObject({ cpuP95: 50 });
    // The StatefulSet's own rows get its own pod's history.
    const [own] = buildRows([sts], { kind: "history", history: history([hist("shop", "web-api-0", "app", { cpuP95Millicores: 7, lastSeen: NOW_S })]) }, NOW);
    expect(own!.usage).toMatchObject({ cpuP95: 7 });
  });

  it("a history of unknown length still recommends, marked as such", () => {
    const h = { ...history([hist("shop", "web-7d9f8c6b5-x2x4z", "app", { firstSeen: null })]), coverageKnown: false };
    const [row] = buildRows([web("x2x4z")], { kind: "history", history: h }, NOW);
    expect(row!.usage).toMatchObject({ coverageSecs: undefined });
    expect(row!.assessment.confidence).toBe("unknownHistory");
    expect(row!.assessment.recommendation).toBeDefined();
  });

  it("includes native sidecars but not plain init containers", () => {
    const p = pod("shop", "app-0", { owner: { kind: "StatefulSet", name: "app" } });
    (p.spec as Record<string, unknown>).initContainers = [
      { name: "proxy", restartPolicy: "Always", resources: { requests: { cpu: "50m" } } },
      { name: "migrate", resources: { requests: { cpu: "1" } } },
    ];
    const rows = buildRows([p], { kind: "none" }, NOW);
    expect(rows.map((r) => r.container)).toEqual(["app", "proxy"]);
    expect(rows[1]!.amounts.cpu.request).toBe(50);
  });

  it("uses the newest pod's spec and marks a snapshot as such", () => {
    const old = web("x2x4z", { containers: [{ name: "app", requests: { cpu: "1" } }] });
    const fresh = web("q7w9z", { created: "2026-10-15T00:00:00Z", containers: [{ name: "app", requests: { cpu: "200m" } }] });
    const pods = new Map([
      ["shop/web-7d9f8c6b5-x2x4z", { namespace: "shop", name: "x", usage: { cpuMillicores: 1, memoryBytes: 1 }, containers: [["app", { cpuMillicores: 30, memoryBytes: 5 * MI }]] as [string, { cpuMillicores: number; memoryBytes: number }][] }],
    ]);
    const [row] = buildRows([old, fresh], { kind: "snapshot", pods }, NOW);
    expect(row!.amounts.cpu.request).toBe(200);
    expect(row!.usage).toEqual({ kind: "snapshot", cpuNow: 30, memoryNow: 5 * MI });
    expect(row!.assessment.confidence).toBe("snapshot");
    expect(row!.assessment.recommendation).toBeUndefined();
  });

  it("without metrics the rows still carry the spec flags", () => {
    const [row] = buildRows([pod("shop", "bare", { containers: [{ name: "c" }] })], { kind: "none" }, NOW);
    expect(row!.assessment.confidence).toBe("noData");
    expect(row!.assessment.flags).toContain("noCpuRequest");
  });
});

describe("groupByNamespace", () => {
  it("totals each namespace and sorts namespaces and rows by waste", () => {
    const rows = buildRows(
      [
        pod("a", "small", { containers: [{ name: "c", requests: { cpu: "200m", memory: "128Mi" } }] }),
        pod("b", "big", { containers: [{ name: "c", requests: { cpu: "2", memory: "128Mi" } }] }),
        pod("b", "mid", { containers: [{ name: "c", requests: { cpu: "1", memory: "2Gi" } }] }),
      ],
      {
        kind: "history",
        history: history([hist("a", "small", "c"), hist("b", "big", "c"), hist("b", "mid", "c")]),
      },
      NOW,
    );
    const isRisk = (r: RightsizingRow) => r.assessment.flags.some((f) => FLAG_SEVERITY[f] === "risk");
    const byCpu = groupByNamespace(rows, "cpuWaste", isRisk);
    expect(byCpu.map((g) => g.namespace)).toEqual(["b", "a"]);
    expect(byCpu[0]!.rows.map((r) => r.workload.name)).toEqual(["big", "mid"]);
    expect(byCpu[0]!.waste.cpu).toBe(2000 - 120 + 1000 - 120);
    expect(byCpu[0]!.requested.cpu).toBe(3000);
    const byMemory = groupByNamespace(rows, "memoryWaste", isRisk);
    expect(byMemory[0]!.rows.map((r) => r.workload.name)).toEqual(["mid", "big"]);
    const byName = groupByNamespace(rows, "name", isRisk);
    expect(byName.map((g) => g.namespace)).toEqual(["a", "b"]);
  });
});
