// Which kinds are watched for each category of problems. Built-in kinds are watched without discovery; the kinds of
// installed tools (cert-manager, Flux, Argo CD, Gateway API) only once discovery says the cluster serves them, at the
// version it serves.
import type { KindRef, KubeObject, ResourceKind } from "../../api";
import { findKind } from "../../resources";
import { APPLICATION } from "../argocd/model";
import { ROLLOUT } from "../argo-rollouts/model";
import { WORKFLOW } from "../argo-workflows/model";
import { BUCKET, GIT_REPOSITORY, HELM_RELEASE, HELM_REPOSITORY, KUSTOMIZATION, OCI_REPOSITORY } from "../flux/model";
import { COUNTED_KINDS } from "../gateway-api/problems";
import { CONFIGURATION as KNATIVE_CONFIGURATION, KSERVICE } from "../knative/model";
import { CONTOUR_ACROSS } from "../contour/across";
import { HTTP_PROXY } from "../contour/model";
import { INGRESS_ROUTE as TRAEFIK_INGRESS_ROUTE } from "../traefik/model";
import { EVENTING_KINDS } from "../knative/eventing";
import { CLUSTER_POLICY_REPORT, POLICY_REPORT } from "../kyverno/model";
import { XRD } from "../crossplane/model";
import { BACKUP as CNPG_BACKUP, PG_CLUSTER } from "../cnpg/model";
import { CAPI_PAUSED_ACROSS } from "../cluster-api/across";
import {
  CAPI_CLUSTER,
  isKind as isCapiKind,
  KUBEADM_CONTROL_PLANE as CAPI_KCP,
  MACHINE as CAPI_MACHINE,
  PROBLEM_KINDS as CAPI_PROBLEM_KINDS,
} from "../cluster-api/model";
import { CLUSTER_EXTERNAL_SECRET, CLUSTER_SECRET_STORE, EXTERNAL_SECRET, PUSH_SECRET, SECRET_STORE } from "../external-secrets/model";
import { ALERTMANAGER, PROMETHEUS, SERVICE_MONITOR } from "../prometheus-operator/model";
import { SEALED_SECRET } from "../sealed-secrets/model";
import { VPA } from "../vpa/model";
import { RESOURCE_CLAIM as DRA_CLAIM } from "../dra/model";
import { CLUSTER_POLICY as GPU_CLUSTER_POLICY } from "../gpu-operator/model";
import { CLUSTER_QUEUE as KUEUE_CLUSTER_QUEUE, LOCAL_QUEUE as KUEUE_LOCAL_QUEUE, WORKLOAD as KUEUE_WORKLOAD } from "../kueue/model";
import { JOBSET } from "../jobset/model";
import { RAY_CLUSTER, RAY_JOB, RAY_SERVICE } from "../kuberay/model";
import { INFERENCE_SERVICE as KSERVE_INFERENCE_SERVICE } from "../kserve/model";
import { SECRET as REFLECTOR_SECRET } from "../reflector/model";
import { STRIMZI_KINDS } from "../strimzi/model";
import {
  CERTIFICATE,
  CRONJOB,
  DAEMONSET,
  REPLICASET,
  DEPLOYMENT,
  EVENT,
  JOB,
  NODE,
  POD,
  PVC,
  STATEFULSET,
  categoryOf,
  type Problem,
  type ProblemCategory,
} from "./model";

/** One watched kind of a category. */
export interface SourceDef {
  category: ProblemCategory;
  kind: KindRef;
  fieldSelector: string | null;
  /** The kind of an installed tool: watched only once discovery says the cluster serves it. */
  discovered: boolean;
  /**
   * Nothing is watched: the category's provider (`registerProblemProvider` in store.ts) hands in the problems — the
   * fill levels of volume claims ("disk almost full", #152), polled by features/storage while the source is held.
   */
  external?: boolean;
  /**
   * The watch keeps at most this many objects (`WatchOptions.maxObjects`), for kinds a cluster can hold by the
   * thousand (Kafka topics and users, policy reports); beyond it the source says it is truncated.
   */
  maxObjects?: number;
  /**
   * Problems judged across the objects of the source: the store keeps a row tap of the watch while the source is held
   * and passes every problem list through `keep` with the rows (an HTTPProxy orphaned because the root that includes
   * it is invalid is told through that root, #233). `keep` runs only while the rows are read in full.
   */
  across?: AcrossDef;
}

/** A source's problems judged across its objects (`SourceDef.across`). */
export interface AcrossDef {
  tap: { id: string; toRow(obj: KubeObject): unknown; max: number };
  keep(problems: readonly Problem[], rows: ReadonlyMap<string, unknown>): Problem[];
  /**
   * The rows are of this other source of the same cluster (held with a tap while this source lives), not of this
   * source's own objects: a Machine's problems are kept only while its Cluster is not paused (#243).
   */
  from?: SourceDef;
}

