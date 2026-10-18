// The details of a Trivy Operator report: the object it is about (a link), the operator's summary counts and the
// first `TOP_LIMIT` rows by severity — vulnerabilities with their fixed versions, failed checks with the remediation,
// exposed secrets (rule and file, never the matched text), failing compliance controls — not thousands of rows.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { ObjectLink } from "../../resources";
import { CheckTable, ControlTable, SecretTable, SeverityCounts, VulnerabilityTable } from "./components";
import {
  compliance,
  componentsCount,
  countsOf,
  fixableCount,
  imageOf,
  targetOf,
  topFailedChecks,
  topSecrets,
  topVulnerabilities,
  trivyKind,
  type ReportShape,
} from "./trivy";
import "./security.css";

/** apiVersion of the kinds the operator scans, for the link to the scanned object. */
const API_VERSIONS: Record<string, string> = {
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

export function TrivyReportSection({ objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const def = trivyKind(objectRef.kind);
  if (!obj || !def) return null;
  const target = targetOf(obj);
  const apiVersion = target ? API_VERSIONS[target.kind] : undefined;
  return (
    <section className="sec-section" aria-label={t("security:trivy.reportTitle")}>
      <h3 className="sec-section__title">{t("security:trivy.reportTitle")}</h3>
      {target && (
        <p className="sec-report__head">
          <span className="sec-muted">{t("security:trivy.scanned")}</span>
          {apiVersion ? (
            <ObjectLink target={{ apiVersion, kind: target.kind, name: target.name }} namespace={target.namespace}>
              {`${target.kind}: ${target.name}`}
            </ObjectLink>
          ) : (
            <span>{`${target.kind}: ${target.name}`}</span>
          )}
          {target.container && <span>{t("security:finding.container", { name: target.container })}</span>}
          {imageOf(obj) && <code className="sec-code">{imageOf(obj)}</code>}
        </p>
      )}
      <ReportBody shape={def.shape} report={obj} />
    </section>
  );
}

function ReportBody({ shape, report }: { shape: ReportShape; report: KubeObject }) {
  const { t } = useTranslation();
  switch (shape) {
    case "vulnerabilities": {
      const top = topVulnerabilities(report);
      return (
        <>
          <div className="sec-report__counts">
            <SeverityCounts counts={countsOf(report)} all />
            <span className="sec-note">{t("security:trivy.fixable", { count: fixableCount(report) })}</span>
          </div>
          {top.rows.length > 0 ? <VulnerabilityTable top={top} /> : <p className="sec-note">{t("security:trivy.noVulnerabilities")}</p>}
        </>
      );
    }
    case "checks": {
      const top = topFailedChecks(report);
      return (
        <>
          <div className="sec-report__counts">
            <SeverityCounts counts={countsOf(report)} all />
          </div>
          {top.rows.length > 0 ? <CheckTable top={top} /> : <p className="sec-note">{t("security:trivy.noFailed")}</p>}
        </>
      );
    }
    case "secrets": {
      const top = topSecrets(report);
      return (
        <>
          <div className="sec-report__counts">
            <SeverityCounts counts={countsOf(report)} all />
          </div>
          {top.rows.length > 0 ? <SecretTable top={top} /> : <p className="sec-note">{t("security:trivy.noSecrets")}</p>}
        </>
      );
    }
    case "compliance": {
      const c = compliance(report);
      return (
        <>
          <p className="sec-note">{t("security:trivy.passFail", { pass: c.pass, fail: c.fail })}</p>
          {c.failing.rows.length > 0 && <ControlTable top={c.failing} />}
        </>
      );
    }
    case "sbom": {
      const n = componentsCount(report);
      return n === undefined ? null : <p className="sec-note">{t("security:trivy.components", { count: n })}</p>;
    }
  }
}
