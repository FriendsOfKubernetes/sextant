// Live report data of the Kyverno views (#213), bounded:
// - an object's results: Kyverno (1.10+) writes one report per resource, named by the resource's uid, in its namespace
//   (a ClusterPolicyReport for a cluster-scoped one), so the object's report is watched by name — one object, through
//   the shared watch registry;
// - a policy's summary: the reports carrying the policy's label (`cpol.kyverno.io/<name>`, `pol.kyverno.io/<name>`),
//   in all namespaces for a ClusterPolicy and in the policy's namespace for a Policy, at most `MAX_SUMMARY_REPORTS`.
// Kinds the cluster does not serve are never watched; nothing is watched before discovery.
import { isCapped, useWatch, type ClusterId, type KindRef, type KubeObject, type ObjectRef, type WatchSpec } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import {
  CLUSTER_POLICY_REPORT,
  POLICY,
  POLICY_REPORT,
  policyReportLabel,
  reportResults,
  reportScope,
  resultPolicyName,
  sameKind,
  type PolicyResult,
} from "./model";

/** Reports read at most for one policy's summary. */
export const MAX_SUMMARY_REPORTS = 1000;

/** The served version of `kind`; `null` when not served; `undefined` while discovery is coming. */
export function useServed(clusterId: ClusterId, kind: KindRef): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

export interface ObjectResults {
  /** The cluster serves the report kind. */
  served: boolean;
  loading: boolean;
  results: PolicyResult[];
}

/** The policy results of one object (its own report, by name). */
export function useObjectResults(clusterId: ClusterId, ref: ObjectRef, uid: string | undefined): ObjectResults {
  const namespaced = ref.namespace !== null && ref.namespace !== "";
  const reportKind = useServed(clusterId, namespaced ? POLICY_REPORT : CLUSTER_POLICY_REPORT);
  const spec: WatchSpec | null =
    reportKind && uid
      ? { kind: reportKind, namespaces: namespaced ? [ref.namespace!] : null, labelSelector: null, fieldSelector: `metadata.name=${uid}` }
      : null;
  const state = useWatch(clusterId, spec);
  const results: PolicyResult[] = [];
  if (reportKind) {
    for (const report of state.items.values()) {
      // Only a report about this very object (its scope names it, or it carries no scope).
      const scope = reportScope(reportKind, report);
      if (scope && (scope.name !== ref.name || scope.kind.kind !== ref.kind.kind)) continue;
      results.push(...reportResults(reportKind, report));
    }
  }
  return { served: !!reportKind, loading: reportKind === undefined || (!!spec && state.status === "loading"), results };
}

export interface FailedObject {
  object: ObjectRef;
  result: PolicyResult;
}

export interface PolicySummary {
  served: boolean;
  loading: boolean;
  /** Results of this policy, all objects. */
  results: PolicyResult[];
  failed: FailedObject[];
  /** More reports carry the label than were read. */
  capped: boolean;
  /** The policy's name cannot be a label: no summary. */
  unlabelled: boolean;
}

function collect(kind: KindRef, reports: Iterable<KubeObject>, policyName: string, into: PolicySummary): void {
  for (const report of reports) {
    const scope = reportScope(kind, report);
    for (const r of reportResults(kind, report)) {
      if (r.policy !== policyName) continue;
      into.results.push(r);
      if (r.result === "fail" && scope) into.failed.push({ object: scope, result: r });
    }
  }
}

/** The results of one policy over the reports that carry its label. */
export function usePolicySummary(clusterId: ClusterId, policyKind: KindRef, policy: KubeObject): PolicySummary {
  const label = policyReportLabel(policy, policyKind);
  const namespaced = sameKind(policyKind, POLICY);
  const reportKind = useServed(clusterId, POLICY_REPORT);
  const clusterReportKind = useServed(clusterId, CLUSTER_POLICY_REPORT);
  const options = { progressive: false, maxObjects: MAX_SUMMARY_REPORTS };
  const spec = (kind: KindRef | null | undefined, namespaces: string[] | null): WatchSpec | null =>
    kind && label ? { kind, namespaces, labelSelector: label, fieldSelector: null } : null;
  const reports = useWatch(clusterId, spec(reportKind, namespaced ? [policy.metadata?.namespace ?? ""] : null), options);
  const clusterReports = useWatch(clusterId, namespaced ? null : spec(clusterReportKind, null), options);
  const summary: PolicySummary = {
    served: !!reportKind || !!clusterReportKind,
    loading:
      reportKind === undefined ||
      (!!reportKind && !!label && reports.status === "loading") ||
      (!namespaced && !!clusterReportKind && !!label && clusterReports.status === "loading"),
    results: [],
    failed: [],
    capped: isCapped(reports) || isCapped(clusterReports),
    unlabelled: !label,
  };
  const name = resultPolicyName(policy, policyKind);
  if (reportKind) collect(reportKind, reports.items.values(), name, summary);
  if (clusterReportKind && !namespaced) collect(clusterReportKind, clusterReports.items.values(), name, summary);
  return summary;
}
