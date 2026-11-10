// Trivy Operator's reports (aquasecurity.github.io) as the Security page reads them: the two kinds it watches, their
// summary counts and how a report is tied to a workload. The operator labels each report with the object it scanned
// (`trivy-operator.resource.kind/name/namespace`) and, for image reports, the container (`trivy-operator.container.name`);
// a Deployment's images are scanned through its ReplicaSet, a CronJob's through the CronJob. Reports can hold thousands
// of vulnerabilities: everything here reads the operator's own `summary` for counts. The report kinds' section and
// details are Sextant's own extension `extensions/trivy` (`sextant.trivy`). Pure.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";

const { arr, get, num } = status;

export const TRIVY_GROUP = "aquasecurity.github.io";
const k = (kind: string): KindRef => ({ group: TRIVY_GROUP, version: "v1alpha1", kind });

export const VULNERABILITY_REPORT = k("VulnerabilityReport");
export const CONFIG_AUDIT_REPORT = k("ConfigAuditReport");

export const LABEL_KIND = "trivy-operator.resource.kind";
export const LABEL_NAME = "trivy-operator.resource.name";
export const LABEL_NAMESPACE = "trivy-operator.resource.namespace";
export const LABEL_CONTAINER = "trivy-operator.container.name";

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
