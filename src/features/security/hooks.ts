// Live data of the security views. The page watches the workload kinds, Pods and the Trivy reports only in the chosen
// namespaces (at most `MAX_SECURITY_NAMESPACES`) and only while it is open; the details section watches one
// namespace's reports of one object by label. A Trivy kind is watched only when discovery says the cluster serves it.
// Findings are computed once per object version (a watch hands out the same object until it changes).
import { useMemo } from "react";
import { useWatch, type ClusterId, type KindRef, type KubeObject, type WatchSpec, type WatchState } from "../../api";
import { findKind, useClusterKinds } from "../../resources";
import { judgeObjects } from "./admission";
import type { Judged } from "./namespaces";
import { evaluateObject, type Finding } from "./pss";
import { CONFIG_AUDIT_REPORT, VULNERABILITY_REPORT } from "./trivy";

/** At most this many namespaces of the filter are checked. */
export const MAX_SECURITY_NAMESPACES = 20;

const k = (group: string, kind: string): KindRef => ({ group, version: "v1", kind });
export const POD = k("", "Pod");
export const NAMESPACE = k("", "Namespace");
export const DEPLOYMENT = k("apps", "Deployment");
export const STATEFULSET = k("apps", "StatefulSet");
export const DAEMONSET = k("apps", "DaemonSet");
export const REPLICASET = k("apps", "ReplicaSet");
export const JOB = k("batch", "Job");
export const CRONJOB = k("batch", "CronJob");

/** The kinds the page judges, in the order it lists them. */
export const JUDGED_KINDS: KindRef[] = [DEPLOYMENT, STATEFULSET, DAEMONSET, CRONJOB, JOB, REPLICASET, POD];

const cache = new WeakMap<KubeObject, Finding[]>();

/** The findings of an object at the latest version, computed once per object version. */
export function findingsOf(kind: string, obj: KubeObject): Finding[] {
  let found = cache.get(obj);
  if (!found) {
    found = evaluateObject(kind, obj);
    cache.set(obj, found);
  }
  return found;
}

export function inNamespaces(kind: KindRef | null | undefined, namespaces: readonly string[], labelSelector: string | null = null): WatchSpec | null {
  return kind && namespaces.length > 0
    ? { kind, namespaces: [...new Set(namespaces)].sort(), labelSelector, fieldSelector: null }
    : null;
}

/** The version of a Trivy kind the cluster serves; `null` when it does not (or discovery failed), `undefined` before. */
export function useServedTrivyKind(clusterId: ClusterId, kind: KindRef): KindRef | null | undefined {
  const kinds = useClusterKinds(clusterId);
  if (kinds.kinds) return findKind(kinds.kinds, kind)?.kindRef ?? null;
  return kinds.error ? null : undefined;
}

export interface Workloads {
  judged: Judged[];
  /** ReplicaSets of the namespaces (a Deployment's reports are filed under them). */
  replicaSets: KubeObject[];
  loading: boolean;
  failed: { kind: KindRef; watch: WatchState }[];
}

/** The judged objects of `namespaces`. */
export function useWorkloads(clusterId: ClusterId, namespaces: readonly string[]): Workloads {
  // One watch per kind, always called in the same order.
  const watches: WatchState[] = [
    useWatch(clusterId, inNamespaces(JUDGED_KINDS[0], namespaces)),
    useWatch(clusterId, inNamespaces(JUDGED_KINDS[1], namespaces)),
    useWatch(clusterId, inNamespaces(JUDGED_KINDS[2], namespaces)),
    useWatch(clusterId, inNamespaces(JUDGED_KINDS[3], namespaces)),
    useWatch(clusterId, inNamespaces(JUDGED_KINDS[4], namespaces)),
    useWatch(clusterId, inNamespaces(JUDGED_KINDS[5], namespaces)),
    useWatch(clusterId, inNamespaces(JUDGED_KINDS[6], namespaces)),
  ];
  const itemsKey = watches.map((w) => w.items);
  const judged = useMemo(
    () => judgeObjects(JUDGED_KINDS.map((kind, i) => ({ kind: kind.kind, items: itemsKey[i]!.values() })), findingsOf),
    // One dependency per watch: a new list of any kind recomputes (the findings of unchanged objects are cached).
    itemsKey,
  );
  const replicaSetItems = watches[JUDGED_KINDS.indexOf(REPLICASET)]!.items;
  const replicaSets = useMemo(() => [...replicaSetItems.values()], [replicaSetItems]);
  return {
    judged,
    replicaSets,
    loading: watches.some((w) => w.status === "loading"),
    failed: JUDGED_KINDS.map((kind, i) => ({ kind, watch: watches[i]! })).filter((f) => f.watch.status === "error"),
  };
}

export interface TrivyReports {
  /** The cluster serves the image vulnerability reports. */
  served: boolean;
  vulnerabilities: KubeObject[];
  configAudits: KubeObject[];
  loading: boolean;
  failed: boolean;
}

/** VulnerabilityReports and ConfigAuditReports of `namespaces`, when the cluster serves them. */
export function useTrivyReports(clusterId: ClusterId, namespaces: readonly string[]): TrivyReports {
  const vulnKind = useServedTrivyKind(clusterId, VULNERABILITY_REPORT);
  const auditKind = useServedTrivyKind(clusterId, CONFIG_AUDIT_REPORT);
  const vulns = useWatch(clusterId, inNamespaces(vulnKind, namespaces));
  const audits = useWatch(clusterId, inNamespaces(auditKind, namespaces));
  const vulnerabilities = useMemo(() => [...vulns.items.values()], [vulns.items]);
  const configAudits = useMemo(() => [...audits.items.values()], [audits.items]);
  return {
    served: !!vulnKind || !!auditKind,
    vulnerabilities,
    configAudits,
    loading: vulnKind === undefined || (!!vulnKind && vulns.status === "loading") || (!!auditKind && audits.status === "loading"),
    failed: vulns.status === "error" || audits.status === "error",
  };
}
