// "Security" section of the details panel (#143) for Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs
// and CronJobs: the posture against the Pod Security Standards, the namespace's Pod Security labels compared with
// this object, its findings with a fix to copy, and — when Trivy Operator is installed — the image vulnerabilities and
// the configuration audit of the object, linked to the reports. Watched only while the panel shows it: the namespace by
// name, the reports of this object by label in its namespace (a Deployment's through its ReplicaSets).
import { Block } from "../details/ui";
import { useDetailsDisclosure } from "../../layout/details/disclosure";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec } from "../../api";
import { useAppStore } from "../../app/store";
import { Badge } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status } from "../../resources";
import { FindingList, LevelCounts, ModeComparisons, POSTURE_TONE, SeverityCounts, VulnerabilityTable, CheckTable } from "./components";
import { findingsOf, inNamespaces, NAMESPACE, POD, REPLICASET, useServedTrivyKind } from "./hooks";
import { psaLabels } from "./namespaces";
import { admittedFindings, POD_SPEC_KINDS, postureOf } from "./pss";
import {
  CONFIG_AUDIT_REPORT,
  countsOf,
  fixableCount,
  imageOf,
  reportMatches,
  reportSelector,
  scannedAs,
  targetOf,
  topFailedChecks,
  topVulnerabilities,
  VULNERABILITY_REPORT,
} from "./trivy";
import "./security.css";

/** Rows of one report listed in the details (the report's own details list up to `TOP_LIMIT`). */
const DETAILS_TOP = 10;

export function securityApplies(kind: KindRef): boolean {
  return (kind.group === "" || kind.group === "apps" || kind.group === "batch") && POD_SPEC_KINDS.has(kind.kind) && kind.kind !== "ReplicationController";
}

