import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import auditJson from "./fixtures/configauditreport.json";
import vulnJson from "./fixtures/vulnerabilityreport.json";
import {
  countAtLeast,
  countsOf,
  fixableCount,
  imageOf,
  indexReports,
  reportMatches,
  reportSelector,
  reportsFor,
  scannedAs,
  sumCounts,
  targetOf,
  topFailedChecks,
  topSecrets,
  topVulnerabilities,
} from "./trivy";

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
  it("read the operator's summary, image and target", () => {
    expect(countsOf(vuln)).toEqual({ critical: 1, high: 2, medium: 1, low: 1, unknown: 0 });
    expect(countAtLeast(countsOf(vuln), "HIGH")).toBe(3);
    expect(imageOf(vuln)).toBe("index.docker.io/library/nginx:1.25.3");
    expect(targetOf(vuln)).toEqual({ kind: "ReplicaSet", name: "web-7d9c6b8f5d", namespace: "shop", container: "nginx" });
    expect(fixableCount(vuln)).toBe(4);
    expect(sumCounts([vuln, audit])).toEqual({ critical: 1, high: 3, medium: 2, low: 1, unknown: 0 });
  });

  it("list the most severe vulnerabilities first, fixable ones first within a severity, at most the limit", () => {
    const top = topVulnerabilities(vuln, 3);
    expect(top.total).toBe(5);
    expect(top.rows.map((v) => v.id)).toEqual(["CVE-2024-45491", "CVE-2024-45492", "CVE-2023-52425"]);
    expect(top.rows[0]).toMatchObject({ resource: "libexpat1", installed: "2.5.0-1", fixed: "2.5.0-1+deb12u1" });
    expect(top.rows[2]!.fixed).toBeUndefined();
  });

  it("keep only a few rows of a report with thousands of vulnerabilities", () => {
    const big = structuredClone(vuln);
    const list = (big.report as { vulnerabilities: unknown[] }).vulnerabilities;
    for (let i = 0; i < 5000; i++) list.push({ vulnerabilityID: `CVE-X-${i}`, severity: i % 2 ? "LOW" : "MEDIUM", resource: "x", installedVersion: "1" });
    const top = topVulnerabilities(big);
    expect(top.rows).toHaveLength(50);
    expect(top.total).toBe(5005);
    expect(top.rows[0]!.severity).toBe("CRITICAL");
  });

  it("list failed checks only, most severe first", () => {
    const top = topFailedChecks(audit);
    expect(top.rows.map((c) => c.id)).toEqual(["KSV014", "KSV001"]);
    expect(top.rows[1]!.remediation).toContain("allowPrivilegeEscalation");
  });

  it("never carry the matched text of an exposed secret", () => {
    const report: KubeObject = {
      report: { secrets: [{ ruleID: "aws-access-key-id", severity: "CRITICAL", title: "AWS Access Key ID", target: "/app/.env", match: "AWS_ACCESS_KEY_ID=AKIA****" }] },
    };
    const top = topSecrets(report);
    expect(top.rows).toEqual([{ rule: "aws-access-key-id", severity: "CRITICAL", title: "AWS Access Key ID", target: "/app/.env", category: undefined }]);
    expect(JSON.stringify(top)).not.toContain("AKIA");
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

  it("selects them by label, one name or several", () => {
    expect(reportSelector({ kind: "StatefulSet", names: ["db"] })).toBe("trivy-operator.resource.kind=StatefulSet,trivy-operator.resource.name=db");
    expect(reportSelector({ kind: "ReplicaSet", names: ["b-2", "a-1"] })).toBe(
      "trivy-operator.resource.kind=ReplicaSet,trivy-operator.resource.name in (a-1,b-2)",
    );
    expect(reportSelector({ kind: "Pod", names: ["bad name,x"] })).toBeNull();
    expect(reportMatches(vuln, "shop", { kind: "ReplicaSet", names: ["web-7d9c6b8f5d"] })).toBe(true);
    expect(reportMatches(vuln, "other", { kind: "ReplicaSet", names: ["web-7d9c6b8f5d"] })).toBe(false);
  });

  it("finds them in an index of the namespace's reports", () => {
    const index = indexReports([vuln, audit]);
    const live = rs("web-7d9c6b8f5d", 2, "2026-10-10T00:00:00Z");
    expect(reportsFor(index, "Deployment", deployment, [live])).toEqual([vuln, audit]);
    expect(reportsFor(index, "StatefulSet", { metadata: { name: "web", namespace: "shop" } }, [])).toEqual([]);
  });
});
