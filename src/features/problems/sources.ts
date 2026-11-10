// Which kinds are watched for each category of problems. Built-in kinds are watched without discovery; the kinds of
// installed tools (cert-manager, Gateway API, …) only once discovery says the cluster serves them, at the
// version it serves.
import type { KindRef, KubeObject, ResourceKind } from "../../api";
import { findKind } from "../../resources";
import { COUNTED_KINDS } from "../gateway-api/problems";
import { CONTOUR_ACROSS } from "../contour/across";
import { HTTP_PROXY } from "../contour/model";
import { INGRESS_ROUTE as TRAEFIK_INGRESS_ROUTE } from "../traefik/model";
import { XRD } from "../crossplane/model";
import { CAPI_PAUSED_ACROSS } from "../cluster-api/across";
import {
  CAPI_CLUSTER,
  isKind as isCapiKind,
  KUBEADM_CONTROL_PLANE as CAPI_KCP,
  MACHINE as CAPI_MACHINE,
  PROBLEM_KINDS as CAPI_PROBLEM_KINDS,
} from "../cluster-api/model";
import { ALERTMANAGER, PROMETHEUS, SERVICE_MONITOR } from "../prometheus-operator/model";
import { SEALED_SECRET } from "../sealed-secrets/model";
import { VPA } from "../vpa/model";
import { RESOURCE_CLAIM as DRA_CLAIM } from "../dra/model";
import { HELM_CHART as K3S_HELM_CHART } from "../k3s/model";
import { BUILD_ACROSS as OPENSHIFT_BUILD_ACROSS } from "../openshift/across";
import { BUILD as OPENSHIFT_BUILD, DEPLOYMENT_CONFIG as OPENSHIFT_DC, IMAGE_STREAM as OPENSHIFT_IMAGE_STREAM, ROUTE as OPENSHIFT_ROUTE } from "../openshift/model";
import { SECRET as REFLECTOR_SECRET } from "../reflector/model";
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
  type BuiltInCategory,
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
   * Only these namespaces are watched (within the accessible ones, ADR-0124): an extension's rules run only where it
   * may read (ADR-0137). `undefined`: every namespace.
   */
  namespaces?: readonly string[];
  /** Only the objects this label selector picks (an extension rule's `source`, ADR-0152). */
  labelSelector?: string;
  /** Only `apiVersion`, `kind` and `metadata` of each object (an extension rule's `source`, ADR-0152). */
  metadataOnly?: boolean;
  /**
   * Problems judged across the objects of the source: the store keeps a row tap of the watch while the source is held
   * and passes every problem list through `keep` with the rows (an HTTPProxy orphaned because the root that includes
   * it is invalid is told through that root, #233). `keep` runs only while the rows are read in full.
   */
  across?: AcrossDef;
  /**
   * An extension's rules across objects (ADR-0144): the source keeps a row tap of its own objects while it lives, and
   * every problem list goes through `judge`, which may read the rows of the category's other sources of the cluster
   * (`targets`) and which of them have problems. Unlike `across`, it runs while rows still load: what it cannot tell
   * yet is no problem.
   */
  judge?: JudgeDef;
}

/** A source's problems judged with its rows and its category's other sources (`SourceDef.judge`). */
export interface JudgeDef {
  tap: { id: string; toRow(obj: KubeObject): unknown; max: number };
  judge(problems: readonly Problem[], context: JudgeContext): Problem[];
}

/** What `JudgeDef.judge` may read, at the time it runs. */
export interface JudgeContext {
  /** The rows of the source's own tap. */
  rows: JudgedRows | undefined;
  /** The rows of another source of the cluster (under the same tap id), and the namespaces it watches. */
  target(def: SourceDef): JudgedRows | undefined;
  /** The uids of the objects with problems (counted or not yet) in the category's sources of the cluster. */
  problemUids(): ReadonlySet<string>;
}

