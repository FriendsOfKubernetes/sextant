// The kinds the "Cleanup" page watches. A namespace in view gets the resource map's lists (`NAMESPACE_KINDS`, shared
// with the map and the "Related" tab through `resource-map/watches.ts`), the kinds that can be cleaned up but are
// only ever referred to (ConfigMaps, Secrets, ServiceAccounts), the manual Endpoints of Services without a selector,
// and the custom kinds known to name Secrets or ConfigMaps (cert-manager, Flux, Gateway API, VolumeSnapshots).
// PersistentVolumes, Namespaces and ClusterIssuers are watched cluster-wide. A kind the cluster does not serve is
// never watched; it simply cannot refer to anything.
import type { KindRef } from "../../api";
import { CERTIFICATE, CLUSTER_ISSUER, ISSUER } from "../cert-manager/model";
import {
  BUCKET,
  GIT_REPOSITORY,
  HELM_CHART,
  HELM_RELEASE,
  HELM_REPOSITORY,
  IMAGE_REPOSITORY,
  KUSTOMIZATION,
  OCI_REPOSITORY,
  PROVIDER,
  RECEIVER,
} from "../flux/model";
import { BACKEND_TLS_POLICY, REFERENCE_GRANT } from "../gateway-api/model";
import {
  CONFIG_MAP,
  CRON_JOB,
  DAEMON_SET,
  DEPLOYMENT,
  JOB,
  NAMESPACE,
  NAMESPACE_KINDS,
  POD,
  PV,
  REPLICA_SET,
  SECRET,
  SERVICE_ACCOUNT,
  STATEFUL_SET,
  STORAGE_CLASS,
} from "../resource-map/kinds";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const ENDPOINTS = k("", "v1", "Endpoints");
export const VOLUME_SNAPSHOT = k("snapshot.storage.k8s.io", "v1", "VolumeSnapshot");

// Custom kinds of other projects known to name Secrets or ConfigMaps (read by `scan.ts` when the cluster serves them).
const KNOWN_REFERRERS: readonly KindRef[] = [
  k("keda.sh", "v1alpha1", "TriggerAuthentication"),
  k("external-secrets.io", "v1", "SecretStore"),
  k("monitoring.coreos.com", "v1", "ServiceMonitor"),
  k("monitoring.coreos.com", "v1", "PodMonitor"),
  k("monitoring.coreos.com", "v1", "Probe"),
  k("monitoring.coreos.com", "v1alpha1", "AlertmanagerConfig"),
  k("velero.io", "v1", "BackupStorageLocation"),
  k("velero.io", "v1", "VolumeSnapshotLocation"),
  k("gateway.networking.k8s.io", "v1", "ListenerSet"),
  k("gateway.networking.x-k8s.io", "v1alpha1", "XListenerSet"),
  k("networking.istio.io", "v1", "Gateway"),
  k("traefik.io", "v1alpha1", "TLSStore"),
  k("traefik.io", "v1alpha1", "TLSOption"),
  k("traefik.io", "v1alpha1", "IngressRoute"),
  k("traefik.io", "v1alpha1", "Middleware"),
  k("traefik.containo.us", "v1alpha1", "TLSStore"),
  k("traefik.containo.us", "v1alpha1", "TLSOption"),
  k("traefik.containo.us", "v1alpha1", "IngressRoute"),
  k("traefik.containo.us", "v1alpha1", "Middleware"),
];

const KNOWN_CLUSTER_REFERRERS: readonly KindRef[] = [
  k("keda.sh", "v1alpha1", "ClusterTriggerAuthentication"),
  k("external-secrets.io", "v1", "ClusterSecretStore"),
];

/**
 * Custom kinds read for the Secrets, ConfigMaps and ServiceAccounts they name (`scan.ts`), per namespace. Flux reads
 * every `secretRef` in the object's own namespace; cert-manager's Certificate names its `secretName`, an Issuer its
 * keys; a BackendTLSPolicy its CA ConfigMaps.
 */
export const SCANNED_KINDS: readonly KindRef[] = [
  CERTIFICATE,
  ISSUER,
  BACKEND_TLS_POLICY,
  GIT_REPOSITORY,
  OCI_REPOSITORY,
  HELM_REPOSITORY,
  HELM_CHART,
  BUCKET,
  KUSTOMIZATION,
  HELM_RELEASE,
  IMAGE_REPOSITORY,
  PROVIDER,
  RECEIVER,
  ...KNOWN_REFERRERS,
];

