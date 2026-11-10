// The model and the manifest's declarative parts. The manifest's computed columns are drawn here by Sextant's own window
// engine (src/extensions/columns.tsx, loaded at run time so the type check stays inside the extension) and compared
// with the columns they replace — the readings of Sextant's former built-in view (ADR-0076), ported unchanged into
// `model.ts` — on its fixtures and variants of them. The model itself is checked as the built-in view's tests did.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import auditJson from "../fixtures/configauditreport.json";
import reportsJson from "../fixtures/reports.json";
import vulnJson from "../fixtures/vulnerabilityreport.json";
import manifest from "../sextant-extension.json";
import {
  BUILT_IN_WIDTHS,
  builtInCell,
  builtInColumns,
  compliance,
  countsOf,
  fixableCount,
  iconOf,
  imageOf,
  reportMatches,
  reportSelector,
  scannedAs,
  targetOf,
  topFailedChecks,
  topSecrets,
  topVulnerabilities,
  TRIVY_GROUP,
  TRIVY_KINDS,
  WORKLOAD_KINDS,
  type ReportShape,
} from "./model";

const vuln = vulnJson as unknown as KubeObject;
const audit = auditJson as unknown as KubeObject;
const reports = reportsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const report = (kind: string) => copy(reports.find((r) => r.kind === kind)!);

// ---------- The model, as the built-in view's tests checked it ----------

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
    expect(imageOf(vuln)).toBe("index.docker.io/library/nginx:1.25.3");
    expect(targetOf(vuln)).toEqual({ kind: "ReplicaSet", name: "web-7d9c6b8f5d", namespace: "shop", container: "nginx" });
    expect(fixableCount(vuln)).toBe(4);
  });

  it("list the most severe vulnerabilities first, fixable ones first within a severity, at most the limit", () => {
    const top = topVulnerabilities(vuln, 3);
    expect(top.total).toBe(5);
    expect(top.rows.map((v) => v.id)).toEqual(["CVE-2024-45491", "CVE-2024-45492", "CVE-2023-52425"]);
    expect(top.rows[0]).toMatchObject({ resource: "libexpat1", installed: "2.5.0-1", fixed: "2.5.0-1+deb12u1" });
    expect(top.rows[2]!.fixed).toBeUndefined();
  });

  it("keep only a few rows of a report with thousands of vulnerabilities", () => {
    const big = copy(vuln);
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
    const top = topSecrets(report("ExposedSecretReport"));
    expect(top.rows).toEqual([{ rule: "aws-access-key-id", severity: "CRITICAL", title: "AWS Access Key ID", target: "/app/.env", category: "AWS" }]);
    expect(JSON.stringify(top)).not.toContain("AKIA");
  });

  it("read a compliance report's totals and failing controls, most severe first", () => {
    const c = compliance(report("ClusterComplianceReport"));
    expect([c.pass, c.fail]).toEqual([101, 15]);
    expect(c.failing.rows.map((r) => r.id)).toEqual(["5.2.2", "1.1.1", "4.2.6"]);
  });
});

describe("the reports of a workload", () => {
  it("a Deployment's are filed under its live ReplicaSets, else its newest", () => {
    const live = rs("web-7d9c6b8f5d", 2, "2026-10-10T00:00:00Z");
    const old = rs("web-5b6c7d8e9f", 0, "2026-10-01T00:00:00Z");
    const other = rs("api-1a2b3c4d5e", 1, "2026-10-01T00:00:00Z", "d-2");
    expect(scannedAs("Deployment", deployment, [live, old, other])).toEqual({ kind: "ReplicaSet", names: ["web-7d9c6b8f5d"] });
    expect(scannedAs("Deployment", deployment, [old, rs("web-0a0b0c0d0e", 0, "2026-09-01T00:00:00Z")])).toEqual({ kind: "ReplicaSet", names: ["web-5b6c7d8e9f"] });
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
    expect(reportSelector({ kind: "ReplicaSet", names: ["b-2", "a-1"] })).toBe("trivy-operator.resource.kind=ReplicaSet,trivy-operator.resource.name in (a-1,b-2)");
    expect(reportSelector({ kind: "Pod", names: ["bad name,x"] })).toBeNull();
    expect(reportMatches(vuln, "shop", { kind: "ReplicaSet", names: ["web-7d9c6b8f5d"] })).toBe(true);
    expect(reportMatches(vuln, "other", { kind: "ReplicaSet", names: ["web-7d9c6b8f5d"] })).toBe(false);
  });
});

// ---------- The manifest's kinds, section and details sections ----------

const c = manifest.contributes;
const kindTitles: Record<string, string> = {
  vulnerabilityReports: "Vulnerability Reports",
  clusterVulnerabilityReports: "Cluster Vulnerability Reports",
  configAuditReports: "Config Audit Reports",
  clusterConfigAuditReports: "Cluster Config Audit Reports",
  exposedSecretReports: "Exposed Secret Reports",
  rbacAssessmentReports: "RBAC Assessment Reports",
  clusterRbacAssessmentReports: "Cluster RBAC Assessment Reports",
  infraAssessmentReports: "Infra Assessment Reports",
  clusterInfraAssessmentReports: "Cluster Infra Assessment Reports",
  clusterComplianceReports: "Cluster Compliance Reports",
  sbomReports: "SBOM Reports",
  clusterSbomReports: "Cluster SBOM Reports",
};

