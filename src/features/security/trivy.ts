// Trivy Operator's reports (aquasecurity.github.io): the kinds, their summaries and how a report is tied to a workload.
// The operator labels each report with the object it scanned (`trivy-operator.resource.kind/name/namespace`) and, for
// image reports, the container (`trivy-operator.container.name`); a Deployment's images are scanned through its
// ReplicaSet, a CronJob's through the CronJob. Reports can hold thousands of vulnerabilities: everything here reads the
// operator's own `summary` for counts and keeps only the first `TOP_LIMIT` rows by severity. Pure.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";

const { arr, get, num, str } = status;

export const TRIVY_GROUP = "aquasecurity.github.io";
const k = (kind: string): KindRef => ({ group: TRIVY_GROUP, version: "v1alpha1", kind });

export const VULNERABILITY_REPORT = k("VulnerabilityReport");
export const CLUSTER_VULNERABILITY_REPORT = k("ClusterVulnerabilityReport");
export const CONFIG_AUDIT_REPORT = k("ConfigAuditReport");
export const CLUSTER_CONFIG_AUDIT_REPORT = k("ClusterConfigAuditReport");
export const EXPOSED_SECRET_REPORT = k("ExposedSecretReport");
export const RBAC_ASSESSMENT_REPORT = k("RbacAssessmentReport");
export const CLUSTER_RBAC_ASSESSMENT_REPORT = k("ClusterRbacAssessmentReport");
export const INFRA_ASSESSMENT_REPORT = k("InfraAssessmentReport");
export const CLUSTER_INFRA_ASSESSMENT_REPORT = k("ClusterInfraAssessmentReport");
export const CLUSTER_COMPLIANCE_REPORT = k("ClusterComplianceReport");
export const SBOM_REPORT = k("SbomReport");
export const CLUSTER_SBOM_REPORT = k("ClusterSbomReport");

/** How a report kind is read: image vulnerabilities, checks (config audit, RBAC, infra), secrets, compliance, SBOM. */
export type ReportShape = "vulnerabilities" | "checks" | "secrets" | "compliance" | "sbom";

export interface TrivyKind {
  kind: KindRef;
  namespaced: boolean;
  shape: ReportShape;
  /** Key under `security:trivy.sidebar.` and the sidebar icon. */
  label: string;
  order: number;
}

export const TRIVY_KINDS: TrivyKind[] = [
  { kind: VULNERABILITY_REPORT, namespaced: true, shape: "vulnerabilities", label: "vulnerabilityReports", order: 10 },
  { kind: CLUSTER_VULNERABILITY_REPORT, namespaced: false, shape: "vulnerabilities", label: "clusterVulnerabilityReports", order: 15 },
  { kind: CONFIG_AUDIT_REPORT, namespaced: true, shape: "checks", label: "configAuditReports", order: 20 },
  { kind: CLUSTER_CONFIG_AUDIT_REPORT, namespaced: false, shape: "checks", label: "clusterConfigAuditReports", order: 25 },
  { kind: EXPOSED_SECRET_REPORT, namespaced: true, shape: "secrets", label: "exposedSecretReports", order: 30 },
  { kind: RBAC_ASSESSMENT_REPORT, namespaced: true, shape: "checks", label: "rbacAssessmentReports", order: 40 },
  { kind: CLUSTER_RBAC_ASSESSMENT_REPORT, namespaced: false, shape: "checks", label: "clusterRbacAssessmentReports", order: 45 },
  { kind: INFRA_ASSESSMENT_REPORT, namespaced: true, shape: "checks", label: "infraAssessmentReports", order: 50 },
  { kind: CLUSTER_INFRA_ASSESSMENT_REPORT, namespaced: false, shape: "checks", label: "clusterInfraAssessmentReports", order: 55 },
  { kind: CLUSTER_COMPLIANCE_REPORT, namespaced: false, shape: "compliance", label: "clusterComplianceReports", order: 60 },
  { kind: SBOM_REPORT, namespaced: true, shape: "sbom", label: "sbomReports", order: 70 },
  { kind: CLUSTER_SBOM_REPORT, namespaced: false, shape: "sbom", label: "clusterSbomReports", order: 75 },
];

