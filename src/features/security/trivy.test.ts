import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import auditJson from "./fixtures/configauditreport.json";
import vulnJson from "./fixtures/vulnerabilityreport.json";
import { countAtLeast, countsOf, indexReports, reportsFor, scannedAs, sumCounts, targetOf } from "./trivy";

const vuln = vulnJson as KubeObject;
const audit = auditJson as KubeObject;

const deployment: KubeObject = { kind: "Deployment", metadata: { name: "web", namespace: "shop", uid: "d-1" } };
const rs = (name: string, replicas: number, created: string, owner = "d-1"): KubeObject => ({
  kind: "ReplicaSet",
  metadata: {
    name,
    namespace: "shop",
    creationTimestamp: created,
    ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: owner, controller: true }],
  },
  spec: { replicas },
});

describe("reports", () => {
  it("read the operator's summary and target", () => {
    expect(countsOf(vuln)).toEqual({ critical: 1, high: 2, medium: 1, low: 1, unknown: 0 });
    expect(countAtLeast(countsOf(vuln), "HIGH")).toBe(3);
    expect(targetOf(vuln)).toEqual({ kind: "ReplicaSet", name: "web-7d9c6b8f5d", namespace: "shop", container: "nginx" });
    expect(sumCounts([vuln, audit])).toEqual({ critical: 1, high: 3, medium: 2, low: 1, unknown: 0 });
  });
});

describe("the reports of a workload", () => {
  it("a Deployment's are filed under its live ReplicaSets, else its newest", () => {
    const live = rs("web-7d9c6b8f5d", 2, "2026-10-10T00:00:00Z");
    const old = rs("web-5b6c7d8e9f", 0, "2026-10-01T00:00:00Z");
    const other = rs("api-1a2b3c4d5e", 1, "2026-10-01T00:00:00Z", "d-2");
    expect(scannedAs("Deployment", deployment, [live, old, other])).toEqual({ kind: "ReplicaSet", names: ["web-7d9c6b8f5d"] });
    expect(scannedAs("Deployment", deployment, [old, rs("web-0a0b0c0d0e", 0, "2026-09-01T00:00:00Z")])).toEqual({
      kind: "ReplicaSet",
      names: ["web-5b6c7d8e9f"],
    });
    expect(scannedAs("Deployment", deployment, [])).toBeUndefined();
  });

  it("a Pod's under its controller, a CronJob's Job under the CronJob", () => {
    const owned = (kind: string, name: string): KubeObject => ({
      metadata: { name: "x", ownerReferences: [{ apiVersion: "v1", kind, name, uid: "u", controller: true }] },
    });
    expect(scannedAs("Pod", owned("ReplicaSet", "web-7d9c6b8f5d"))).toEqual({ kind: "ReplicaSet", names: ["web-7d9c6b8f5d"] });
    expect(scannedAs("Pod", owned("Job", "backup-29312520"))).toEqual({ kind: "CronJob", names: ["backup"] });
    expect(scannedAs("Pod", { metadata: { name: "solo" } })).toEqual({ kind: "Pod", names: ["solo"] });
    expect(scannedAs("Job", owned("CronJob", "backup"))).toEqual({ kind: "CronJob", names: ["backup"] });
    expect(scannedAs("StatefulSet", { metadata: { name: "db" } })).toEqual({ kind: "StatefulSet", names: ["db"] });
  });

  it("finds them in an index of the namespace's reports", () => {
    const index = indexReports([vuln, audit]);
    const live = rs("web-7d9c6b8f5d", 2, "2026-10-10T00:00:00Z");
    expect(reportsFor(index, "Deployment", deployment, [live])).toEqual([vuln, audit]);
    expect(reportsFor(index, "StatefulSet", { metadata: { name: "web", namespace: "shop" } }, [])).toEqual([]);
  });
});