describe("the manifest", () => {
  it("lists the built-in kinds in the section `trivy`, with their titles, icons and order, without the CRDs' printer columns", () => {
    expect(c.kinds).toEqual(
      TRIVY_KINDS.map((k) => ({ group: TRIVY_GROUP, kind: k.kind.kind, section: "trivy", title: kindTitles[k.label], icon: iconOf(k), order: k.order, printerColumns: false })),
    );
    expect(c.sections).toEqual([{ section: "trivy", title: "Trivy", icon: "trivy", after: "certManager" }]);
  });

  it("has no problem rules, actions or counter: Trivy reports are never a problem source (ADR-0076)", () => {
    const contributes = c as Record<string, unknown>;
    for (const key of ["problems", "actions", "sectionBadges", "problemCategories"]) expect(contributes[key], key).toBeUndefined();
  });

  it("reads only: the report kinds and the workloads it shows the scans of", () => {
    expect(manifest.permissions.rules).toEqual([
      {
        namespaces: { type: "all" },
        kinds: { type: "only", kinds: [...TRIVY_KINDS.map((k) => ({ group: TRIVY_GROUP, kind: k.kind.kind })), ...WORKLOAD_KINDS] },
        actions: ["read"],
      },
    ]);
  });

  it("shows the report untitled where the built-in did, and the scans after Sextant's Security section, hidden until served", () => {
    const report = c.detailsSections.find((s) => s.id === "report")!;
    expect(report).toMatchObject({ placement: "section", order: 20, heading: false });
    expect(report.kinds).toEqual(TRIVY_KINDS.map((k) => ({ group: TRIVY_GROUP, kind: k.kind.kind })));
    const scans = c.detailsSections.find((s) => s.id === "scans")!;
    // Security is 57 and practices 58: ids sort `ext:…` first at the same order.
    expect(scans).toMatchObject({ placement: "section", order: 58, heading: false, startHidden: true });
    expect(scans.kinds).toEqual(WORKLOAD_KINDS);
  });
});

// ---------- The columns, against the built-in ones ----------

interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string) => string }): string | null | undefined;
  filter?: { type?: string; value(obj: KubeObject, ctx: { now: number }): unknown };
}
let columns: { computedColumn(id: string, column: unknown): WindowColumn };
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as typeof columns;
  const { startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await startI18n("en");
});

