// Trivy Operator's reports (aquasecurity.github.io): the kinds, their summaries and how a report is tied to a workload.
// The operator labels each report with the object it scanned (`trivy-operator.resource.kind/name/namespace`) and, for
// image reports, the container (`trivy-operator.container.name`); a Deployment's images are scanned through its
// ReplicaSet, a CronJob's through the CronJob. Reports can hold thousands of vulnerabilities: everything here reads the
// operator's own `summary` for counts and keeps only the first `TOP_LIMIT` rows by severity. Pure: the former built-in
// view's model (src/features/security/trivy.ts, ADR-0076), ported unchanged, with the readings of its columns kept as
// the reference the manifest's computed columns are tested against.
import type { KindRef, KubeObject } from "@sextant/extension-sdk";

// ---------- Reading fields ----------

export function get(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export interface OwnerRef {
  apiVersion: string;
  kind: string;
  name: string;
}

/** An object's controller (the owner reference marked `controller`, else the first), as Sextant's `controllerOf`. */
export function controllerOf(obj: KubeObject): OwnerRef | undefined {
  const owners = arr(obj.metadata?.ownerReferences);
  const owner = owners.find((o) => get(o, "controller") === true) ?? owners[0];
  if (!owner) return undefined;
  const kind = str(get(owner, "kind"));
  const name = str(get(owner, "name"));
  const apiVersion = str(get(owner, "apiVersion"));
  return kind && name && apiVersion ? { apiVersion, kind, name } : undefined;
}

// ---------- The kinds ----------

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
  /** The built-in label key (`security:trivy.sidebar.<label>`): the manifest's kind title. */
  label: string;
  order: number;
  /** The prefix of its columns' ids in the manifest. */
  prefix: string;
}

export const TRIVY_KINDS: TrivyKind[] = [
  { kind: VULNERABILITY_REPORT, namespaced: true, shape: "vulnerabilities", label: "vulnerabilityReports", order: 10, prefix: "vr" },
  { kind: CLUSTER_VULNERABILITY_REPORT, namespaced: false, shape: "vulnerabilities", label: "clusterVulnerabilityReports", order: 15, prefix: "cvr" },
  { kind: CONFIG_AUDIT_REPORT, namespaced: true, shape: "checks", label: "configAuditReports", order: 20, prefix: "car" },
  { kind: CLUSTER_CONFIG_AUDIT_REPORT, namespaced: false, shape: "checks", label: "clusterConfigAuditReports", order: 25, prefix: "ccar" },
  { kind: EXPOSED_SECRET_REPORT, namespaced: true, shape: "secrets", label: "exposedSecretReports", order: 30, prefix: "esr" },
  { kind: RBAC_ASSESSMENT_REPORT, namespaced: true, shape: "checks", label: "rbacAssessmentReports", order: 40, prefix: "rar" },
  { kind: CLUSTER_RBAC_ASSESSMENT_REPORT, namespaced: false, shape: "checks", label: "clusterRbacAssessmentReports", order: 45, prefix: "crar" },
  { kind: INFRA_ASSESSMENT_REPORT, namespaced: true, shape: "checks", label: "infraAssessmentReports", order: 50, prefix: "iar" },
  { kind: CLUSTER_INFRA_ASSESSMENT_REPORT, namespaced: false, shape: "checks", label: "clusterInfraAssessmentReports", order: 55, prefix: "ciar" },
  { kind: CLUSTER_COMPLIANCE_REPORT, namespaced: false, shape: "compliance", label: "clusterComplianceReports", order: 60, prefix: "ccr" },
  { kind: SBOM_REPORT, namespaced: true, shape: "sbom", label: "sbomReports", order: 70, prefix: "sbom" },
  { kind: CLUSTER_SBOM_REPORT, namespaced: false, shape: "sbom", label: "clusterSbomReports", order: 75, prefix: "csbom" },
];

