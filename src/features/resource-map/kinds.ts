// The kinds the resource map knows how to relate, and the version to name each with when an object refers to it
// without one (a Gateway API backend, an Ingress `resource` backend, a volume's ConfigMap). The cluster's served
// version always wins for watching (`servedKind`); these are the fallbacks.
import type { KindRef } from "../../api";
import { GATEWAY, GATEWAY_CLASS, GRPC_ROUTE, HTTP_ROUTE, TCP_ROUTE, TLS_ROUTE, UDP_ROUTE } from "../gateway-api/model";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const POD = k("", "v1", "Pod");
export const SERVICE = k("", "v1", "Service");
export const CONFIG_MAP = k("", "v1", "ConfigMap");
export const SECRET = k("", "v1", "Secret");
export const SERVICE_ACCOUNT = k("", "v1", "ServiceAccount");
export const PVC = k("", "v1", "PersistentVolumeClaim");
export const PV = k("", "v1", "PersistentVolume");
export const NODE = k("", "v1", "Node");
export const NAMESPACE = k("", "v1", "Namespace");
export const ENDPOINT_SLICE = k("discovery.k8s.io", "v1", "EndpointSlice");
export const INGRESS = k("networking.k8s.io", "v1", "Ingress");
export const INGRESS_CLASS = k("networking.k8s.io", "v1", "IngressClass");
export const NETWORK_POLICY = k("networking.k8s.io", "v1", "NetworkPolicy");
export const STORAGE_CLASS = k("storage.k8s.io", "v1", "StorageClass");
export const DEPLOYMENT = k("apps", "v1", "Deployment");
export const REPLICA_SET = k("apps", "v1", "ReplicaSet");
export const STATEFUL_SET = k("apps", "v1", "StatefulSet");
export const DAEMON_SET = k("apps", "v1", "DaemonSet");
export const JOB = k("batch", "v1", "Job");
export const CRON_JOB = k("batch", "v1", "CronJob");
export const HPA = k("autoscaling", "v2", "HorizontalPodAutoscaler");
export const PDB = k("policy", "v1", "PodDisruptionBudget");

export const ROUTES: readonly KindRef[] = [HTTP_ROUTE, GRPC_ROUTE, TLS_ROUTE, TCP_ROUTE, UDP_ROUTE];

/**
 * What is watched in a namespace in view (the map, the "Related" tab): the kinds whose objects name or select
 * others. ConfigMaps, Secrets and ServiceAccounts are only ever referred to, so they are not listed: a reference
 * draws them. Kinds the cluster does not serve are skipped when watching.
 */
export const NAMESPACE_KINDS: readonly KindRef[] = [
  INGRESS,
  GATEWAY,
  ...ROUTES,
  SERVICE,
  ENDPOINT_SLICE,
  HPA,
  PDB,
  NETWORK_POLICY,
  DEPLOYMENT,
  STATEFUL_SET,
  DAEMON_SET,
  CRON_JOB,
  REPLICA_SET,
  JOB,
  POD,
  PVC,
];

/** Kinds without a namespace that objects refer to. Anything else is taken as namespaced. */
export const CLUSTER_SCOPED: readonly KindRef[] = [NODE, PV, STORAGE_CLASS, INGRESS_CLASS, GATEWAY_CLASS, NAMESPACE];

const KNOWN: readonly KindRef[] = [
  ...NAMESPACE_KINDS,
  CONFIG_MAP,
  SECRET,
  SERVICE_ACCOUNT,
  ...CLUSTER_SCOPED,
];

export const same = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) =>
  a.group === b.group && a.kind === b.kind;

/** The registered kind for `group`/`kind`, if the map knows it. */
export function knownKind(ref: Pick<KindRef, "group" | "kind">): KindRef | undefined {
  return KNOWN.find((kind) => same(kind, ref));
}

export function isClusterScoped(ref: Pick<KindRef, "group" | "kind">): boolean {
  return CLUSTER_SCOPED.some((kind) => same(kind, ref));
}