export function trivyKind(kind: Pick<KindRef, "group" | "kind">): TrivyKind | undefined {
  return kind.group === TRIVY_GROUP ? TRIVY_KINDS.find((t) => t.kind.kind === kind.kind) : undefined;
}

export const LABEL_KIND = "trivy-operator.resource.kind";
export const LABEL_NAME = "trivy-operator.resource.name";
export const LABEL_NAMESPACE = "trivy-operator.resource.namespace";
export const LABEL_CONTAINER = "trivy-operator.container.name";

/** At most this many vulnerabilities or failed checks of one report are listed. */
export const TOP_LIMIT = 50;

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type TrivySeverity = (typeof SEVERITIES)[number];

export function severityRank(severity: string | undefined): number {
  const i = SEVERITIES.indexOf((severity ?? "UNKNOWN").toUpperCase() as TrivySeverity);
  return i < 0 ? SEVERITIES.length - 1 : i;
}

export interface Counts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export const ZERO: Counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    critical: a.critical + b.critical,
    high: a.high + b.high,
    medium: a.medium + b.medium,
    low: a.low + b.low,
    unknown: a.unknown + b.unknown,
  };
}

/** The operator's `report.summary` counts. */
export function countsOf(report: KubeObject): Counts {
  const s = get(report, "report", "summary");
  return {
    critical: num(get(s, "criticalCount")) ?? 0,
    high: num(get(s, "highCount")) ?? 0,
    medium: num(get(s, "mediumCount")) ?? 0,
    low: num(get(s, "lowCount")) ?? 0,
    unknown: num(get(s, "unknownCount")) ?? 0,
  };
}

export function total(c: Counts): number {
  return c.critical + c.high + c.medium + c.low + c.unknown;
}

/** Counts at `min` severity and above (a severity filter). */
export function countAtLeast(c: Counts, min: TrivySeverity): number {
  const values = [c.critical, c.high, c.medium, c.low, c.unknown];
  return values.slice(0, severityRank(min) + 1).reduce((a, b) => a + b, 0);
}

/** The object a report is about, from the operator's labels. */
export interface ReportTarget {
  kind: string;
  name: string;
  namespace: string | null;
  container?: string;
}

export function targetOf(report: KubeObject): ReportTarget | undefined {
  const labels = (report.metadata?.labels ?? {}) as Record<string, string>;
  const kind = labels[LABEL_KIND];
  const name = labels[LABEL_NAME];
  if (!kind || !name) return undefined;
  return {
    kind,
    name,
    namespace: labels[LABEL_NAMESPACE] ?? report.metadata?.namespace ?? null,
    container: labels[LABEL_CONTAINER],
  };
}

/** `registry/repository:tag` of an image report. */
export function imageOf(report: KubeObject): string | undefined {
  const repository = str(get(report, "report", "artifact", "repository"));
  if (!repository) return undefined;
  const server = str(get(report, "report", "registry", "server"));
  const tag = str(get(report, "report", "artifact", "tag"));
  const digest = str(get(report, "report", "artifact", "digest"));
  const base = server ? `${server}/${repository}` : repository;
  return tag ? `${base}:${tag}` : digest ? `${base}@${digest}` : base;
}

export interface Vulnerability {
  id: string;
  severity: string;
  resource: string;
  installed: string;
  fixed?: string;
  title?: string;
  link?: string;
  score?: number;
}

export interface Top<T> {
  rows: T[];
  /** How many there are in all (the rest are not listed). */
  total: number;
}

function topBy<T>(items: readonly unknown[], read: (item: unknown) => T, rank: (row: T) => number, limit: number): Top<T> {
  // Only the first `limit` by severity are read in full.
  const indexed = items.map((item, i) => ({ item, i, r: rank(read(item)) }));
  indexed.sort((a, b) => a.r - b.r || a.i - b.i);
  return { rows: indexed.slice(0, limit).map((x) => read(x.item)), total: items.length };
}