/** The cap of a source whose kind a cluster can hold by the thousand. */
export const MAX_SOURCE_OBJECTS = 5000;

const builtIn = (category: ProblemCategory, kind: KindRef, fieldSelector: string | null = null): SourceDef => ({
  category,
  kind,
  fieldSelector,
  discovered: false,
});
const tool = (category: ProblemCategory, kind: KindRef, maxObjects?: number): SourceDef => ({
  category,
  kind,
  fieldSelector: null,
  discovered: true,
  ...(maxObjects !== undefined ? { maxObjects } : {}),
});

/** Flux kinds with a Ready condition worth watching: the sources and what applies them. */
const FLUX_WATCHED = [GIT_REPOSITORY, OCI_REPOSITORY, HELM_REPOSITORY, BUCKET, KUSTOMIZATION, HELM_RELEASE];

export const CATEGORY_SOURCES: Record<ProblemCategory, SourceDef[]> = {
  nodes: [builtIn("nodes", NODE)],
  pods: [builtIn("pods", POD)],
  workloads: [builtIn("workloads", DEPLOYMENT), builtIn("workloads", STATEFULSET), builtIn("workloads", DAEMONSET)],
  jobs: [builtIn("jobs", JOB)],
  // Kueue (#246): ClusterQueues that admit nothing and LocalQueues of a missing ClusterQueue; LocalQueues are one per
  // team namespace: capped.
  kueue: [tool("kueue", KUEUE_CLUSTER_QUEUE), tool("kueue", KUEUE_LOCAL_QUEUE, MAX_SOURCE_OBJECTS)],
  // Kueue Workloads (#246, opt-in): waiting for quota, not queueable, evicted repeatedly; each one holds its jobs' pod
  // templates and a batch cluster queues thousands: capped. The same watch feeds the queues' pending lists (a row tap).
  kueueWorkloads: [tool("kueueWorkloads", KUEUE_WORKLOAD, MAX_SOURCE_OBJECTS)],
  // JobSet (#247): failed JobSets (for a day) and restarts near the limit; capped like the other kinds by the thousand.
  jobset: [tool("jobset", JOBSET, MAX_SOURCE_OBJECTS)],
  // Vertical Pod Autoscaler (#242): configurations the recommender cannot use, VPAs that match no pod, and VPAs that
  // fight an HPA over the same resource, judged by the provider of features/vpa (`external`: the HPA is another
  // object), held only where VPAs are served.
  vpa: [{ category: "vpa", kind: VPA, fieldSelector: null, discovered: true, external: true }],
  volumes: [builtIn("volumes", PVC)],
  certificates: [tool("certificates", CERTIFICATE)],
  flux: FLUX_WATCHED.map((kind) => tool("flux", kind)),
  argocd: [tool("argocd", APPLICATION)],
  // Argo Rollouts (#213): Degraded or aborted Rollouts and the failed analyses they report.
  rollouts: [tool("rollouts", ROLLOUT)],
  // Recent failed Workflows (#213): the provider of features/argo-workflows watches only failed ones, metadata only,
  // by their phase label (`external`), held only where Workflows are served.
  workflows: [{ category: "workflows", kind: WORKFLOW, fieldSelector: null, discovered: true, external: true }],
  gateway: COUNTED_KINDS.map((kind) => tool("gateway", kind)),
  // Istio routing and mTLS mistakes (#155): judged across objects by the provider of features/mesh (`external`), held
  // only where the cluster serves VirtualServices.
  mesh: [{ category: "mesh", kind: { group: "networking.istio.io", version: "v1", kind: "VirtualService" }, fieldSelector: null, discovered: true, external: true }],
  // Knative Services and Configurations of their own (#213): a failed latest revision shows through them.
  // Knative Eventing (#234): every kind of its section the cluster serves; Triggers and Subscriptions can be thousands:
  // capped.
  knative: [
    tool("knative", KSERVICE),
    tool("knative", KNATIVE_CONFIGURATION),
    ...EVENTING_KINDS.map((d) => tool("knative", d.kind, MAX_SOURCE_OBJECTS)),
  ],
  // Traefik (#232, opt-in): references to objects that do not exist, judged across objects by the provider of
  // features/traefik (`external`), held only where the cluster serves IngressRoutes (traefik.io); no Secret is listed.
  traefik: [{ category: "traefik", kind: TRAEFIK_INGRESS_ROUTE, fieldSelector: null, discovered: true, external: true }],
  // Contour (#233): invalid and orphaned HTTPProxies; the same watch feeds the delegation tree (a row tap), and those
  // rows tell an orphan under an invalid root through the root (`across`).
  contour: [{ ...tool("contour", HTTP_PROXY, MAX_SOURCE_OBJECTS), across: CONTOUR_ACROSS }],
  // Crossplane claims and composites (#213) are kinds the XRDs define: the provider of features/crossplane watches the
  // XRDs and the kinds they name (bounded there) and judges them (`external`), held only where XRDs are served.
  crossplane: [{ category: "crossplane", kind: XRD, fieldSelector: null, discovered: true, external: true }],
  // Kyverno policy failures (#213, opt-in): the reports Kyverno writes, one per resource.
  // One report per resource: capped.
  policies: [tool("policies", POLICY_REPORT, MAX_SOURCE_OBJECTS), tool("policies", CLUSTER_POLICY_REPORT, MAX_SOURCE_OBJECTS)],
  // External Secrets (#213): failed syncs and stores that do not validate.
  externalSecrets: [EXTERNAL_SECRET, CLUSTER_EXTERNAL_SECRET, SECRET_STORE, CLUSTER_SECRET_STORE, PUSH_SECRET].map((kind) =>
    tool("externalSecrets", kind),
  ),
  // Sealed Secrets (#240): failed unseals and synced SealedSecrets whose Secret is missing, judged by the provider of
  // features/sealed-secrets (`external`: the Secret is another object), held only where SealedSecrets are served.
  sealedSecrets: [{ category: "sealedSecrets", kind: SEALED_SECRET, fieldSelector: null, discovered: true, external: true }],
  // CloudNativePG (#213): unhealthy Clusters, failing archiving or backups, failed Backups.
  cnpg: [tool("cnpg", PG_CLUSTER), tool("cnpg", CNPG_BACKUP)],
  // Cluster API (#243): failed or unavailable Clusters and KubeadmControlPlanes, Machines failed or stuck
  // provisioning, MachineHealthChecks that stopped remediating; a management cluster can hold thousands of Machines:
  // capped.
  // Machines and control planes of a paused Cluster are left alone by its controllers: their problems are judged
  // across the Cluster source's rows (`CAPI_PAUSED_ACROSS`), and kept while those rows cannot be read in full.
  clusterApi: CAPI_PROBLEM_KINDS.map((kind) => {
    const def = tool("clusterApi", kind, kind === CAPI_MACHINE ? MAX_SOURCE_OBJECTS : undefined);
    return isCapiKind(kind, CAPI_MACHINE, CAPI_KCP) ? { ...def, across: { ...CAPI_PAUSED_ACROSS, from: tool("clusterApi", CAPI_CLUSTER) } } : def;
  }),
  // Dynamic Resource Allocation (#244): pods the scheduler has not placed because a claim has no devices, judged by
  // the provider of features/dra (`external`: Pending pods and their namespaces' claims), held only where
  // ResourceClaims are served.
  dra: [{ category: "dra", kind: DRA_CLAIM, fieldSelector: null, discovered: true, external: true }],
  // NVIDIA GPU Operator (#245): ClusterPolicies and NVIDIADrivers not ready, component DaemonSets not rolled out, MIG
  // configurations that failed on a node, judged by the provider of features/gpu-operator (`external`), held only
  // where ClusterPolicies are served.
  gpuOperator: [{ category: "gpuOperator", kind: GPU_CLUSTER_POLICY, fieldSelector: null, discovered: true, external: true }],
  // KubeRay (#248): failed RayClusters or ones whose head is not ready, failed RayJobs (batch jobs can be thousands:
  // capped), RayServices not ready. KServe (#249): InferenceServices not ready or whose model failed to load.
  kuberay: [tool("kuberay", RAY_CLUSTER), tool("kuberay", RAY_JOB, MAX_SOURCE_OBJECTS), tool("kuberay", RAY_SERVICE)],
  kserve: [tool("kserve", KSERVE_INFERENCE_SERVICE)],
  // Strimzi (#213): every kind of the section not ready; topics and users can be thousands: capped.
  strimzi: STRIMZI_KINDS.map((d) => tool("strimzi", d.kind, d.label === "topics" || d.label === "users" ? MAX_SOURCE_OBJECTS : undefined)),
  // Prometheus Operator (#213): Prometheus and Alertmanager not available; monitors that select nothing are judged
  // across objects by the provider of features/prometheus-operator (`external`), held only where ServiceMonitors are
  // served.
  prometheusOperator: [
    tool("prometheusOperator", PROMETHEUS),
    tool("prometheusOperator", ALERTMANAGER),
    { category: "prometheusOperator", kind: SERVICE_MONITOR, fieldSelector: null, discovered: true, external: true },
  ],
  // Watches of their own (`sourceKey`): judged only while the opt-in category is on, kept apart from the problems of
  // pods and workloads (the map's colours, the cap of `MAX_PROBLEM_OBJECTS`).
  security: [POD, DEPLOYMENT, STATEFULSET, DAEMONSET, REPLICASET, JOB, CRONJOB].map((kind) => builtIn("security", kind)),
  // Best-practice findings (#207, opt-in) span several objects (HPAs, PodDisruptionBudgets, LimitRanges, the nodes of
  // live pods): the provider of features/practices taps the shared watches and judges them (`external`).
  practices: [{ category: "practices", kind: DEPLOYMENT, fieldSelector: null, discovered: false, external: true }],
  // Expiring kubeconfig credentials (#150, opt-in) come from the kubeconfig, not from a watch: nothing is watched for
  // them (features/clusters/kubeconfig/CredentialsNotifier).
  credentials: [],
  // Claims almost full (#152, opt-in): from the kubelets' stats or Prometheus, polled while held (features/storage).
  disk: [{ category: "disk", kind: PVC, fieldSelector: null, discovered: false, external: true }],
  // Firing alerts (#264, opt-in): from Prometheus and Alertmanager, polled while held (features/alerts); nothing is
  // watched (a source of its own: `sourceKey`).
  alerts: [{ category: "alerts", kind: { group: "", version: "v1", kind: "Namespace" }, fieldSelector: null, discovered: false, external: true }],
  // Reflector mirrors (#241, opt-in): stale or without a source, judged by the provider of features/reflector over
  // metadata-only lists of every Secret and ConfigMap (`external`, a source of its own: `sourceKey`).
  reflector: [{ category: "reflector", kind: REFLECTOR_SECRET, fieldSelector: null, discovered: false, external: true }],
  // Only Warning events are listed.
  events: [builtIn("events", EVENT, "type=Warning")],
};