type Column = (typeof c.columns)[number];
const columnOf = (id: string) => c.columns.find((col) => col.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.trivy:${id}`, columnOf(id));
const NOW = Date.parse("2026-11-10T10:00:00Z");

interface Drawn {
  text: string | undefined;
  sort: unknown;
  filter: unknown;
  tone?: string;
  title?: string;
}
type Node = { props?: { title?: string; tone?: string; value?: string; children?: unknown } } | string | number | null;

/** A window cell: its text, sort and filter values, tone and hover. */
function drawn(id: string, obj: KubeObject): Drawn {
  const column = windowColumn(id);
  let node = column.render(obj, { now: NOW }) as Node;
  let title: string | undefined;
  if (node && typeof node === "object" && node.props?.title !== undefined) {
    title = node.props.title;
    node = node.props.children as Node;
  }
  const tone = node && typeof node === "object" ? node.props?.tone : undefined;
  const text = column.searchText(obj, { now: NOW, t: (key) => key }) ?? undefined;
  // The table's filters take an empty text for no value (`isEmptyValue`).
  const filter = column.filter!.value(obj, { now: NOW });
  return { text: text === "" ? undefined : text, sort: column.value(obj), filter: filter === "" ? undefined : filter, ...(tone ? { tone } : {}), ...(title ? { title } : {}) };
}

/** The built-in cell in the same terms. */
function builtIn(name: string, obj: KubeObject): Drawn {
  const cell = builtInCell(name, obj);
  const text = cell.value === undefined ? undefined : String(cell.value);
  return { text: text === "" ? undefined : text, sort: cell.value, filter: cell.value === "" ? undefined : cell.value, ...(cell.tone ? { tone: cell.tone } : {}), ...(cell.title ? { title: cell.title } : {}) };
}

const labels = (o: KubeObject) => (o.metadata.labels ??= {}) as Record<string, string>;
const reportPart = (o: KubeObject) => o.report as Record<string, Record<string, unknown>>;

function variants(shape: ReportShape): [string, KubeObject][] {
  const base: Record<ReportShape, KubeObject> = {
    vulnerabilities: vuln,
    checks: audit,
    secrets: report("ExposedSecretReport"),
    compliance: report("ClusterComplianceReport"),
    sbom: report("SbomReport"),
  };
  const o = () => copy(base[shape]);
  const out: [string, KubeObject][] = [["fixture", o()]];
  const tweak = (label: string, change: (x: KubeObject) => void) => {
    const x = o();
    change(x);
    out.push([label, x]);
  };
  tweak("no labels", (x) => delete x.metadata.labels);
  tweak("no kind label", (x) => delete labels(x)["trivy-operator.resource.kind"]);
  tweak("no name label", (x) => delete labels(x)["trivy-operator.resource.name"]);
  tweak("no container label", (x) => delete labels(x)["trivy-operator.container.name"]);
  tweak("cluster-scoped target", (x) => {
    labels(x)["trivy-operator.resource.kind"] = "Node";
    labels(x)["trivy-operator.resource.name"] = "worker-1";
  });
  if (shape === "compliance") {
    tweak("no title", (x) => delete ((x.spec as Record<string, Record<string, unknown>>).compliance!.title));
    tweak("no compliance", (x) => delete (x.spec as Record<string, unknown>).compliance);
    tweak("nothing failed", (x) => ((x.status as Record<string, Record<string, unknown>>).summary!.failCount = 0));
    tweak("no counts", (x) => delete (x.status as Record<string, unknown>).summary);
    return out;
  }
  tweak("no summary", (x) => delete reportPart(x).summary);
  tweak("zero counts", (x) => (reportPart(x).summary = { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 }));
  tweak("large counts", (x) => (reportPart(x).summary = { criticalCount: 12, highCount: 340, mediumCount: 5600, lowCount: 78000, componentsCount: 0 }));
  tweak("some counts", (x) => (reportPart(x).summary = { highCount: 3, lowCount: 2 }));
  tweak("no server", (x) => delete reportPart(x).registry);
  tweak("empty server", (x) => (reportPart(x).registry = { server: "" }));
  tweak("no tag", (x) => (reportPart(x).artifact = { repository: "library/nginx", digest: "sha256:abc" }));
  tweak("no tag or digest", (x) => {
    reportPart(x).artifact = { repository: "library/nginx" };
  });
  tweak("no tag, digest or server", (x) => {
    reportPart(x).artifact = { repository: "library/nginx" };
    delete reportPart(x).registry;
  });
  tweak("digest without server", (x) => {
    reportPart(x).artifact = { repository: "library/nginx", digest: "sha256:abc" };
    delete reportPart(x).registry;
  });
  tweak("no repository", (x) => (reportPart(x).artifact = { tag: "1.0" }));
  tweak("no artifact", (x) => delete reportPart(x).artifact);
  return out;
}

describe("the columns, against the built-in ones", () => {
  it("are the built-in columns of each kind's shape, after the name or namespace in the built-in order, with their widths", () => {
    for (const kind of TRIVY_KINDS) {
      const own = c.columns.filter((col) => col.kind.kind === kind.kind.kind);
      expect(own.map((col) => col.id), kind.kind.kind).toEqual(builtInColumns(kind.shape).map((name) => `${kind.prefix}-${name}`));
      expect(own.map((col) => col.afterColumn), kind.kind.kind).toEqual([kind.namespaced ? "namespace" : "name", ...own.slice(0, -1).map((col) => col.id)]);
      for (const col of own) {
        const name = col.id.slice(kind.prefix.length + 1);
        expect(windowColumn(col.id).width, col.id).toBe(BUILT_IN_WIDTHS[name]);
        expect(col.kind).toEqual({ group: TRIVY_GROUP, kind: kind.kind.kind });
      }
    }
    expect(c.columns).toHaveLength(62);
  });

  it("show, sort, filter, tone and hover as the built-in ones on the fixtures and their variants", () => {
    for (const kind of TRIVY_KINDS) {
      for (const [label, obj] of variants(kind.shape)) {
        for (const name of builtInColumns(kind.shape)) {
          const id = `${kind.prefix}-${name}`;
          expect(drawn(id, obj), `${id}: ${label}`).toEqual(builtIn(name, obj));
        }
      }
    }
  });

  it("read the other fixtures as the built-in did", () => {
    const shapeOf = (k: string) => TRIVY_KINDS.find((t) => t.kind.kind === k)!;
    for (const obj of reports) {
      const kind = shapeOf(obj.kind!);
      for (const name of builtInColumns(kind.shape)) expect(drawn(`${kind.prefix}-${name}`, obj), `${obj.kind} ${name}`).toEqual(builtIn(name, obj));
    }
    expect(drawn("cvr-image", report("ClusterVulnerabilityReport")).text).toBe("k8s.io/kubelet");
    expect(drawn("esr-image", report("ExposedSecretReport")).text).toBe("ghcr.io/acme/web@sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0");
    expect(drawn("crar-resource", report("ClusterRbacAssessmentReport")).text).toBe("ClusterRole/admin");
    expect(drawn("ccr-fail", report("ClusterComplianceReport"))).toMatchObject({ text: "15", tone: "danger" });
  });

  it("filter the counts as numbers and the texts as text, as the built-in values", () => {
    for (const col of c.columns) {
      const numeric = (col as { format?: string }).format === "number";
      expect(windowColumn(col.id).filter!.type, col.id).toBe(numeric ? "number" : "string");
    }
  });
});