/** Cluster-scoped kinds read for what they name; a name they give without a namespace counts in every namespace. */
export const SCANNED_CLUSTER_KINDS: readonly KindRef[] = [CLUSTER_ISSUER, ...KNOWN_CLUSTER_REFERRERS];

/** Kinds whose pod template names ConfigMaps, Secrets, claims and service accounts. */
export const TEMPLATE_KINDS: readonly KindRef[] = [POD, DEPLOYMENT, STATEFUL_SET, DAEMON_SET, REPLICA_SET, JOB, CRON_JOB];

/** Everything watched in each namespace in view (ConfigMaps and Secrets only while their rule is on). */
export const CLEANUP_NAMESPACE_KINDS: readonly KindRef[] = [
  ...NAMESPACE_KINDS,
  CONFIG_MAP,
  SECRET,
  SERVICE_ACCOUNT,
  ENDPOINTS,
  REFERENCE_GRANT,
  VOLUME_SNAPSHOT,
  ...SCANNED_KINDS,
];

/** Watched in every namespace at once (cluster-scoped kinds). */
export const CLEANUP_CLUSTER_KINDS: readonly KindRef[] = [PV, NAMESPACE, STORAGE_CLASS, ...SCANNED_CLUSTER_KINDS];

/** API groups of Kubernetes itself: their kinds are not "custom kinds Sextant does not read". */
export const BUILT_IN_GROUPS: ReadonlySet<string> = new Set([
  "",
  "apps",
  "batch",
  "autoscaling",
  "policy",
  "networking.k8s.io",
  "discovery.k8s.io",
  "rbac.authorization.k8s.io",
  "storage.k8s.io",
  "coordination.k8s.io",
  "events.k8s.io",
  "node.k8s.io",
  "scheduling.k8s.io",
  "apiextensions.k8s.io",
  "admissionregistration.k8s.io",
  "certificates.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "resource.k8s.io",
  "authorization.k8s.io",
  "authentication.k8s.io",
  "metrics.k8s.io",
  "internal.apiserver.k8s.io",
  "storagemigration.k8s.io",
  "apiregistration.k8s.io",
]);

/**
 * Custom kinds that hold no reference to a user's ConfigMap, Secret or claim (cert-manager's issuance steps, scan
 * reports): their objects do not stop the page from judging a namespace.
 */
export const HARMLESS_KINDS: readonly Pick<KindRef, "group" | "kind">[] = [
  { group: "cert-manager.io", kind: "CertificateRequest" },
  { group: "acme.cert-manager.io", kind: "Order" },
  { group: "acme.cert-manager.io", kind: "Challenge" },
];
/** Groups of scan reports (Trivy Operator, Policy Reports). */
export const HARMLESS_GROUPS: ReadonlySet<string> = new Set(["aquasecurity.github.io", "wgpolicyk8s.io"]);

/** Built-in cluster-scoped kinds whose objects may name a ConfigMap or Secret (parameters, CA bundles, credentials). */
export const CLUSTER_BUILT_IN_REFERRERS: readonly Pick<KindRef, "group" | "kind">[] = [
  { group: "networking.k8s.io", kind: "IngressClass" },
  { group: "admissionregistration.k8s.io", kind: "ValidatingAdmissionPolicyBinding" },
  { group: "admissionregistration.k8s.io", kind: "ValidatingAdmissionPolicy" },
  { group: "admissionregistration.k8s.io", kind: "MutatingAdmissionPolicyBinding" },
  { group: "admissionregistration.k8s.io", kind: "ValidatingWebhookConfiguration" },
  { group: "admissionregistration.k8s.io", kind: "MutatingWebhookConfiguration" },
  { group: "apiregistration.k8s.io", kind: "APIService" },
  { group: "storage.k8s.io", kind: "CSIDriver" },
  { group: "storage.k8s.io", kind: "StorageClass" },
  { group: "node.k8s.io", kind: "RuntimeClass" },
];

/** Events say nothing about whether a namespace is in use. */
export const NOT_SAMPLED: readonly Pick<KindRef, "group" | "kind">[] = [
  { group: "", kind: "Event" },
  { group: "events.k8s.io", kind: "Event" },
];

/** Watched with metadata only: only whether the object exists matters. */
export const METADATA_ONLY: readonly KindRef[] = [ENDPOINTS];