/**
 * The sources of `categories` the cluster can be watched for: built-in kinds always, a tool's kinds at the version
 * discovery reports. `kinds` `undefined`: discovery has not come (a tool's kinds wait); `null`: it failed (they are
 * left out).
 */
export function sourcesFor(categories: readonly ProblemCategory[], kinds: ResourceKind[] | null | undefined): SourceDef[] {
  const out: SourceDef[] = [];
  // A kind two categories of the list share is watched once.
  const seen = new Set<string>();
  const add = (def: SourceDef) => {
    const key = sourceKey("", def);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(def);
  };
  for (const category of categories) {
    for (const def of CATEGORY_SOURCES[category]) {
      if (!def.discovered) {
        add(def);
        continue;
      }
      const served = kinds ? findKind(kinds, def.kind)?.kindRef : undefined;
      if (served) add({ ...def, kind: served, ...servedAcross(def, kinds) });
    }
  }
  return out;
}

/**
 * A source's `across.from` with the version the cluster serves; without it served (or without discovery) the source
 * is judged on its own (`across` dropped: every problem stays).
 */
function servedAcross(def: SourceDef, kinds: ResourceKind[] | null | undefined): Pick<SourceDef, "across"> {
  const from = def.across?.from;
  if (!def.across || !from) return {};
  const served = from.discovered ? (kinds ? findKind(kinds, from.kind)?.kindRef : undefined) : from.kind;
  if (!served) return { across: undefined };
  return { across: { ...def.across, from: { ...from, kind: served } } };
}

