// What the k3s / RKE2 views read (#270, ADR-0123), from the projects' own sources:
//
//   Recognition, per node (k3s-io/k3s; RKE2 runs the same code with `version.Program` = "rke2"):
//     - `status.nodeInfo.kubeletVersion` ends in `+k3s<n>` (k3s releases, `v1.33.4+k3s1`) or `+rke2r<n>` (RKE2
//       releases, `v1.33.4+rke2r1`);
//     - the annotations `<program>.io/node-args`, `/node-env`, `/node-config-hash` (pkg/nodeconfig/nodeconfig.go) and
//       `<program>.io/hostname`, `/internal-ip`, `/external-ip` (pkg/cloudprovider/instances.go `HostnameKey`, …);
//     - `spec.providerID` `<program>://<node name>` and the label `node.kubernetes.io/instance-type` = `<program>`,
//       both set by the embedded cloud controller (pkg/cloudprovider/instances.go `InstanceMetadata`; absent with
//       `--disable-cloud-controller` or another cloud provider, and the label can be overridden);
//     - roles: `node-role.kubernetes.io/control-plane` = "true" on servers (pkg/server/server.go
//       `setNodeLabelsAndAnnotations`), `node-role.kubernetes.io/etcd` on embedded etcd members (pkg/util/labels.go),
//       and `node-role.kubernetes.io/master` on servers of older releases; `etcd.<program>.cattle.io/node-name` names
//       a node's etcd member (pkg/etcd/etcd.go `NodeNameAnnotation`).
//   Bundled components: the manifests k3s writes to `server/manifests` (k3s manifests/: coredns.yaml → Deployment
//     `coredns`, local-storage.yaml → Deployment `local-path-provisioner`, metrics-server/ → Deployment
//     `metrics-server`, traefik.yaml → HelmCharts `traefik-crd` and `traefik`, all in kube-system), each applied as an
//     Addon (`k3s.cattle.io/v1`, named after the file's basename up to its first dot, in kube-system: pkg/deploy
//     `basename`, `getOrCreateAddon`) that owns what it applied through wrangler's annotations
//     `objectset.rio.cattle.io/owner-gvk` / `owner-name` / `owner-namespace` (rancher/wrangler pkg/apply); RKE2's
//     HelmCharts `rke2-*` in kube-system (rancher/rke2 charts/chart_versions.yaml); ServiceLB's DaemonSets
//     `svclb-<service>-<uid[:8]>` labelled `svccontroller.<program>.cattle.io/svcname` and `/svcnamespace`
//     (pkg/cloudprovider/servicelb.go `generateName`, `svcNameLabel`, `svcNamespaceLabel`). A workload a HelmChart
//     installed carries Helm's `meta.helm.sh/release-name` annotation with the chart's name (helm pkg/action
//     `setMetadataVisitor`; helm-controller installs the release under the HelmChart's name).
//   helm-controller (k3s-io/helm-controller pkg/apis/helm.cattle.io/v1/types.go, pkg/controllers/chart/chart.go):
//     HelmChart `spec.chart`, `repo`, `version`, `targetNamespace` (default: the chart's namespace), `valuesContent`,
//     `set`, `valuesSecrets`, `bootstrap`, `failurePolicy`, `backOffLimit` (default 1000), `timeout`, `jobImage`,
//     `authSecret`, `repoCAConfigMap`, `dockerRegistrySecret`; `status.jobName` and the conditions `JobCreated` and
//     `Failed` (type, status, reason, message — no time); the Job `helm-install-<name>` (`helm-delete-<name>` while
//     the chart is deleted) in the chart's namespace, labelled `helmcharts.helm.cattle.io/chart: <name>` on the Job and
//     its pod template, one container `helm`; HelmChartConfig of the same name and namespace overrides its values.
//   etcd snapshots (k3s-io/api k3s.cattle.io/v1/types.go): ETCDSnapshotFile (cluster-scoped) `spec.snapshotName`,
//     `nodeName`, `location` (a `file://` or `s3://` URI), `s3`; `status.size`, `creationTime`, `readyToUse`, `error`.
// Pure functions, no React. Read-only.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import { cleanText } from "../../resources/uri";
import { nodeArgs, type NodeArg } from "./mask";