export interface JudgedRows {
  status: "loading" | "ready" | "reconnecting" | "error";
  rows: ReadonlyMap<string, unknown>;
  truncated: boolean;
  /** The namespaces the source watches (`null`: every namespace); `undefined` before it opened. */
  namespaces: readonly string[] | null | undefined;
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

export const CATEGORY_SOURCES: Record<BuiltInCategory, SourceDef[]> = {
  nodes: [builtIn("nodes", NODE)],
  pods: [builtIn("pods", POD)],
  workloads: [builtIn("workloads", DEPLOYMENT), builtIn("workloads", STATEFULSET), builtIn("workloads", DAEMONSET)],
  jobs: [builtIn("jobs", JOB)],
  // Vertical Pod Autoscaler (#242): configurations the recommender cannot use, VPAs that match no pod, and VPAs that
  // fight an HPA over the same resource, judged by the provider of features/vpa (`external`: the HPA is another
  // object), held only where VPAs are served.
  vpa: [{ category: "vpa", kind: VPA, fieldSelector: null, discovered: true, external: true }],
  volumes: [builtIn("volumes", PVC)],
  certificates: [tool("certificates", CERTIFICATE)],
  gateway: COUNTED_KINDS.map((kind) => tool("gateway", kind)),
  // Istio routing and mTLS mistakes (#155): judged across objects by the provider of features/mesh (`external`), held
  // only where the cluster serves VirtualServices.
  mesh: [{ category: "mesh", kind: { group: "networking.istio.io", version: "v1", kind: "VirtualService" }, fieldSelector: null, discovered: true, external: true }],
  // Traefik (#232, opt-in): references to objects that do not exist, judged across objects by the provider of
  // features/traefik (`external`), held only where the cluster serves IngressRoutes (traefik.io); no Secret is listed.
  traefik: [{ category: "traefik", kind: TRAEFIK_INGRESS_ROUTE, fieldSelector: null, discovered: true, external: true }],
  // Contour (#233): invalid and orphaned HTTPProxies; the same watch feeds the delegation tree (a row tap), and those
  // rows tell an orphan under an invalid root through the root (`across`).
  contour: [{ ...tool("contour", HTTP_PROXY, MAX_SOURCE_OBJECTS), across: CONTOUR_ACROSS }],
  // Crossplane claims and composites (#213) are kinds the XRDs define: the provider of features/crossplane watches the
  // XRDs and the kinds they name (bounded there) and judges them (`external`), held only where XRDs are served.
  crossplane: [{ category: "crossplane", kind: XRD, fieldSelector: null, discovered: true, external: true }],
  // Sealed Secrets (#240): failed unseals and synced SealedSecrets whose Secret is missing, judged by the provider of
  // features/sealed-secrets (`external`: the Secret is another object), held only where SealedSecrets are served.
  sealedSecrets: [{ category: "sealedSecrets", kind: SEALED_SECRET, fieldSelector: null, discovered: true, external: true }],
  // CloudNativePG (#213): unhealthy Clusters, failing archiving or backups, failed Backups.
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
  // k3s and RKE2 (#270): HelmCharts whose install Job failed or keeps failing, bundled components' Deployments not
  // available, judged by the provider of features/k3s (`external`: the Job and the Deployments are other objects), held
  // only where HelmCharts are served (its watches are bounded there).
  k3s: [{ category: "k3s", kind: K3S_HELM_CHART, fieldSelector: null, discovered: true, external: true }],
  // KubeRay (#248): failed RayClusters or ones whose head is not ready, failed RayJobs (batch jobs can be thousands:
  // capped), RayServices not ready. KServe (#249): InferenceServices not ready or whose model failed to load.
  // OpenShift (#267): Routes no router admitted, DeploymentConfigs whose rollout failed, failed Builds (only the latest
  // of their BuildConfig: judged across the Build rows) and ImageStreams with a failing tag import; every kind a cluster
  // can hold by the thousand: capped.
  openshift: [
    tool("openshift", OPENSHIFT_ROUTE, MAX_SOURCE_OBJECTS),
    tool("openshift", OPENSHIFT_DC, MAX_SOURCE_OBJECTS),
    { ...tool("openshift", OPENSHIFT_BUILD, MAX_SOURCE_OBJECTS), across: OPENSHIFT_BUILD_ACROSS },
    tool("openshift", OPENSHIFT_IMAGE_STREAM, MAX_SOURCE_OBJECTS),
  ],
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
    // An extension's category has its sources per cluster (`extensionSourcesFor`).
    for (const def of builtInSources(category)) {
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
  const defs = builtInSources(category);
  if (!defs.some((d) => d.external)) return true;
  return defs.some((d) => !d.external && d.kind.group === kind.group && d.kind.kind === kind.kind);
}

export function needsDiscovery(categories: readonly ProblemCategory[]): boolean {
  // An extension's rules judge kinds of discovery.
  return categories.some((c) => c.startsWith("ext:") || builtInSources(c).some((d) => d.discovered));
}

/** The sources of a built-in category; none for an extension's. */
function builtInSources(category: ProblemCategory): readonly SourceDef[] {
  return (CATEGORY_SOURCES as Record<string, SourceDef[] | undefined>)[category] ?? [];
}

/** The store's key of a source in a cluster. */
export function sourceKey(
  clusterId: string,
  def: Pick<SourceDef, "kind" | "fieldSelector" | "namespaces" | "labelSelector" | "metadataOnly"> & { category?: ProblemCategory },
): string {
  const { group, version, kind } = def.kind;
  const key = `${clusterId}|${group}/${version}/${kind}|${def.fieldSelector ?? ""}`;
  // An extension's rules judge their own sources, over the namespaces the extension may read, with their rules' source.
  if (def.category?.startsWith("ext:")) {
    return `${key}|${def.category}|${def.namespaces?.join(",") ?? "*"}|${def.labelSelector ?? ""}|${def.metadataOnly ? "meta" : ""}`;
  }
  // A security source judges the same kinds as pods and workloads by other rules: a source of its own; so is the
  // provider's source of full claims, which watches nothing.
  if (def.category === "practices") return `${key}|${def.category}`;
  if (def.category === "reflector") return `${key}|${def.category}`;
  if (def.category === "alerts") return `${key}|${def.category}`;
  return def.category === "security" || def.category === "disk" ? `${key}|${def.category}` : key;
}