/** Whether `categories` need discovery to be watched. */
/**
 * Whether the rules alone judge `kind` (its category watches it with a source of its own): when they find nothing it
 * is fine. A kind of a category whose problems come also from a provider (`external`: a ServiceMonitor that selects
 * nothing, judged across objects) is not: no rule finding does not mean no problem.
 */
export function judgedByRules(kind: Pick<KindRef, "group" | "kind">): boolean {
  const category = categoryOf(kind);
  if (!category) return false;
  const defs = CATEGORY_SOURCES[category];
  if (!defs.some((d) => d.external)) return true;
  return defs.some((d) => !d.external && d.kind.group === kind.group && d.kind.kind === kind.kind);
}

export function needsDiscovery(categories: readonly ProblemCategory[]): boolean {
  return categories.some((c) => CATEGORY_SOURCES[c].some((d) => d.discovered));
}

/** The store's key of a source in a cluster. */
export function sourceKey(clusterId: string, def: Pick<SourceDef, "kind" | "fieldSelector"> & { category?: ProblemCategory }): string {
  const { group, version, kind } = def.kind;
  const key = `${clusterId}|${group}/${version}/${kind}|${def.fieldSelector ?? ""}`;
  // A security source judges the same kinds as pods and workloads by other rules: a source of its own; so is the
  // provider's source of full claims, which watches nothing.
  if (def.category === "practices") return `${key}|${def.category}`;
  if (def.category === "reflector") return `${key}|${def.category}`;
  if (def.category === "alerts") return `${key}|${def.category}`;
  return def.category === "security" || def.category === "disk" ? `${key}|${def.category}` : key;
}