const { arr, get, num, record, str } = status;

export const HELM_GROUP = "helm.cattle.io";
export const K3S_GROUP = "k3s.cattle.io";
export const HELM_CHART: KindRef = { group: HELM_GROUP, version: "v1", kind: "HelmChart" };
export const HELM_CHART_CONFIG: KindRef = { group: HELM_GROUP, version: "v1", kind: "HelmChartConfig" };
export const ADDON: KindRef = { group: K3S_GROUP, version: "v1", kind: "Addon" };
export const ETCD_SNAPSHOT: KindRef = { group: K3S_GROUP, version: "v1", kind: "ETCDSnapshotFile" };
export const NODE: KindRef = { group: "", version: "v1", kind: "Node" };
export const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
export const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
export const DAEMONSET: KindRef = { group: "apps", version: "v1", kind: "DaemonSet" };
export const JOB: KindRef = { group: "batch", version: "v1", kind: "Job" };

export const KUBE_SYSTEM = "kube-system";

export const isKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">): boolean => a.group === b.group && a.kind === b.kind;
export const isHelmControllerKind = (kind: Pick<KindRef, "group" | "kind">): boolean => isKind(kind, HELM_CHART) || isKind(kind, HELM_CHART_CONFIG);
export const isK3sKind = (kind: Pick<KindRef, "group" | "kind">): boolean => isKind(kind, ADDON) || isKind(kind, ETCD_SNAPSHOT);

const labelsOf = (obj: KubeObject): Record<string, unknown> => record(get(obj, "metadata", "labels"));
const annotationsOf = (obj: KubeObject): Record<string, unknown> => record(get(obj, "metadata", "annotations"));
const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

// ---------- Recognition ----------

export type Distribution = "k3s" | "rke2";
export const DISTRIBUTIONS: readonly Distribution[] = ["k3s", "rke2"];

/** What told the distribution, in the order it is trusted. */
export type Signal = "kubeletVersion" | "annotations" | "providerId" | "instanceType";

export const LABEL_INSTANCE_TYPE = "node.kubernetes.io/instance-type";
export const ROLE_CONTROL_PLANE = "node-role.kubernetes.io/control-plane";
export const ROLE_ETCD = "node-role.kubernetes.io/etcd";
export const ROLE_MASTER = "node-role.kubernetes.io/master";

/** The annotations of pkg/nodeconfig and pkg/cloudprovider, without the `<program>.io/` prefix. */
const NODE_ANNOTATIONS = ["node-args", "node-env", "node-config-hash", "hostname", "internal-ip", "external-ip"];

const VERSION_SUFFIX: Record<Distribution, RegExp> = { k3s: /\+k3s\d+$/, rke2: /\+rke2r\d+$/ };

export type NodeRole = "controlPlane" | "etcd" | "master";

export interface NodeDistribution {
  name: string;
  distribution?: Distribution;
  /** The kubelet's version (`v1.33.4+k3s1`). */
  version?: string;
  signals: Signal[];
  roles: NodeRole[];
  /** A server (control-plane role, or the `server` subcommand in its arguments); else an agent. */
  server: boolean;
  hostname?: string;
  internalIp?: string;
  externalIp?: string;
  /** The node's etcd member (`etcd.<program>.cattle.io/node-name`). */
  etcdMember?: string;
  /** `<program>.io/node-args`: `undefined` absent, `null` unreadable. */
  args?: NodeArg[] | null;
}

/** The distribution each signal names, if any. */
function signalsOf(node: KubeObject): Partial<Record<Signal, Distribution>> {
  const out: Partial<Record<Signal, Distribution>> = {};
  const version = str(get(node, "status", "nodeInfo", "kubeletVersion")) ?? "";
  const providerId = str(get(node, "spec", "providerID")) ?? "";
  const instanceType = text(labelsOf(node)[LABEL_INSTANCE_TYPE]);
  const annotations = annotationsOf(node);
  for (const d of DISTRIBUTIONS) {
    if (!out.kubeletVersion && VERSION_SUFFIX[d].test(version)) out.kubeletVersion = d;
    if (!out.annotations && NODE_ANNOTATIONS.some((a) => `${d}.io/${a}` in annotations)) out.annotations = d;
    if (!out.providerId && providerId.startsWith(`${d}://`)) out.providerId = d;
    if (!out.instanceType && instanceType === d) out.instanceType = d;
  }
  return out;
}

