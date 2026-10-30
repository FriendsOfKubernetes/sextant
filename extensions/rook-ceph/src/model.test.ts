import { SextantError } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import promtool from "../fixtures/queries.promtool.json";
import manifest from "../sextant-extension.json";
import { CAPACITY_IDS, lastValue, linesOf, OSD_IDS, pgLines, RANGES } from "./charts";
import { KNOWN_CHECKS, wordsOf } from "./checks";
import { componentsOf, isCsiPod, isReady, notReadyReason, type Pod } from "./components";
import { whyNoCharts } from "./metrics";
import {
  capacityOf,
  cephPoolName,
  freshnessOf,
  healthChecks,
  healthOf,
  phaseTone,
  shortVersion,
  STALE_MINUTES,
  versionsOf,
  type CephBlockPool,
  type CephCluster,
  type RookObject,
} from "./rook";
import { claimsOf, driverOf, storageClassesOf, targetOf, type Claim, type StorageClass } from "./storage";

const [warned, external] = fixtures.clusters as unknown as CephCluster[];
const [replicapool, builtinMgr] = fixtures.pools as unknown as CephBlockPool[];
const myfs = fixtures.filesystems[0] as unknown as RookObject;
const myStore = fixtures.objectStores[0] as unknown as RookObject;
const classes = fixtures.storageClasses as unknown as StorageClass[];
const pods = fixtures.pods as unknown as Pod[];
const CHECKED = Date.parse("2026-10-30T09:59:10Z");

describe("a CephCluster's status", () => {
  it("reads Ceph's health and its checks, errors first", () => {
    expect(healthOf(warned!)).toBe("HEALTH_WARN");
    expect(healthOf(external!)).toBe("HEALTH_OK");
    expect(healthOf({ metadata: { name: "new" } })).toBe("unknown");
    expect(healthOf({ metadata: { name: "odd" }, status: { ceph: { health: "HEALTH_MAYBE" } } })).toBe("unknown");
    const withError: CephCluster = {
      metadata: { name: "c" },
      status: { ceph: { details: { PG_DEGRADED: { severity: "HEALTH_WARN", message: "w" }, MON_DOWN: { severity: "HEALTH_ERR", message: "e" } } } },
    };
    expect(healthChecks(withError).map((c) => c.code)).toEqual(["MON_DOWN", "PG_DEGRADED"]);
    expect(healthChecks(warned!).map((c) => c.code)).toEqual(["NEW_CHECK_FROM_A_LATER_CEPH", "OSD_DOWN", "PG_DEGRADED"]);
  });

  it("reads the capacity, or nothing before Rook has it", () => {
    expect(capacityOf(warned!)).toEqual({
      total: 322122547200,
      used: 96636764160,
      available: 225485783040,
      fraction: 0.3,
      lastUpdated: "2026-10-30T09:59:10Z",
    });
    expect(capacityOf({ metadata: { name: "c" }, status: { ceph: { capacity: {} } } })).toBeNull();
  });

  it("reads the versions and says when the daemons run more than one", () => {
    const versions = versionsOf(warned!);
    expect(versions.version).toBe("20.2.0-0");
    expect(versions.running).toEqual([
      { version: "20.2.0 tentacle (stable)", daemons: 3 },
      { version: "19.2.3 squid (stable)", daemons: 1 },
    ]);
    expect(versionsOf(external!).running).toEqual([]);
    expect(shortVersion("19.2.3")).toBe("19.2.3");
  });

  it("is stale only more than STALE_MINUTES after Rook's last check", () => {
    expect(freshnessOf(warned!, CHECKED + STALE_MINUTES * 60_000)).toEqual({ checked: CHECKED, stale: false });
    expect(freshnessOf(warned!, CHECKED + STALE_MINUTES * 60_000 + 1).stale).toBe(true);
    expect(freshnessOf({ metadata: { name: "c" } }, CHECKED)).toEqual({ checked: null, stale: false });
  });

  it("reads Rook's phases", () => {
    expect(["Ready", "Connected", "Progressing", "Failure", undefined].map(phaseTone)).toEqual(["ok", "ok", "warning", "error", "neutral"]);
  });
});

