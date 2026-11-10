// Security posture (#143), read-only and frontend only:
// - the Pod Security Standards (Baseline, Restricted) evaluated locally on pod templates and bare Pods (pss.ts), with
//   hardening hints that are not part of the standard, each finding with its exact field and a fix to copy;
// - the namespace's Pod Security Admission labels (enforce/audit/warn and their versions) compared with what its
//   workloads would need (namespaces.ts);
// - the "Security" page of the Cluster section (bounded by the namespace filter), the "Security" section of workload
//   and Pod details;
// - Trivy Operator's image vulnerability and configuration audit reports (aquasecurity.github.io), when installed:
//   their summary counts per workload on the page (trivy.ts). The report kinds' sidebar section, their details and a
//   workload's "Image scans (Trivy)" block are Sextant's own extension `extensions/trivy` (`sextant.trivy`);
// - Baseline violations feed the problems screen and the notifications as the opt-in category `security`
//   (src/features/problems/model.ts). Trivy reports do not: watching every report of every connected cluster in the
//   background would move whole vulnerability lists for a count.
import "./register";

export { evaluateObject, evaluateTemplate, postureOf, type Finding } from "./pss";
export { SECURITY_PAGE_ID } from "./SecurityPage";