/** The most severe vulnerabilities of a report (fixable ones first within a severity). */
export function topVulnerabilities(report: KubeObject, limit = TOP_LIMIT): Top<Vulnerability> {
  const read = (v: unknown): Vulnerability => ({
    id: str(get(v, "vulnerabilityID")) ?? "",
    severity: (str(get(v, "severity")) ?? "UNKNOWN").toUpperCase(),
    resource: str(get(v, "resource")) ?? "",
    installed: str(get(v, "installedVersion")) ?? "",
    fixed: str(get(v, "fixedVersion")) || undefined,
    title: str(get(v, "title")),
    link: str(get(v, "primaryLink")),
    score: num(get(v, "score")),
  });
  return topBy(arr(get(report, "report", "vulnerabilities")), read, (v) => severityRank(v.severity) * 2 + (v.fixed ? 0 : 1), limit);
}

/** How many vulnerabilities of a report have a fixed version. */
export function fixableCount(report: KubeObject): number {
  return arr(get(report, "report", "vulnerabilities")).filter((v) => !!str(get(v, "fixedVersion"))).length;
}

export interface Check {
  id: string;
  severity: string;
  title?: string;
  description?: string;
  remediation?: string;
  messages: string[];
}

/** The most severe failed checks of a config audit, RBAC or infra report. */
export function topFailedChecks(report: KubeObject, limit = TOP_LIMIT): Top<Check> {
  const failed = arr(get(report, "report", "checks")).filter((c) => get(c, "success") === false);
  const read = (c: unknown): Check => ({
    id: str(get(c, "checkID")) ?? "",
    severity: (str(get(c, "severity")) ?? "UNKNOWN").toUpperCase(),
    title: str(get(c, "title")),
    description: str(get(c, "description")),
    remediation: str(get(c, "remediation")),
    messages: arr(get(c, "messages")).map(String),
  });
  return topBy(failed, read, (c) => severityRank(c.severity), limit);
}

export interface ExposedSecret {
  rule: string;
  severity: string;
  title?: string;
  target?: string;
  category?: string;
}

/** Exposed secrets found in an image, without the matched text (it holds part of the secret). */
export function topSecrets(report: KubeObject, limit = TOP_LIMIT): Top<ExposedSecret> {
  const read = (s: unknown): ExposedSecret => ({
    rule: str(get(s, "ruleID")) ?? "",
    severity: (str(get(s, "severity")) ?? "UNKNOWN").toUpperCase(),
    title: str(get(s, "title")),
    target: str(get(s, "target")),
    category: str(get(s, "category")),
  });
  return topBy(arr(get(report, "report", "secrets")), read, (s) => severityRank(s.severity), limit);
}

export interface ComplianceControl {
  id: string;
  name: string;
  severity: string;
  failed: number;
}

/** A compliance report's pass/fail totals and its failing controls. */
export function compliance(report: KubeObject, limit = TOP_LIMIT): { pass: number; fail: number; failing: Top<ComplianceControl> } {
  const controls = arr(get(report, "status", "summaryReport", "controlCheck")).filter((c) => (num(get(c, "totalFail")) ?? 0) > 0);
  const read = (c: unknown): ComplianceControl => ({
    id: str(get(c, "id")) ?? "",
    name: str(get(c, "name")) ?? "",
    severity: (str(get(c, "severity")) ?? "UNKNOWN").toUpperCase(),
    failed: num(get(c, "totalFail")) ?? 0,
  });
  return {
    pass: num(get(report, "status", "summary", "passCount")) ?? 0,
    fail: num(get(report, "status", "summary", "failCount")) ?? 0,
    failing: topBy(controls, read, (c) => severityRank(c.severity), limit),
  };
}

/** Components in an SBOM report. */
export function componentsCount(report: KubeObject): number | undefined {
  return num(get(report, "report", "summary", "componentsCount"));
}

// ---------- Reports of a workload ----------

/** A CronJob's Job is `<cronjob>-<scheduled minutes>`. */
const CRON_JOB_RUN = /-\d{8,}$/;

/**
 * The objects the operator files the reports of `kind`/`name` under: a Deployment's ReplicaSets (`replicaSets`, those
 * it owns), the workload itself for other kinds; for a pod, its controller (a ReplicaSet, a CronJob for a Job of one).
 */