describe("health checks in plain words", () => {
  it("knows Ceph's common checks and nothing that only looks like one", () => {
    expect(wordsOf("OSD_DOWN")?.meaning).toContain("OSDs are down");
    expect(wordsOf("NEW_CHECK_FROM_A_LATER_CEPH")).toBeNull();
    expect(wordsOf("constructor")).toBeNull();
    expect(wordsOf("__proto__")).toBeNull();
    for (const code of Object.keys(KNOWN_CHECKS)) expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

describe("storage on Ceph", () => {
  it("finds the StorageClasses on a pool by the Ceph pool's name and clusterID", () => {
    expect(cephPoolName(builtinMgr!)).toBe(".mgr");
    expect(storageClassesOf(replicapool!, "CephBlockPool", classes).map((sc) => sc.metadata.name)).toEqual(["rook-ceph-block"]);
    expect(storageClassesOf(builtinMgr!, "CephBlockPool", classes)).toEqual([]);
    const elsewhere = { ...replicapool!, metadata: { ...replicapool!.metadata, namespace: "other" } };
    expect(storageClassesOf(elsewhere, "CephBlockPool", classes)).toEqual([]);
    const erasure: StorageClass = { ...classes[0]!, metadata: { name: "ec" }, parameters: { clusterID: "rook-ceph", pool: "meta", dataPool: "replicapool" } };
    expect(storageClassesOf(replicapool!, "CephBlockPool", [erasure]).map((sc) => sc.metadata.name)).toEqual(["ec"]);
    expect(targetOf(erasure)).toBe("pool replicapool (metadata in meta)");
  });

  it("finds a filesystem's and an object store's classes, and the claims on them", () => {
    const fs = storageClassesOf(myfs, "CephFilesystem", classes);
    expect(fs.map((sc) => sc.metadata.name)).toEqual(["rook-cephfs"]);
    expect(storageClassesOf(myfs, "CephBlockPool", classes)).toEqual([]);
    const buckets = storageClassesOf(myStore, "CephObjectStore", classes);
    expect(buckets.map((sc) => sc.metadata.name)).toEqual(["rook-ceph-delete-bucket"]);
    expect(claimsOf(fs, fixtures.pvcs as unknown as Claim[]).map((c) => c.metadata.name)).toEqual(["cephfs-pvc"]);
    expect(claimsOf(buckets, fixtures.objectBucketClaims as unknown as Claim[]).map((c) => c.metadata.name)).toEqual(["ceph-delete-bucket"]);
    expect(classes.map(driverOf)).toEqual(["rbd", "cephfs", "bucket", null]);
  });
});

describe("components", () => {
  it("sorts pods by Rook's labels and groups OSDs by node", () => {
    const components = componentsOf("rook-ceph", pods, [], []);
    expect(components.groups.map((g) => [g.id, g.pods.length, g.ready])).toEqual([
      ["operator", 1, 1],
      ["mon", 1, 1],
      ["mgr", 1, 1],
      ["osd", 2, 1],
      ["mds", 1, 1],
      ["csi", 3, 3],
    ]);
    expect(components.osdsByNode.map((n) => [n.node, n.pods.map((p) => p.metadata.labels?.["ceph-osd-id"])])).toEqual([
      ["kind-worker", ["0"]],
      ["kind-worker2", ["1"]],
    ]);
    expect(components.toolbox.map((p) => p.metadata.name)).toEqual(["rook-ceph-tools-6c7d8e9f0-st45u"]);
    const broken = pods.find((p) => p.metadata.name.startsWith("rook-ceph-osd-1"))!;
    expect(isReady(broken)).toBe(false);
    expect(notReadyReason(broken)).toBe("CrashLoopBackOff");
  });

  it("takes the operator and CSI from the operator's own namespace, once each", () => {
    const operator = { ...pods[0]!, metadata: { ...pods[0]!.metadata, namespace: "rook-operator", uid: "op" } };
    const csi = pods.filter(isCsiPod).map((p) => ({ ...p, metadata: { ...p.metadata, namespace: "rook-operator" } }));
    const daemons = pods.filter((p) => !isCsiPod(p) && p.metadata.labels?.app !== "rook-ceph-operator");
    const components = componentsOf("rook-ceph", daemons, [operator, operator], [...csi, pods[1]!]);
    expect(components.groups.find((g) => g.id === "operator")?.pods).toHaveLength(1);
    expect(components.groups.find((g) => g.id === "csi")?.pods).toHaveLength(3);
    expect(components.groups.find((g) => g.id === "mon")?.pods).toHaveLength(1);
  });

  it("keeps a daemon of another cluster's namespace out", () => {
    const other = pods.map((p) => ({ ...p, metadata: { ...p.metadata, labels: { ...p.metadata.labels, rook_cluster: "elsewhere" } } }));
    expect(componentsOf("rook-ceph", other as Pod[], [], []).groups.map((g) => g.id)).toEqual(["operator", "csi"]);
  });
});

describe("charts", () => {
  const answer = (series: { labels: Record<string, string>; points: [number, number | null][] }[]) => ({
    resultType: "matrix" as const,
    series,
    truncated: false,
  });

  it("names the series by their labels, in order", () => {
    const capacity = answer([
      { labels: { __name__: "ceph_cluster_total_used_raw_bytes" }, points: [[1, 5]] },
      { labels: { __name__: "ceph_cluster_total_bytes" }, points: [[1, 10]] },
      { labels: { __name__: "something_else" }, points: [[1, 1]] },
    ]);
    expect(linesOf(capacity, "__name__", CAPACITY_IDS, ["total", "used"]).map((l) => [l.id, l.name])).toEqual([
      ["total", "Total"],
      ["used", "Used"],
    ]);
    const osds = answer([
      { labels: { state: "up" }, points: [[1, 2], [2, null]] },
      { labels: { state: "total" }, points: [[1, 3]] },
    ]);
    const lines = linesOf(osds, "state", OSD_IDS, ["inCluster", "in", "up"]);
    expect(lines.map((l) => l.id)).toEqual(["inCluster", "up"]);
    expect(lastValue(lines[1]!)).toBe(2);
  });

  it("draws the PG states that are there", () => {
    const pgs = answer([
      { labels: { __name__: "ceph_pg_total" }, points: [[1, 49]] },
      { labels: { __name__: "ceph_pg_clean" }, points: [[1, 33]] },
      { labels: { __name__: "ceph_pg_degraded" }, points: [[1, 16]] },
      { labels: { __name__: "ceph_pg_stale" }, points: [[1, 0]] },
    ]);
    expect(pgLines(pgs).map((l) => l.id)).toEqual(["total", "clean", "degraded"]);
  });

  it("says why there is no chart", () => {
    const empty = answer([]);
    const none = { error: new SextantError("notFound", "no Prometheus-compatible source") };
    expect(whyNoCharts({ health: empty, capacity: empty, osds: empty, pgs: empty }, "rook-ceph")).toContain('namespace="rook-ceph"');
    expect(whyNoCharts({ health: none, capacity: none, osds: none, pgs: none }, "rook-ceph")).toContain("no Prometheus-compatible source");
    const refused = { error: new SextantError("denied", "not agreed to") };
    expect(whyNoCharts({ health: refused, capacity: refused, osds: refused, pgs: refused }, "rook-ceph")).toBe("Sextant refused: not agreed to");
    expect(whyNoCharts({ health: empty, capacity: empty, osds: empty, pgs: answer([{ labels: {}, points: [[1, 1]] }]) }, "x")).toBeNull();
  });
});

describe("the manifest", () => {
  const contributes = manifest.contributes;

  it("judges staleness after STALE_MINUTES, as the views do", () => {
    const stale = contributes.problems.find((p) => p.id === "health-stale")!;
    expect(stale.when).toEqual({ type: "olderThan", path: ".status.ceph.lastChecked", minutes: STALE_MINUTES });
  });

  it("has the queries the Metrics tab runs, each allowing its longest range", () => {
    expect(contributes.metricQueries.map((q) => q.id)).toEqual(["health", "capacity", "osds", "pgs"]);
    const longest = Math.max(...RANGES.map((r) => r.minutes));
    const stepSeconds: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600 };
    for (const query of contributes.metricQueries) {
      expect(query.range!.maxHours * 60).toBeGreaterThanOrEqual(longest);
      expect(query.params).toEqual([{ name: "namespace", type: "namespace" }]);
    }
    for (const range of RANGES) expect((range.minutes * 60) / stepSeconds[range.step]!).toBeLessThanOrEqual(1500);
  });

  it("has the queries fixtures/queries.promtool.json checks with a real Prometheus (see the README)", () => {
    const filled = contributes.metricQueries.map((q) => q.query.replaceAll("{{namespace}}", "rook-ceph"));
    expect(promtool.tests[0]!.promql_expr_test.map((t) => t.expr)).toEqual(filled);
  });

  it("reads only, and every kind it judges or shows is one it may read", () => {
    const rules = manifest.permissions.rules;
    expect(rules.flatMap((r) => r.actions)).toEqual(["read"]);
    const readable = new Set(rules.flatMap((r) => r.kinds.kinds.map((k) => `${k.group}/${k.kind}`)));
    const used = [
      ...contributes.problems.map((p) => p.kind),
      ...contributes.detailsSections.flatMap((s) => s.kinds),
      ...contributes.columns.map((c) => c.kind),
    ];
    for (const kind of used) expect(readable).toContain(`${kind.group}/${kind.kind}`);
  });
});