/** `k=v,…` of a workload's `spec.selector.matchLabels`; `null` without any. */
function selectorOf(obj: KubeObject): string | null {
  const labels = status.get(obj, "spec", "selector", "matchLabels");
  if (typeof labels !== "object" || labels === null) return null;
  const pairs = Object.entries(labels as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
  return pairs.length > 0 ? pairs.map(([k, v]) => `${k}=${v}`).join(",") : null;
}

/** Kinds whose live Pods are compared with their template here (a CronJob's Pods belong to Jobs that come and go). */
const POD_OWNERS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"]);

/** The Pods of `obj` among `pods` (by their controller; a Deployment's through its ReplicaSets). */
export function podsOf(kind: string, obj: KubeObject, replicaSets: readonly KubeObject[], pods: Iterable<KubeObject>): KubeObject[] {
  const name = obj.metadata?.name;
  if (!name) return [];
  const isOwn = (o: KubeObject, ownerKind: string, owners: ReadonlySet<string>) => {
    const c = status.controllerOf(o);
    return !!c && c.kind === ownerKind && owners.has(c.name);
  };
  const [podOwner, owners] =
    kind === "Deployment"
      ? ["ReplicaSet", new Set(replicaSets.filter((rs) => isOwn(rs, "Deployment", new Set([name]))).map((rs) => rs.metadata?.name ?? ""))]
      : [kind, new Set([name])];
  return [...pods].filter((p) => !p.metadata?.deletionTimestamp && isOwn(p, podOwner, owners));
}

function SecuritySectionBody({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const kind = objectRef.kind.kind;
  const namespace = objectRef.namespace ?? "";
  const nsSpec: WatchSpec | null = namespace
    ? { kind: NAMESPACE, namespaces: null, labelSelector: null, fieldSelector: `metadata.name=${namespace}` }
    : null;
  const nsWatch = useWatch(clusterId, nsSpec);
  const nsObject = useMemo(() => [...nsWatch.items.values()][0], [nsWatch.items]);
  // Its live Pods (by its selector, in its namespace; a Deployment's through its ReplicaSets): what admission added.
  const withPods = obj && namespace && POD_OWNERS.has(kind) ? selectorOf(obj) : null;
  const rsWatch = useWatch(clusterId, withPods && kind === "Deployment" ? inNamespaces(REPLICASET, [namespace], withPods) : null);
  const podWatch = useWatch(clusterId, withPods ? inNamespaces(POD, [namespace], withPods) : null);
  const replicaSets = useMemo(() => [...rsWatch.items.values()], [rsWatch.items]);
  const findings = useMemo(() => {
    if (!obj) return [];
    const own = findingsOf(kind, obj);
    const pods = podsOf(kind, obj, replicaSets, podWatch.items.values());
    return [...own, ...admittedFindings(own, pods.map((p) => ({ name: p.metadata?.name ?? "", findings: findingsOf("Pod", p) })))];
  }, [kind, obj, replicaSets, podWatch.items]);

  if (!obj) return null;
  const posture = postureOf(findings);
  const violations = findings.filter((f) => f.level !== "hint");
  const hints = findings.filter((f) => f.level === "hint");
  const owner = status.controllerOf(obj);
  return (
    <section className="sec-section" aria-label={t("security:details.title")}>
      <p className="sec-section__posture">
        <Badge tone={POSTURE_TONE[posture]}>{t(`security:posture.${posture}`)}</Badge>
        <span>{t(`security:postureText.${posture}`)}</span>
        <LevelCounts findings={findings} />
      </p>
      {kind === "Pod" && owner && (
        <p className="sec-note">{t("security:details.ownedPod", { kind: owner.kind, name: owner.name })}</p>
      )}
      {namespace && (
        <ModeComparisons
          labels={nsWatch.status === "ready" && nsObject ? psaLabels(nsObject) : undefined}
          judged={[{ kind, obj, findings }]}
        />
      )}
      {violations.length > 0 && <FindingList findings={violations} />}
      {hints.length > 0 && (
        <details className="sec-hints">
          <summary>{t("security:details.hints", { count: hints.length })}</summary>
          <p className="sec-note">{t("security:details.hintsNote")}</p>
          <FindingList findings={hints} />
        </details>
      )}
      {findings.length === 0 && <p className="sec-note">{t("security:details.noFindings")}</p>}
      {namespace && <TrivyOfObject clusterId={clusterId} kind={kind} obj={obj} namespace={namespace} replicaSets={replicaSets} />}
    </section>
  );
}

/** The Trivy reports of one object (shown only when the cluster serves the report kinds). */
function TrivyOfObject({
  clusterId,
  kind,
  obj,
  namespace,
  replicaSets,
}: {
  clusterId: ClusterId;
  kind: string;
  obj: KubeObject;
  namespace: string;
  /** A Deployment's ReplicaSets (its reports are filed under them). */
  replicaSets: KubeObject[];
}) {
  const { t } = useTranslation();
  const vulnKind = useServedTrivyKind(clusterId, VULNERABILITY_REPORT);
  const auditKind = useServedTrivyKind(clusterId, CONFIG_AUDIT_REPORT);
  const served = !!vulnKind || !!auditKind;
  const open = useDetailsDisclosure("security:trivy.section")?.open ?? true;
  const scanned = scannedAs(kind, obj, replicaSets);
  const selector = open && scanned ? reportSelector(scanned) : null;
  const vulns = useWatch(clusterId, selector ? inNamespaces(vulnKind, [namespace], selector) : null);
  const audits = useWatch(clusterId, selector ? inNamespaces(auditKind, [namespace], selector) : null);

  const vulnReports = useMemo(
    () => (scanned ? [...vulns.items.values()].filter((r) => reportMatches(r, namespace, scanned)) : []),
    [vulns.items, scanned, namespace],
  );
  const auditReports = useMemo(
    () => (scanned ? [...audits.items.values()].filter((r) => reportMatches(r, namespace, scanned)) : []),
    [audits.items, scanned, namespace],
  );
  if (!served) return null;
  const loading = !!vulnKind && vulns.status === "loading";
  return (
    <Block id="security:trivy.section" title={t("security:trivy.section")}>
      {vulns.status === "error" || audits.status === "error" ? (
        <p className="sec-note sec-note--warning">{t("security:trivy.watchFailed")}</p>
      ) : vulnReports.length === 0 && auditReports.length === 0 ? (
        !loading && <p className="sec-note">{t("security:trivy.none")}</p>
      ) : null}
      {vulnReports.map((r) => (
        <ImageReport key={r.metadata?.uid ?? r.metadata?.name} report={r} vulnKind={vulnKind!} />
      ))}
      {auditReports.map((r) => (
        <AuditReport key={r.metadata?.uid ?? r.metadata?.name} report={r} auditKind={auditKind!} />
      ))}
    </Block>
  );
}

function OpenReport({ kind, report }: { kind: KindRef; report: KubeObject }) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  const name = report.metadata?.name ?? "";
  return (
    <button
      type="button"
      className="rt-link"
      aria-label={t("resources:table.openObject", { kind: kind.kind, name })}
      onClick={() => openDetails({ kind, namespace: report.metadata?.namespace ?? null, name })}
    >
      {t("security:trivy.openReport")}
    </button>
  );
}

function ImageReport({ report, vulnKind }: { report: KubeObject; vulnKind: KindRef }) {
  const { t } = useTranslation();
  const counts = countsOf(report);
  const top = topVulnerabilities(report, DETAILS_TOP);
  const container = targetOf(report)?.container;
  return (
    <div className="sec-report">
      <div className="sec-report__head">
        <span className="sec-report__name">
          {container ? t("security:finding.container", { name: container }) : (report.metadata?.name ?? "")}
        </span>
        {imageOf(report) && <code className="sec-code">{imageOf(report)}</code>}
        <OpenReport kind={vulnKind} report={report} />
      </div>
      <div className="sec-report__counts">
        <SeverityCounts counts={counts} all />
        <span className="sec-note">{t("security:trivy.fixable", { count: fixableCount(report) })}</span>
      </div>
      {top.rows.length > 0 ? <VulnerabilityTable top={top} /> : <p className="sec-note">{t("security:trivy.noVulnerabilities")}</p>}
    </div>
  );
}

function AuditReport({ report, auditKind }: { report: KubeObject; auditKind: KindRef }) {
  const { t } = useTranslation();
  const top = topFailedChecks(report, DETAILS_TOP);
  return (
    <div className="sec-report">
      <div className="sec-report__head">
        <span className="sec-report__name">{t("security:trivy.configAudit")}</span>
        <OpenReport kind={auditKind} report={report} />
      </div>
      <div className="sec-report__counts">
        <SeverityCounts counts={countsOf(report)} all />
      </div>
      {top.rows.length > 0 ? <CheckTable top={top} /> : <p className="sec-note">{t("security:trivy.noFailed")}</p>}
    </div>
  );
}

export function SecuritySection(props: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!props.obj) return null;
  return <Block id="security:details.title" title={t("security:details.title")}><SecuritySectionBody {...props} /></Block>;
}