export function scannedAs(
  kind: string,
  obj: KubeObject,
  replicaSets: readonly KubeObject[] = [],
): { kind: string; names: string[] } | undefined {
  const name = obj.metadata?.name ?? "";
  if (kind === "Deployment") {
    const uid = obj.metadata?.uid;
    const owned = replicaSets.filter((rs) =>
      arr(get(rs, "metadata", "ownerReferences")).some(
        (o) => get(o, "kind") === "Deployment" && (uid ? get(o, "uid") === uid : get(o, "name") === name),
      ),
    );
    // The ReplicaSets with pods (the live revision; two during a rollout), else the newest.
    const live = owned.filter((rs) => (num(get(rs, "spec", "replicas")) ?? 0) > 0);
    const chosen = live.length > 0 ? live : newest(owned);
    return chosen.length > 0 ? { kind: "ReplicaSet", names: chosen.map((rs) => rs.metadata?.name ?? "") } : undefined;
  }
  if (kind === "Pod") {
    const owner = status.controllerOf(obj);
    if (!owner) return { kind: "Pod", names: [name] };
    if (owner.kind === "Job" && CRON_JOB_RUN.test(owner.name)) return { kind: "CronJob", names: [owner.name.replace(CRON_JOB_RUN, "")] };
    return { kind: owner.kind, names: [owner.name] };
  }
  if (kind === "Job") {
    const owner = status.controllerOf(obj);
    if (owner?.kind === "CronJob") return { kind: "CronJob", names: [owner.name] };
  }
  return { kind, names: [name] };
}

function newest(list: readonly KubeObject[]): KubeObject[] {
  let best: KubeObject | undefined;
  for (const rs of list) {
    const t = Date.parse(String(rs.metadata?.creationTimestamp ?? ""));
    if (!best || t > Date.parse(String(best.metadata?.creationTimestamp ?? ""))) best = rs;
  }
  return best ? [best] : [];
}

/** The label selector of the reports filed under `kind`/`names` (a set selector for several names). */
export function reportSelector(scanned: { kind: string; names: string[] }): string | null {
  const names = [...new Set(scanned.names.filter((n) => /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(n) && n.length <= 63))].sort();
  if (names.length === 0) return null;
  const name = names.length === 1 ? `${LABEL_NAME}=${names[0]}` : `${LABEL_NAME} in (${names.join(",")})`;
  return `${LABEL_KIND}=${scanned.kind},${name}`;
}

/** Whether a report is about `kind`/`names` in `namespace`. */
export function reportMatches(report: KubeObject, namespace: string, scanned: { kind: string; names: string[] }): boolean {
  const target = targetOf(report);
  return !!target && target.kind === scanned.kind && scanned.names.includes(target.name) && (target.namespace ?? namespace) === namespace;
}

/** Reports by the object they are about (`namespace|kind|name`). */
export function indexReports(reports: Iterable<KubeObject>): Map<string, KubeObject[]> {
  const index = new Map<string, KubeObject[]>();
  for (const report of reports) {
    const target = targetOf(report);
    if (!target) continue;
    const key = `${target.namespace ?? ""}|${target.kind}|${target.name}`;
    const list = index.get(key) ?? [];
    list.push(report);
    index.set(key, list);
  }
  return index;
}

/** The reports of a judged object from an index (`indexReports`). */
export function reportsFor(
  index: ReadonlyMap<string, KubeObject[]>,
  kind: string,
  obj: KubeObject,
  replicaSets: readonly KubeObject[],
): KubeObject[] {
  const scanned = scannedAs(kind, obj, replicaSets);
  if (!scanned) return [];
  const namespace = obj.metadata?.namespace ?? "";
  return scanned.names.flatMap((name) => index.get(`${namespace}|${scanned.kind}|${name}`) ?? []);
}

/** The summed counts of reports. */
export function sumCounts(reports: readonly KubeObject[]): Counts {
  return reports.reduce((sum, r) => addCounts(sum, countsOf(r)), ZERO);
}