const SIGNAL_ORDER: Signal[] = ["kubeletVersion", "annotations", "providerId", "instanceType"];

export function nodeDistributionOf(node: KubeObject): NodeDistribution {
  const found = signalsOf(node);
  const first = SIGNAL_ORDER.find((s) => found[s] !== undefined);
  const distribution = first ? found[first] : undefined;
  const labels = labelsOf(node);
  const roles: NodeRole[] = [];
  if (ROLE_CONTROL_PLANE in labels) roles.push("controlPlane");
  if (ROLE_ETCD in labels) roles.push("etcd");
  if (ROLE_MASTER in labels) roles.push("master");
  const out: NodeDistribution = {
    name: node.metadata?.name ?? "",
    signals: SIGNAL_ORDER.filter((s) => distribution !== undefined && found[s] === distribution),
    roles,
    server: roles.length > 0,
  };
  const version = str(get(node, "status", "nodeInfo", "kubeletVersion"));
  if (version) out.version = version;
  if (!distribution) return out;
  out.distribution = distribution;
  const annotations = annotationsOf(node);
  const annotation = (key: string) => text(annotations[key]);
  const set = (field: "hostname" | "internalIp" | "externalIp" | "etcdMember", key: string) => {
    const v = annotation(key);
    if (v) out[field] = v;
  };
  set("hostname", `${distribution}.io/hostname`);
  set("internalIp", `${distribution}.io/internal-ip`);
  set("externalIp", `${distribution}.io/external-ip`);
  set("etcdMember", `etcd.${distribution}.cattle.io/node-name`);
  const args = nodeArgs(annotation(`${distribution}.io/node-args`));
  if (args !== undefined) out.args = args;
  if (args && args[0] && !args[0].flag && args[0].value === "server") out.server = true;
  return out;
}

export interface ClusterDistribution {
  /** `mixed`: nodes of both; `undefined`: no node recognised. */
  distribution?: Distribution | "mixed";
  /** The kubelet versions of the recognised nodes, sorted, without repeats. */
  versions: string[];
  recognised: number;
  total: number;
  servers: number;
  agents: number;
  /** Some node is an embedded etcd member. */
  embeddedEtcd: boolean;
}