export function trivyKind(kind: Pick<KindRef, "group" | "kind">): TrivyKind | undefined {
  return kind.group === TRIVY_GROUP ? TRIVY_KINDS.find((t) => t.kind.kind === kind.kind) : undefined;
}

/** The sidebar icon of a kind, as the built-in registration chose it. */
export function iconOf({ label, shape }: TrivyKind): string {
  if (label.toLowerCase().includes("rbac")) return "trivyRbac";
  if (label.toLowerCase().includes("infra")) return "trivyInfra";
  const icons: Record<ReportShape, string> = {
    vulnerabilities: "trivyVulnerabilities",
    checks: "trivyConfigAudit",
    secrets: "trivySecrets",
    compliance: "trivyCompliance",
    sbom: "trivySbom",
  };
  return icons[shape];
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

// ---------- The scanned object's link ----------

/** apiVersion of the kinds the operator scans, for the link to the scanned object. */
export const API_VERSIONS: Record<string, string> = {
  Pod: "v1",
  ReplicationController: "v1",
  Node: "v1",
  ConfigMap: "v1",
  Service: "v1",
  Namespace: "v1",
  ReplicaSet: "apps/v1",
  Deployment: "apps/v1",
  StatefulSet: "apps/v1",
  DaemonSet: "apps/v1",
  Job: "batch/v1",
  CronJob: "batch/v1",
  Role: "rbac.authorization.k8s.io/v1",
  ClusterRole: "rbac.authorization.k8s.io/v1",
  RoleBinding: "rbac.authorization.k8s.io/v1",
  ClusterRoleBinding: "rbac.authorization.k8s.io/v1",
  Ingress: "networking.k8s.io/v1",
  NetworkPolicy: "networking.k8s.io/v1",
};

/** A kind of `apiVersion` (`apps/v1`, `v1`). */
export function kindOfApiVersion(apiVersion: string, kind: string): KindRef {
  const slash = apiVersion.indexOf("/");
  return slash < 0 ? { group: "", version: apiVersion, kind } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1), kind };
}

// ---------- Reports of a workload ----------

/** The kinds whose details show their image scans: those of the built-in "Security" section (pod templates and Pods). */
export const WORKLOAD_KINDS: readonly { group: string; kind: string }[] = [
  { group: "apps", kind: "Deployment" },
  { group: "apps", kind: "StatefulSet" },
  { group: "apps", kind: "DaemonSet" },
  { group: "apps", kind: "ReplicaSet" },
  { group: "batch", kind: "Job" },
  { group: "batch", kind: "CronJob" },
  { group: "", kind: "Pod" },
];

/** A Deployment's ReplicaSets: the operator files its image reports under them. */
export const REPLICA_SET: KindRef = { group: "apps", version: "v1", kind: "ReplicaSet" };

/** Rows of one report listed in a workload's details (the report's own details list up to `TOP_LIMIT`). */
export const DETAILS_TOP = 10;

/** A CronJob's Job is `<cronjob>-<scheduled minutes>`. */
const CRON_JOB_RUN = /-\d{8,}$/;

/**
 * The objects the operator files the reports of `kind`/`name` under: a Deployment's ReplicaSets (`replicaSets`, those
 * it owns), the workload itself for other kinds; for a pod, its controller (a ReplicaSet, a CronJob for a Job of one).
 */