export function clusterDistributionOf(nodes: Iterable<KubeObject>): ClusterDistribution {
  const seen = new Set<Distribution>();
  const versions = new Set<string>();
  const out: ClusterDistribution = { versions: [], recognised: 0, total: 0, servers: 0, agents: 0, embeddedEtcd: false };
  for (const node of nodes) {
    out.total++;
    const d = nodeDistributionOf(node);
    if (!d.distribution) continue;
    out.recognised++;
    seen.add(d.distribution);
    if (d.version) versions.add(d.version);
    if (d.server) out.servers++;
    else out.agents++;
    if (d.roles.includes("etcd")) out.embeddedEtcd = true;
  }
  out.versions = [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (seen.size === 1) out.distribution = [...seen][0];
  else if (seen.size > 1) out.distribution = "mixed";
  return out;
}

// ---------- Addons (wrangler's owner annotations) ----------

export const OWNER_GVK = "objectset.rio.cattle.io/owner-gvk";
export const OWNER_NAME = "objectset.rio.cattle.io/owner-name";
export const OWNER_NAMESPACE = "objectset.rio.cattle.io/owner-namespace";
/** `schema.GroupVersionKind.String()` of an Addon. */
export const ADDON_GVK = "k3s.cattle.io/v1, Kind=Addon";

/** The Addon that applied `obj` (it came from the server's manifests directory), if any. */
export function addonOwnerOf(obj: KubeObject): { name: string; namespace: string } | undefined {
  const a = annotationsOf(obj);
  if (a[OWNER_GVK] !== ADDON_GVK) return undefined;
  const name = text(a[OWNER_NAME]);
  return name ? { name, namespace: text(a[OWNER_NAMESPACE]) ?? KUBE_SYSTEM } : undefined;
}

export const addonSourceOf = (addon: KubeObject): string | undefined => str(get(addon, "spec", "source")) || undefined;
export const addonChecksumOf = (addon: KubeObject): string | undefined => str(get(addon, "spec", "checksum")) || undefined;

// ---------- HelmCharts ----------

export const CHART_LABEL = "helmcharts.helm.cattle.io/chart";
export const RELEASE_NAME = "meta.helm.sh/release-name";
export const RELEASE_NAMESPACE = "meta.helm.sh/release-namespace";
/** helm-controller's `defaultBackOffLimit`. */
export const DEFAULT_BACKOFF_LIMIT = 1000;

const deleting = (obj: KubeObject): boolean => Boolean((obj.metadata as { deletionTimestamp?: string } | undefined)?.deletionTimestamp);

export interface HelmCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export function helmConditionOf(chart: KubeObject, type: "JobCreated" | "Failed"): HelmCondition | undefined {
  const c = arr(get(chart, "status", "conditions")).find((x) => get(x, "type") === type);
  if (!c) return undefined;
  return {
    type,
    status: str(get(c, "status")) ?? "Unknown",
    reason: str(get(c, "reason")) || undefined,
    message: str(get(c, "message")) || undefined,
  };
}

export interface ChartInfo {
  chart?: string;
  /** `repo` without credentials, query or fragment. */
  repo?: string;
  version?: string;
  targetNamespace: string;
  bootstrap: boolean;
  failurePolicy?: string;
  backOffLimit: number;
  timeout?: string;
  jobImage?: string;
  /** The Job helm-controller runs for it now (`status.jobName`, else the name it would give it). */
  jobName: string;
  createNamespace: boolean;
}

/** `helm-install-<name>`, or `helm-delete-<name>` while the chart is deleted (chart.go `jobName`). */
export const jobNameFor = (chart: KubeObject): string => `helm-${deleting(chart) ? "delete" : "install"}-${chart.metadata?.name ?? ""}`;

export function chartInfoOf(chart: KubeObject): ChartInfo {
  const spec = (k: string) => get(chart, "spec", k);
  const out: ChartInfo = {
    targetNamespace: str(spec("targetNamespace")) || chart.metadata?.namespace || "",
    bootstrap: spec("bootstrap") === true,
    backOffLimit: num(spec("backOffLimit")) ?? DEFAULT_BACKOFF_LIMIT,
    jobName: str(get(chart, "status", "jobName")) || jobNameFor(chart),
    createNamespace: spec("createNamespace") === true,
  };
  const set = (field: "chart" | "repo" | "version" | "failurePolicy" | "timeout" | "jobImage", value: string | undefined) => {
    if (value) out[field] = value;
  };
  set("chart", cleanText(str(spec("chart"))));
  set("repo", cleanText(str(spec("repo"))));
  set("version", str(spec("version")));
  set("failurePolicy", str(spec("failurePolicy")));
  set("timeout", str(spec("timeout")));
  set("jobImage", str(spec("jobImage"))?.trim());
  return out;
}

/** The names of the Secrets and ConfigMaps a HelmChart reads (never their contents). */
export function chartReferencesOf(chart: KubeObject): { authSecret?: string; repoCaConfigMap?: string; registrySecret?: string; valuesSecrets: { name: string; keys: string[] }[] } {
  const name = (field: string) => str(get(chart, "spec", field, "name")) || undefined;
  const out: ReturnType<typeof chartReferencesOf> = { valuesSecrets: valuesSecretsOf(chart) };
  const auth = name("authSecret");
  const ca = name("repoCAConfigMap");
  const registry = name("dockerRegistrySecret");
  if (auth) out.authSecret = auth;
  if (ca) out.repoCaConfigMap = ca;
  if (registry) out.registrySecret = registry;
  return out;
}

/** `spec.valuesSecrets` of a HelmChart or HelmChartConfig: names and key names only. */
export function valuesSecretsOf(obj: KubeObject): { name: string; keys: string[] }[] {
  return arr(get(obj, "spec", "valuesSecrets")).flatMap((s) => {
    const name = str(get(s, "name"));
    return name ? [{ name, keys: arr(get(s, "keys")).flatMap((k) => (typeof k === "string" ? [k] : [])) }] : [];
  });
}

// ---------- The install Job ----------

export type JobState = "running" | "complete" | "failed" | "pending";

export interface JobInfo {
  name: string;
  namespace: string;
  state: JobState;
  /** Pods that failed so far (`status.failed`). */
  failed: number;
  active: number;
  /** When the Job ended Failed (its Failed condition). */
  failedAt?: string;
  completedAt?: string;
  startedAt?: string;
  message?: string;
}

function jobCondition(job: KubeObject, type: string): Record<string, unknown> | undefined {
  return arr(get(job, "status", "conditions")).find((c) => get(c, "type") === type && get(c, "status") === "True") as Record<string, unknown> | undefined;
}

export function jobInfoOf(job: KubeObject): JobInfo {
  const failedCondition = jobCondition(job, "Failed");
  const complete = jobCondition(job, "Complete");
  const active = num(get(job, "status", "active")) ?? 0;
  const state: JobState = failedCondition ? "failed" : complete ? "complete" : active > 0 || num(get(job, "status", "failed")) ? "running" : "pending";
  const out: JobInfo = {
    name: job.metadata?.name ?? "",
    namespace: job.metadata?.namespace ?? "",
    state,
    failed: num(get(job, "status", "failed")) ?? 0,
    active,
  };
  const failedAt = str(get(failedCondition, "lastTransitionTime"));
  if (failedAt) out.failedAt = failedAt;
  const message = str(get(failedCondition, "message"));
  if (message) out.message = message;
  const completedAt = str(get(job, "status", "completionTime"));
  if (completedAt) out.completedAt = completedAt;
  const startedAt = str(get(job, "status", "startTime"));
  if (startedAt) out.startedAt = startedAt;
  return out;
}

/** The chart a Job runs for (its `helmcharts.helm.cattle.io/chart` label). */
export const chartOfJob = (job: KubeObject): string | undefined => text(labelsOf(job)[CHART_LABEL]);

/** The Job of `chart` among `jobs` (those labelled for it): the one `status.jobName` names, else the newest. */
export function jobOfChart(chart: KubeObject, jobs: readonly KubeObject[]): KubeObject | undefined {
  const ns = chart.metadata?.namespace;
  const name = chart.metadata?.name;
  const own = jobs.filter((j) => j.metadata?.namespace === ns && chartOfJob(j) === name);
  const wanted = chartInfoOf(chart).jobName;
  return (
    own.find((j) => j.metadata?.name === wanted) ??
    own.sort((a, b) => String(b.metadata?.creationTimestamp ?? "").localeCompare(String(a.metadata?.creationTimestamp ?? "")))[0]
  );
}

// ---------- A HelmChart's state ----------

/**
 * `failed`: helm-controller's Failed condition, or the Job failed; `retrying`: the Job runs again after failed pods;
 * `installing`: the Job runs; `deployed`: the Job completed; `deleting`: the chart is being removed; `applied`: the
 * Job was created (all a table row can tell without the Job); `unknown`: neither conditions nor a Job (an older
 * helm-controller).
 */
export type ChartState = "deployed" | "installing" | "retrying" | "failed" | "deleting" | "applied" | "unknown";

export const CHART_TONE: Record<ChartState, Tone> = {
  deployed: "success",
  installing: "warning",
  retrying: "warning",
  failed: "danger",
  deleting: "muted",
  applied: "neutral",
  unknown: "muted",
};

/** The state of a HelmChart, with its Job when known. */
export function chartStateOf(chart: KubeObject, job?: KubeObject): ChartState {
  if (helmConditionOf(chart, "Failed")?.status === "True") return "failed";
  const info = job ? jobInfoOf(job) : undefined;
  if (info?.state === "failed") return "failed";
  if (deleting(chart)) return "deleting";
  if (info?.state === "complete") return "deployed";
  if (info?.state === "running") return info.failed > 0 ? "retrying" : "installing";
  if (info?.state === "pending") return "installing";
  if (helmConditionOf(chart, "JobCreated")?.status === "True") return "applied";
  return "unknown";
}

/** Why it failed, in helm-controller's or the Job's words. */
export function chartFailureOf(chart: KubeObject, job?: KubeObject): string | undefined {
  const failed = helmConditionOf(chart, "Failed");
  if (failed?.status === "True") return failed.message ?? failed.reason;
  return job ? jobInfoOf(job).message : undefined;
}

// ---------- HelmChartConfig ----------

/** A HelmChartConfig overrides the HelmChart of its own name and namespace (chart.go `confCache.Get`). */
export const configTargetOf = (config: KubeObject): { name: string; namespace: string } => ({
  name: config.metadata?.name ?? "",
  namespace: config.metadata?.namespace ?? "",
});

// ---------- Bundled components ----------

export interface ComponentDef {
  /** Key under `k3s:component`. */
  id: string;
  distribution: Distribution;
  /** The Addon (manifest file) that deploys it. */
  addon?: string;
  /** The HelmChart that installs it; its workloads carry `meta.helm.sh/release-name` = this name. */
  helmChart?: string;
  /** Deployments of its own manifest, by name. */
  deployments?: string[];
  /** What `--disable` takes to leave it out (`--disable traefik`), or the RKE2 option. */
  disable?: string;
  /** ServiceLB: DaemonSets per LoadBalancer Service. */
  serviceLb?: boolean;
}

export const COMPONENTS: ComponentDef[] = [
  { id: "coredns", distribution: "k3s", addon: "coredns", deployments: ["coredns"], disable: "coredns" },
  { id: "traefik", distribution: "k3s", addon: "traefik", helmChart: "traefik", disable: "traefik" },
  { id: "localPath", distribution: "k3s", addon: "local-storage", deployments: ["local-path-provisioner"], disable: "local-storage" },
  { id: "metricsServer", distribution: "k3s", addon: "metrics-server-deployment", deployments: ["metrics-server"], disable: "metrics-server" },
  { id: "serviceLb", distribution: "k3s", serviceLb: true, disable: "servicelb" },
  { id: "rke2Coredns", distribution: "rke2", addon: "rke2-coredns", helmChart: "rke2-coredns", disable: "rke2-coredns" },
  { id: "rke2IngressNginx", distribution: "rke2", addon: "rke2-ingress-nginx", helmChart: "rke2-ingress-nginx", disable: "rke2-ingress-nginx" },
  { id: "rke2Traefik", distribution: "rke2", addon: "rke2-traefik", helmChart: "rke2-traefik", disable: "rke2-traefik" },
  { id: "rke2MetricsServer", distribution: "rke2", addon: "rke2-metrics-server", helmChart: "rke2-metrics-server", disable: "rke2-metrics-server" },
  { id: "rke2SnapshotController", distribution: "rke2", addon: "rke2-snapshot-controller", helmChart: "rke2-snapshot-controller", disable: "rke2-snapshot-controller" },
  { id: "rke2Canal", distribution: "rke2", addon: "rke2-canal", helmChart: "rke2-canal" },
  { id: "rke2Calico", distribution: "rke2", addon: "rke2-calico", helmChart: "rke2-calico" },
  { id: "rke2Cilium", distribution: "rke2", addon: "rke2-cilium", helmChart: "rke2-cilium" },
  { id: "rke2Flannel", distribution: "rke2", addon: "rke2-flannel", helmChart: "rke2-flannel" },
  { id: "rke2Multus", distribution: "rke2", addon: "rke2-multus", helmChart: "rke2-multus" },
  { id: "serviceLbRke2", distribution: "rke2", serviceLb: true },
];

export type WorkloadKind = "Deployment" | "DaemonSet";

/** Whether a kube-system Deployment or DaemonSet is a workload of `def`. */
export function isComponentWorkload(def: ComponentDef, kind: WorkloadKind, obj: KubeObject): boolean {
  if (def.serviceLb) return kind === "DaemonSet" && serviceLbOf(obj)?.program === def.distribution;
  if (kind === "Deployment" && def.deployments?.includes(obj.metadata?.name ?? "")) return true;
  return def.helmChart !== undefined && text(annotationsOf(obj)[RELEASE_NAME]) === def.helmChart;
}

/** The component a kube-system Deployment belongs to, if it is a known one (the problems judge only these). */
export function componentOfDeployment(obj: KubeObject): ComponentDef | undefined {
  if ((obj.metadata?.namespace ?? "") !== KUBE_SYSTEM) return undefined;
  return COMPONENTS.find((def) => isComponentWorkload(def, "Deployment", obj));
}

export interface WorkloadState {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  desired: number;
  available: number;
  ready: boolean;
  /** When a Deployment's Available condition went False. */
  unavailableSince?: string;
}

export function workloadStateOf(kind: WorkloadKind, obj: KubeObject): WorkloadState {
  const n = (field: string) => num(get(obj, "status", field)) ?? 0;
  const desired = kind === "DaemonSet" ? n("desiredNumberScheduled") : (num(get(obj, "spec", "replicas")) ?? 1);
  const available = kind === "DaemonSet" ? n("numberAvailable") : n("availableReplicas");
  const condition = arr(get(obj, "status", "conditions")).find((c) => get(c, "type") === "Available");
  const conditionFalse = condition !== undefined && get(condition, "status") === "False";
  const out: WorkloadState = {
    kind,
    name: obj.metadata?.name ?? "",
    namespace: obj.metadata?.namespace ?? "",
    desired,
    available,
    ready: !conditionFalse && available >= desired,
  };
  const since = conditionFalse ? str(get(condition, "lastTransitionTime")) : undefined;
  if (since) out.unavailableSince = since;
  return out;
}

/** `notFound`: neither its Addon, its HelmChart nor a workload (left out with `--disable`, or removed). */
export type ComponentState = "ready" | "notReady" | "installing" | "failed" | "noWorkload" | "notFound";

export const COMPONENT_TONE: Record<ComponentState, Tone> = {
  ready: "success",
  notReady: "warning",
  installing: "warning",
  failed: "danger",
  noWorkload: "muted",
  notFound: "muted",
};

export interface ComponentRow {
  def: ComponentDef;
  state: ComponentState;
  addon?: KubeObject;
  chart?: KubeObject;
  chartState?: ChartState;
  workloads: WorkloadState[];
}

export interface ComponentInputs {
  addons: readonly KubeObject[];
  charts: readonly KubeObject[];
  jobs: readonly KubeObject[];
  /** kube-system's Deployments and DaemonSets. */
  deployments: readonly KubeObject[];
  daemonSets: readonly KubeObject[];
}

/** The components of `distribution` with what the cluster has of each. */
export function componentsOf(distribution: Distribution, input: ComponentInputs): ComponentRow[] {
  return COMPONENTS.filter((def) => def.distribution === distribution).map((def) => {
    const addon = def.addon ? input.addons.find((a) => a.metadata?.name === def.addon && a.metadata?.namespace === KUBE_SYSTEM) : undefined;
    const chart = def.helmChart ? input.charts.find((c) => c.metadata?.name === def.helmChart && c.metadata?.namespace === KUBE_SYSTEM) : undefined;
    const chartState = chart ? chartStateOf(chart, jobOfChart(chart, input.jobs)) : undefined;
    const inKubeSystem = (w: KubeObject) => (w.metadata?.namespace ?? "") === KUBE_SYSTEM;
    const workloads = [
      ...input.deployments.filter((w) => inKubeSystem(w) && isComponentWorkload(def, "Deployment", w)).map((w) => workloadStateOf("Deployment", w)),
      ...input.daemonSets.filter((w) => inKubeSystem(w) && isComponentWorkload(def, "DaemonSet", w)).map((w) => workloadStateOf("DaemonSet", w)),
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    let state: ComponentState;
    if (chartState === "failed") state = "failed";
    else if (workloads.length > 0) state = workloads.every((w) => w.ready) ? "ready" : "notReady";
    else if (chartState === "installing" || chartState === "retrying") state = "installing";
    else if (addon || chart) state = "noWorkload";
    else state = "notFound";
    return { def, state, workloads, ...(addon ? { addon } : {}), ...(chart ? { chart } : {}), ...(chartState ? { chartState } : {}) };
  });
}

/**
 * Whether a row is worth listing: something of it exists, or it is one of k3s's own components (missing tells it was
 * left out with `--disable`); RKE2's charts depend on the options chosen (`--cni`, `--ingress-controller`), so only
 * those present are listed.
 */
export const shownComponent = (row: ComponentRow): boolean => row.state !== "notFound" || row.def.distribution === "k3s";

// ---------- ServiceLB ----------

export interface ServiceLb {
  /** The DaemonSet. */
  name: string;
  namespace: string;
  service: string;
  serviceNamespace: string;
  program: Distribution;
  desired: number;
  ready: number;
}

/** A ServiceLB DaemonSet (`svccontroller.<program>.cattle.io/svcname` and `/svcnamespace`), else `undefined`. */
export function serviceLbOf(ds: KubeObject): ServiceLb | undefined {
  const labels = labelsOf(ds);
  for (const program of DISTRIBUTIONS) {
    const service = text(labels[`svccontroller.${program}.cattle.io/svcname`]);
    if (!service) continue;
    return {
      name: ds.metadata?.name ?? "",
      namespace: ds.metadata?.namespace ?? "",
      service,
      serviceNamespace: text(labels[`svccontroller.${program}.cattle.io/svcnamespace`]) ?? ds.metadata?.namespace ?? "",
      program,
      desired: num(get(ds, "status", "desiredNumberScheduled")) ?? 0,
      ready: num(get(ds, "status", "numberReady")) ?? 0,
    };
  }
  return undefined;
}

/** A Service's load-balancer addresses (`status.loadBalancer.ingress`): IPs, else host names. */
export function loadBalancerAddresses(svc: KubeObject): string[] {
  return arr(get(svc, "status", "loadBalancer", "ingress")).flatMap((i) => {
    const v = str(get(i, "ip")) || str(get(i, "hostname"));
    return v ? [v] : [];
  });
}

// ---------- etcd snapshots ----------

export interface Snapshot {
  name: string;
  snapshotName?: string;
  node?: string;
  /** `location` without credentials, query or fragment. */
  location?: string;
  storage: "s3" | "local";
  bucket?: string;
  size?: string;
  createdAt?: string;
  readyToUse?: boolean;
  error?: string;
  errorAt?: string;
}

export function snapshotOf(obj: KubeObject): Snapshot {
  const location = str(get(obj, "spec", "location"));
  const s3 = get(obj, "spec", "s3");
  const out: Snapshot = {
    name: obj.metadata?.name ?? "",
    storage: s3 !== undefined || location?.startsWith("s3://") ? "s3" : "local",
  };
  const set = (field: "snapshotName" | "node" | "location" | "bucket" | "createdAt" | "error" | "errorAt", value: string | undefined) => {
    if (value) out[field] = value;
  };
  set("snapshotName", str(get(obj, "spec", "snapshotName")));
  set("node", str(get(obj, "spec", "nodeName")));
  set("location", cleanText(location));
  set("bucket", str(get(s3, "bucket")));
  set("createdAt", str(get(obj, "status", "creationTime")));
  set("error", cleanText(str(get(obj, "status", "error", "message"))));
  set("errorAt", str(get(obj, "status", "error", "time")));
  const size = get(obj, "status", "size");
  if (typeof size === "string" || typeof size === "number") out.size = String(size);
  const ready = get(obj, "status", "readyToUse");
  if (typeof ready === "boolean") out.readyToUse = ready;
  return out;
}

export type SnapshotState = "ready" | "failed" | "pending";
export const SNAPSHOT_TONE: Record<SnapshotState, Tone> = { ready: "success", failed: "danger", pending: "muted" };
export const snapshotStateOf = (s: Snapshot): SnapshotState => (s.error ? "failed" : s.readyToUse ? "ready" : "pending");