export function scannedAs(kind: string, obj: KubeObject, replicaSets: readonly KubeObject[] = []): { kind: string; names: string[] } | undefined {
  const name = obj.metadata?.name ?? "";
  if (kind === "Deployment") {
    const uid = obj.metadata?.uid;
    const owned = replicaSets.filter((rs) =>
      arr(get(rs, "metadata", "ownerReferences")).some((o) => get(o, "kind") === "Deployment" && (uid ? get(o, "uid") === uid : get(o, "name") === name)),
    );
    // The ReplicaSets with pods (the live revision; two during a rollout), else the newest.
    const live = owned.filter((rs) => (num(get(rs, "spec", "replicas")) ?? 0) > 0);
    const chosen = live.length > 0 ? live : newest(owned);
    return chosen.length > 0 ? { kind: "ReplicaSet", names: chosen.map((rs) => rs.metadata?.name ?? "") } : undefined;
  }
  if (kind === "Pod") {
    const owner = controllerOf(obj);
    if (!owner) return { kind: "Pod", names: [name] };
    if (owner.kind === "Job" && CRON_JOB_RUN.test(owner.name)) return { kind: "CronJob", names: [owner.name.replace(CRON_JOB_RUN, "")] };
    return { kind: owner.kind, names: [owner.name] };
  }
  if (kind === "Job") {
    const owner = controllerOf(obj);
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

/** `k=v,…` of a workload's `spec.selector.matchLabels`; `null` without any (its ReplicaSets are then not looked for). */
export function selectorOf(obj: KubeObject): string | null {
  const labels = get(obj, "spec", "selector", "matchLabels");
  if (typeof labels !== "object" || labels === null) return null;
  const pairs = Object.entries(labels as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
  return pairs.length > 0 ? pairs.map(([key, v]) => `${key}=${v}`).join(",") : null;
}

// ---------- The built-in columns, as the reference of the manifest's ----------

/** What a built-in column showed for a report: its sort and filter value, its text, its hover and its tone. */
export interface BuiltInCell {
  value: string | number | undefined;
  tone?: "danger" | "warning" | "muted" | "success";
  title?: string;
}

const countCell = (n: number, tone: "danger" | "warning" | "muted"): BuiltInCell => ({ value: n, tone: n > 0 ? tone : "muted" });

/** The built-in columns of a shape, by the manifest's column id suffix, in their order. */
export function builtInColumns(shape: ReportShape): string[] {
  const severity = ["critical", "high", "medium", "low"];
  switch (shape) {
    case "vulnerabilities":
    case "secrets":
      return ["resource", "container", "image", ...severity];
    case "checks":
      return ["resource", ...severity];
    case "compliance":
      return ["title", "pass", "fail"];
    case "sbom":
      return ["resource", "container", "image", "components"];
  }
}

/** The cell of the built-in column `column` (the manifest's id suffix) for `o`. */
export function builtInCell(column: string, o: KubeObject): BuiltInCell {
  const target = targetOf(o);
  switch (column) {
    case "resource":
      return { value: target ? `${target.kind}/${target.name}` : undefined };
    case "container":
      return { value: target?.container };
    case "image": {
      const image = imageOf(o);
      return { value: image, title: image };
    }
    case "critical":
      return countCell(countsOf(o).critical, "danger");
    case "high":
      return countCell(countsOf(o).high, "danger");
    case "medium":
      return countCell(countsOf(o).medium, "warning");
    case "low":
      return countCell(countsOf(o).low, "muted");
    case "title":
      return { value: str(get(o, "spec", "compliance", "title")) ?? str(get(o, "spec", "compliance", "id")) };
    case "pass":
      return { value: num(get(o, "status", "summary", "passCount")) };
    case "fail": {
      const n = num(get(o, "status", "summary", "failCount"));
      return n === undefined ? { value: undefined } : { value: n, tone: n > 0 ? "danger" : "success" };
    }
    case "components":
      return { value: componentsCount(o) };
  }
  throw new Error(`no built-in column ${column}`);
}

/** The widths of the built-in columns. */
export const BUILT_IN_WIDTHS: Record<string, string> = {
  resource: "minmax(160px, 2fr)",
  container: "minmax(100px, 1fr)",
  image: "minmax(160px, 2fr)",
  critical: "80px",
  high: "80px",
  medium: "80px",
  low: "80px",
  title: "minmax(180px, 3fr)",
  pass: "80px",
  fail: "80px",
  components: "110px",
};
