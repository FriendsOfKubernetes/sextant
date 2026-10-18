// The cleanup rules (#147): pure functions over watched lists and namespace samples, no React. An object is a
// candidate only when every list that could name it is known in full (a ready watch, or a kind the cluster does not
// serve); when in doubt it is not a candidate. Candidates that a tool manages (Helm, Flux, Argo CD,
// `app.kubernetes.io/managed-by`) are returned apart, as "managed", and Released volumes kept on purpose (reclaim
// policy Retain) as "kept": both are shown and never offered for deletion.
//
//   ConfigMap / Secret   only when the user turned the rule on (Sextant cannot see every reference). Nothing names it:
//                        pods and pod templates (volumes incl. CSI and in-tree volume secrets, projected sources,
//                        envFrom, env, image pull secrets; also old ReplicaSets and Jobs), container arguments and
//                        environment values naming it (`ns/name`, or the name in its own namespace), ServiceAccounts,
//                        Ingress TLS and auth annotations, Gateway listeners and ReferenceGrants, StorageClass
//                        parameters and PersistentVolume secret references, cert-manager, Flux, KEDA, External
//                        Secrets, Prometheus operator, Velero, Istio and Traefik objects (`scan.ts`). Never:
//                        `kube-root-ca.crt` and similar, leader-election ConfigMaps, token / Helm release / Argo CD
//                        Secrets, anything with an owner.
//   PersistentVolumeClaim no Pod mounts it and no template, StatefulSet claim template, VolumeSnapshot or other claim's
//                        data source names it; its volume's reclaim policy is said.
//   PersistentVolume     Released or Available without a claim reference, for the configured days; a Released one
//                        with reclaim policy Retain is kept on purpose.
//   Service              no endpoints (EndpointSlices), no Pod or pod template its selector matches; without a
//                        selector: no manual Endpoints either. Never ExternalName or a headless Service without one.
//   ReplicaSet           an old revision with 0 replicas beyond its Deployment's `revisionHistoryLimit`.
//   Pod                  Succeeded or Failed for the configured days; not one of a Job's or of an unknown controller.
//   Job                  finished for the configured days, not a CronJob's, without `ttlSecondsAfterFinished`.
//   Namespace            in view and holding nothing — every served namespaced kind sampled (`cleanup_sample`) — but
//                        what Kubernetes creates in every namespace; never `default` or `kube-*`.
//
// ConfigMaps, Secrets, claims and Services of a namespace are judged only when its sample shows no object of a custom
// kind this page does not read (an operator's resource may name them or run pods for a Service), and only while every
// API group answers discovery (`cluster.unavailableGroups`: an aggregated API that is down hides its kinds — then no
// namespace is offered either). A ConfigMap or Secret also needs the cluster check to have looked for it and found no
// cluster-scoped object naming it, with every cluster-scoped kind read in full. An object being deleted or in an
// excluded namespace is never a candidate.
import type { KindRef, KindSample, KubeObject } from "../../api";
import { status } from "../../resources";
import { kindFromApiVersion } from "../../resources/refs";
import { GATEWAY, grantFrom, grantTo } from "../gateway-api/model";
import { deletionImpact, type ImpactLine } from "../resource-map/impact";
import {
  CONFIG_MAP,
  CRON_JOB,
  DAEMON_SET,
  DEPLOYMENT,
  ENDPOINT_SLICE,
  INGRESS,
  JOB,
  NAMESPACE,
  POD,
  PV,
  PVC,
  REPLICA_SET,
  same,
  SECRET,
  SERVICE,
  SERVICE_ACCOUNT,
  STATEFUL_SET,
  STORAGE_CLASS,
} from "../resource-map/kinds";
import { buildGraph, keyOf, podSpecReferences, type Graph, type GraphInput } from "../resource-map/relations";
import { mapSelector, matches, type Selector } from "../resource-map/selectors";
import {
  BUILT_IN_GROUPS,
  CLEANUP_NAMESPACE_KINDS,
  ENDPOINTS,
  HARMLESS_GROUPS,
  HARMLESS_KINDS,
  SCANNED_CLUSTER_KINDS,
  SCANNED_KINDS,
  TEMPLATE_KINDS,
  VOLUME_SNAPSHOT,
} from "./kinds";
import { managerOf, type Manager } from "./managed";
import { scanReferences } from "./scan";

const { arr, get, labelsOf, num, record, str } = status;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Namespaces never checked, whatever the settings say. */
export const SYSTEM_NAMESPACES: readonly string[] = ["kube-system", "kube-public", "kube-node-lease"];

/** Days per rule (`AppSettings.cleanup.minAgeDays`). */
export interface CleanupAges {
  configs: number;
  services: number;
  pods: number;
  jobs: number;
  claims: number;
  volumes: number;
  namespaces: number;
}

/** One watched list. */
export interface KindList {
  kind: KindRef;
  /** `null`: every namespace (or a cluster-scoped kind). */
  namespace: string | null;
  /**
   * `ready`: listed in full; `notServed`: the cluster does not serve the kind; `unknown`: loading or failed;
   * `skipped`: not watched, since no rule that is on needs it.
   */
  state: "ready" | "notServed" | "unknown" | "skipped";
  /** Namespaces the list could not read. */
  forbidden?: readonly string[];
  /** Read more than once: an array, not an iterator. */
  items: readonly KubeObject[];
}

/** What a namespace holds of every served namespaced kind (`cleanup_sample`); `undefined` while not known. */
export type NamespaceSample = { state: "ready"; kinds: readonly KindSample[] } | { state: "failed" };

/**
 * The cluster-wide check (`cleanup_cluster_check`): API group versions that do not answer discovery, and which
 * ConfigMaps and Secrets (`Kind/namespace/name`) objects of cluster-scoped kinds name, among those looked for
 * (`scanned`); `unread`: kinds not read in full. `undefined` while not known.
 */
export type ClusterState =
  | {
      state: "ready";
      unavailableGroups: readonly string[];
      referenced: ReadonlySet<string>;
      scanned: ReadonlySet<string>;
      unread: readonly string[];
    }
  | { state: "failed" }
  | undefined;

export interface CleanupInput {
  lists: readonly KindList[];
  /** The namespaces checked: in view and not excluded. */
  namespaces: readonly string[];
  /** Every excluded namespace (the system ones and the user's). */
  excluded: ReadonlySet<string>;
  ages: CleanupAges;
  /** The ConfigMap and Secret rules, off unless the user turned them on. */
  rules: { configMaps: boolean; secrets: boolean };
  /** Per checked namespace; a namespace without a ready sample offers no ConfigMap, Secret, claim, Service or itself. */
  samples: ReadonlyMap<string, NamespaceSample>;
  /** Without a ready check without unavailable groups, no ConfigMap, Secret, claim, Service or namespace is offered. */
  cluster: ClusterState;
  now: number;
}

export type RuleId = "configMap" | "secret" | "claim" | "volume" | "service" | "replicaSet" | "pod" | "job" | "namespace";

export type ReasonId =
  | "configMapUnused"
  | "secretUnused"
  | "claimUnmounted"
  | "volumeReleased"
  | "volumeAvailable"
  | "serviceNoEndpoints"
  | "serviceNoSelector"
  | "replicaSetHistory"
  | "podSucceeded"
  | "podFailed"
  | "jobComplete"
  | "jobFailed"
  | "namespaceEmpty";

/** Why it looks unused: an i18n key (`hygiene:reason.<id>`) and the values it names. */
export interface Reason {
  id: ReasonId;
  values?: Record<string, string | number>;
}

/** What the age counts from. */
export type SinceKind = "created" | "finished" | "phaseChanged";

/** A remark on a candidate (`hygiene:note.<id>`): what its deletion does to the data. */
export interface Note {
  id: "reclaimDelete" | "reclaimRetain" | "reclaimOther";
  values?: Record<string, string>;
}

export interface Candidate {
  /** The resource map's key (`group/kind/namespace/name`). */
  key: string;
  rule: RuleId;
  kind: KindRef;
  namespace: string | null;
  name: string;
  uid: string;
  resourceVersion: string;
  reason: Reason;
  /** The moment its age counts from, in ms, and what that moment is. */
  since: number;
  sinceKind: SinceKind;
  notes: Note[];
  /** What still names it or would go with it, from the resource map (existing objects only). */
  impact: ImpactLine[];
  /** Set for an object a tool manages: shown, never offered. */
  managedBy?: Manager;
  /** Set for an object kept on purpose: shown, never offered. */
  keptBecause?: "retain";
}

/** A rule that could not judge a namespace (`null`: cluster-wide) because these kinds are not known in full. */
export interface Unchecked {
  rule: RuleId;
  namespace: string | null;
  kinds: string[];
}

export interface CleanupResult {
  /** Offered for deletion. */
  candidates: Candidate[];
  /** Would be candidates, but a tool manages them. */
  managed: Candidate[];
  /** Kept on purpose (a Released volume with reclaim policy Retain). */
  kept: Candidate[];
  unchecked: Unchecked[];
  /** Namespaces whose ConfigMaps, Secrets, claims and Services are not judged: custom kinds the page does not read. */
  blocked: { namespace: string; kinds: string[] }[];
  /** API group versions that do not answer: their kinds are invisible, so nothing that depends on them is offered. */
  unavailableGroups: string[];
  /** Cluster-scoped kinds not read in full: no ConfigMap or Secret is offered. */
  clusterUnread: string[];
}

/** `namespace/name`, or the name of a cluster-scoped object. */
export function objectName(c: Pick<Candidate, "namespace" | "name">): string {
  return c.namespace ? `${c.namespace}/${c.name}` : c.name;
}

// ---------- Lists ----------

const kindId = (k: Pick<KindRef, "group" | "kind">) => `${k.group}/${k.kind}`;

class Lists {
  private readonly byKind = new Map<string, KindList[]>();

  constructor(readonly lists: readonly KindList[]) {
    for (const list of lists) {
      const id = kindId(list.kind);
      (this.byKind.get(id) ?? this.byKind.set(id, []).get(id)!).push(list);
    }
  }

  /** Every object listed of `kind` (in `namespace`, when given). */
  items(kind: Pick<KindRef, "group" | "kind">, namespace?: string | null): KubeObject[] {
    const out: KubeObject[] = [];
    for (const list of this.byKind.get(kindId(kind)) ?? []) {
      for (const obj of list.items) {
        if (namespace === undefined || namespace === null || (obj.metadata?.namespace ?? null) === namespace) out.push(obj);
      }
    }
    return out;
  }

  /** Whether every object of `kind` in `namespace` (`null`: cluster-wide) is known. */
  complete(kind: Pick<KindRef, "group" | "kind">, namespace: string | null): boolean {
    return (this.byKind.get(kindId(kind)) ?? []).some(
      (list) =>
        list.state === "notServed" ||
        (list.state === "ready" &&
          (list.namespace === null || list.namespace === namespace) &&
          !(namespace !== null && list.forbidden?.includes(namespace))),
    );
  }

  /** Whether the kind is not watched at all (no rule that is on needs it). */
  skipped(kind: Pick<KindRef, "group" | "kind">): boolean {
    const found = this.byKind.get(kindId(kind)) ?? [];
    return found.length > 0 && found.every((list) => list.state === "skipped");
  }

  /** The kinds of `kinds` not known in full in `namespace`. */
  missing(kinds: readonly Pick<KindRef, "group" | "kind">[], namespace: string | null): string[] {
    return kinds.filter((k) => !this.complete(k, namespace)).map((k) => k.kind);
  }
}

// ---------- References the resource map does not draw ----------

/** Keys of objects something names, beyond the graph's edges. */
interface ExtraReferences {
  keys: Set<string>;
  /** `Kind/name` named without a namespace (cluster-scoped referrers): counts in every namespace. */
  anyNamespace: Set<string>;
  /** Namespaces in which every Secret may be named (a StorageClass with a templated secret name). */
  allSecretsIn: Set<string>;
  /** Container argument and environment tokens: `ns/name` anywhere, and bare names per namespace. */
  qualified: Set<string>;
  bare: Map<string, Set<string>>;
}

const ref = (kind: KindRef, namespace: string | null, name: string) => keyOf({ group: kind.group, kind: kind.kind, namespace, name });

const SCANNED_KIND: Record<string, KindRef> = { Secret: SECRET, ConfigMap: CONFIG_MAP, ServiceAccount: SERVICE_ACCOUNT };

/** Ingress annotations that name a Secret (`name` or `namespace/name`): ingress-nginx's auth and TLS options. */
const INGRESS_SECRET_ANNOTATION = /(^|\/)(auth-secret|auth-tls-secret|proxy-ssl-secret)$/;

/** The pod spec of a Pod or of a workload's template. */
function podSpecOf(kind: KindRef, obj: KubeObject): unknown {
  if (same(kind, POD)) return get(obj, "spec");
  if (same(kind, CRON_JOB)) return get(obj, "spec", "jobTemplate", "spec", "template", "spec");
  return get(obj, "spec", "template", "spec");
}

/** Argument and environment strings of every container of a pod spec. */
function containerStrings(spec: unknown): string[] {
  const out: string[] = [];
  for (const list of ["initContainers", "containers", "ephemeralContainers"]) {
    for (const c of arr(get(spec, list))) {
      for (const field of ["args", "command"]) for (const a of arr(get(c, field))) if (typeof a === "string") out.push(a);
      for (const e of arr(get(c, "env"))) {
        const value = str(get(e, "value"));
        if (value) out.push(value);
      }
    }
  }
  return out;
}

const TOKEN_SPLIT = /[\s=,;:"'()[\]{}]+/;

/** StorageClass parameters that name a Secret (`…secret-name` / `…SecretName`) and its namespace parameter. */
function storageClassSecrets(sc: KubeObject): { name: string; namespace: string | null }[] {
  const params = record(get(sc, "parameters")) as Record<string, unknown>;
  const out: { name: string; namespace: string | null }[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string" || !/secret-?name$/i.test(key)) continue;
    const nsKey = key.replace(/name$/i, (m) => (m === "Name" ? "Namespace" : "namespace"));
    const ns = params[nsKey];
    out.push({ name: value, namespace: typeof ns === "string" ? ns : null });
  }
  return out;
}

const templated = (text: string) => text.includes("${");

function extraReferences(lists: Lists): ExtraReferences {
  const keys = new Set<string>();
  const anyNamespace = new Set<string>();
  const allSecretsIn = new Set<string>();
  const qualified = new Set<string>();
  const bare = new Map<string, Set<string>>();
  // Old ReplicaSets (a rollback brings them back) and a CronJob's Jobs repeat a template the graph reads only from
  // the owner; what they name stays in use while they exist.
  for (const kind of [REPLICA_SET, JOB]) {
    for (const obj of lists.items(kind)) {
      for (const r of podSpecReferences(get(obj, "spec", "template", "spec"), obj.metadata?.namespace ?? null, true)) keys.add(keyOf(r.to));
    }
  }
  // Controller arguments and environment values: `--default-ssl-certificate=ns/name`, `--configmap=$(NS)/name`.
  for (const kind of TEMPLATE_KINDS) {
    for (const obj of lists.items(kind)) {
      const ns = obj.metadata?.namespace ?? "";
      const own = bare.get(ns) ?? bare.set(ns, new Set()).get(ns)!;
      for (const text of containerStrings(podSpecOf(kind, obj))) {
        for (const token of text.split(TOKEN_SPLIT)) {
          if (!token) continue;
          own.add(token);
          const slash = token.lastIndexOf("/");
          if (slash >= 0) {
            own.add(token.slice(slash + 1));
            qualified.add(token.split("/").slice(-2).join("/"));
          }
        }
      }
    }
  }
  for (const sa of lists.items(SERVICE_ACCOUNT)) {
    const ns = sa.metadata?.namespace ?? null;
    for (const s of arr(get(sa, "secrets"))) {
      const name = str(get(s, "name"));
      if (name) keys.add(ref(SECRET, ns, name));
    }
  }
  for (const ingress of lists.items(INGRESS)) {
    const ns = ingress.metadata?.namespace ?? null;
    for (const [key, value] of Object.entries(record(ingress.metadata?.annotations))) {
      if (!INGRESS_SECRET_ANNOTATION.test(key) || typeof value !== "string" || !value) continue;
      const [first, second] = value.split("/", 2);
      keys.add(second ? ref(SECRET, first!, second) : ref(SECRET, ns, value));
    }
  }
  for (const kind of [...SCANNED_KINDS, ...SCANNED_CLUSTER_KINDS, PV]) {
    for (const obj of lists.items(kind)) {
      for (const r of scanReferences(obj)) {
        const target = SCANNED_KIND[r.kind]!;
        if (r.namespace === null) anyNamespace.add(`${r.kind}/${r.name}`);
        else keys.add(ref(target, r.namespace, r.name));
      }
    }
  }
  // StorageClass secrets: a fixed name and namespace is one Secret; a templated one (`${pvc.namespace}`,
  // `${pvc.name}`) may be any Secret of the namespaces whose claims use the class.
  const claims = lists.items(PVC);
  const volumes = lists.items(PV);
  for (const sc of lists.items(STORAGE_CLASS)) {
    const className = sc.metadata?.name ?? "";
    const usedIn = () => [
      ...claims.filter((c) => str(get(c, "spec", "storageClassName")) === className).map((c) => c.metadata?.namespace ?? ""),
      ...volumes.filter((v) => str(get(v, "spec", "storageClassName")) === className).map((v) => str(get(v, "spec", "claimRef", "namespace")) ?? ""),
    ];
    for (const secret of storageClassSecrets(sc)) {
      const namespaces = secret.namespace === null || templated(secret.namespace) ? null : [secret.namespace];
      if (templated(secret.name)) {
        for (const ns of namespaces ?? usedIn()) if (ns) allSecretsIn.add(ns);
      } else if (namespaces) keys.add(ref(SECRET, namespaces[0]!, secret.name));
      else if (secret.namespace === null) anyNamespace.add(`Secret/${secret.name}`);
      else for (const ns of usedIn()) if (ns) keys.add(ref(SECRET, ns, secret.name));
    }
  }
  for (const snapshot of lists.items(VOLUME_SNAPSHOT)) {
    const claim = str(get(snapshot, "spec", "source", "persistentVolumeClaimName"));
    if (claim) keys.add(ref(PVC, snapshot.metadata?.namespace ?? null, claim));
  }
  for (const claim of claims) {
    for (const field of ["dataSource", "dataSourceRef"]) {
      const source = get(claim, "spec", field);
      const name = str(get(source, "name"));
      if (name && str(get(source, "kind")) === "PersistentVolumeClaim" && !str(get(source, "apiGroup"))) {
        keys.add(ref(PVC, str(get(source, "namespace")) ?? claim.metadata?.namespace ?? null, name));
      }
    }
  }
  return { keys, anyNamespace, allSecretsIn, qualified, bare };
}

// ---------- Helpers ----------

function time(value: unknown): number | undefined {
  const text = str(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const createdAt = (obj: KubeObject) => time(obj.metadata?.creationTimestamp);
const hasOwners = (obj: KubeObject) => arr(obj.metadata?.ownerReferences).length > 0;
const beingDeleted = (obj: KubeObject) => Boolean(obj.metadata?.deletionTimestamp);
const annotation = (obj: KubeObject, key: string) => str(record(obj.metadata?.annotations)[key]);

function controller(obj: KubeObject): { kind: KindRef; name: string; uid?: string } | undefined {
  const owners = arr(obj.metadata?.ownerReferences);
  const owner = owners.find((o) => get(o, "controller") === true) ?? owners[0];
  const apiVersion = str(get(owner, "apiVersion"));
  const kind = str(get(owner, "kind"));
  const name = str(get(owner, "name"));
  if (!apiVersion || !kind || !name) return undefined;
  return { kind: kindFromApiVersion(apiVersion, kind), name, uid: str(get(owner, "uid")) };
}

function condition(obj: KubeObject, type: string): unknown {
  return arr(get(obj, "status", "conditions")).find((c) => get(c, "type") === type && get(c, "status") === "True");
}

/** ConfigMaps Kubernetes (or a mesh) puts into every namespace. */
const DISTRIBUTED_CONFIG_MAPS = new Set(["kube-root-ca.crt", "openshift-service-ca.crt", "istio-ca-root-cert"]);
const LEADER_ANNOTATION = "control-plane.alpha.kubernetes.io/leader";
/** Secret types something reads by type rather than by a reference. */
const KEPT_SECRET_TYPES = new Set(["kubernetes.io/service-account-token", "bootstrap.kubernetes.io/token", "helm.sh/release.v1"]);
const SA_NAME_ANNOTATION = "kubernetes.io/service-account.name";
const ARGO_SECRET_TYPE = "argocd.argoproj.io/secret-type";

function keptConfigMap(cm: KubeObject): boolean {
  return DISTRIBUTED_CONFIG_MAPS.has(cm.metadata?.name ?? "") || annotation(cm, LEADER_ANNOTATION) !== undefined || hasOwners(cm);
}

function keptSecret(secret: KubeObject): boolean {
  const type = str(get(secret, "type")) ?? "";
  const labels = labelsOf(secret);
  return (
    KEPT_SECRET_TYPES.has(type) ||
    annotation(secret, SA_NAME_ANNOTATION) !== undefined ||
    labels[ARGO_SECRET_TYPE] !== undefined ||
    (labels.owner === "helm" && (secret.metadata?.name ?? "").startsWith("sh.helm.release.")) ||
    hasOwners(secret)
  );
}

/** The labels of a workload's pod template; `undefined` for other kinds. */
function templateLabels(kind: KindRef, obj: KubeObject): Record<string, string> | undefined {
  if (same(kind, CRON_JOB)) return record(get(obj, "spec", "jobTemplate", "spec", "template", "metadata", "labels")) as Record<string, string>;
  if ([DEPLOYMENT, STATEFUL_SET, DAEMON_SET, REPLICA_SET, JOB].some((k) => same(k, kind)))
    return record(get(obj, "spec", "template", "metadata", "labels")) as Record<string, string>;
  return undefined;
}

/** When a finished pod stopped: its last container's end, or its start, or its creation. */
function podFinishedAt(pod: KubeObject): number | undefined {
  const ends = ["initContainerStatuses", "containerStatuses"]
    .flatMap((list) => arr(get(pod, "status", list)))
    .map((s) => time(get(s, "state", "terminated", "finishedAt")))
    .filter((t): t is number => t !== undefined);
  if (ends.length > 0) return Math.max(...ends);
  return time(get(pod, "status", "startTime")) ?? createdAt(pod);
}

/** Owner kinds whose finished pods nobody else removes (an evicted pod of a ReplicaSet stays Failed). */
const POD_OWNERS_WITHOUT_CLEANUP: readonly KindRef[] = [REPLICA_SET, STATEFUL_SET, DAEMON_SET];

/** Custom kinds whose objects the page reads (or which name nothing): they do not block a namespace. */
function readByThePage(kind: Pick<KindRef, "group" | "kind">): boolean {
  return (
    BUILT_IN_GROUPS.has(kind.group) ||
    HARMLESS_GROUPS.has(kind.group) ||
    HARMLESS_KINDS.some((k) => same(k, kind)) ||
    CLEANUP_NAMESPACE_KINDS.some((k) => same(k, kind))
  );
}

/** What Kubernetes puts into every namespace: the root CA ConfigMap, the `default` ServiceAccount and its token. */
function sampledByKubernetes(sample: KindSample, name: string, serviceAccount: string | null): boolean {
  if (same(sample.kind, CONFIG_MAP)) return DISTRIBUTED_CONFIG_MAPS.has(name);
  if (same(sample.kind, SERVICE_ACCOUNT)) return name === "default";
  if (same(sample.kind, SECRET)) return serviceAccount === "default";
  return false;
}

// ---------- The rules ----------

/** What each rule needs known in the candidate's namespace. */
const NEEDS: Record<Exclude<RuleId, "volume" | "namespace">, readonly KindRef[]> = {
  configMap: [CONFIG_MAP, ...TEMPLATE_KINDS, ...SCANNED_KINDS],
  secret: [SECRET, ...TEMPLATE_KINDS, SERVICE_ACCOUNT, INGRESS, GATEWAY, PVC, ...SCANNED_KINDS],
  claim: [PVC, ...TEMPLATE_KINDS, VOLUME_SNAPSHOT],
  service: [SERVICE, ENDPOINT_SLICE, ENDPOINTS, ...TEMPLATE_KINDS],
  replicaSet: [REPLICA_SET, DEPLOYMENT],
  pod: [POD],
  job: [JOB],
};

/** Cluster-wide lists a rule needs too. */
const NEEDS_CLUSTER: Partial<Record<RuleId, readonly KindRef[]>> = {
  configMap: SCANNED_CLUSTER_KINDS,
  secret: [...SCANNED_CLUSTER_KINDS, PV, STORAGE_CLASS],
  claim: [PV],
  volume: [PV],
  namespace: [NAMESPACE],
};

const REFERENCE_GRANT_KIND = { group: "gateway.networking.k8s.io", kind: "ReferenceGrant" };

export function findCleanup(input: CleanupInput): CleanupResult {
  const lists = new Lists(input.lists);
  const graphInputs: GraphInput[] = input.lists.map((l) => ({ kind: l.kind, items: l.items }));
  const graph: Graph = buildGraph(graphInputs);
  const checked = input.namespaces.filter((ns) => !input.excluded.has(ns));
  const extra = extraReferences(lists);
  const out: Candidate[] = [];
  const unchecked: Unchecked[] = [];
  const blocked: CleanupResult["blocked"] = [];

  const clusterOk = (rule: RuleId): boolean => {
    const missing = lists.missing(NEEDS_CLUSTER[rule] ?? [], null);
    if (missing.length > 0) unchecked.push({ rule, namespace: null, kinds: missing });
    return missing.length === 0;
  };
  const namespaceOk = (rule: Exclude<RuleId, "volume" | "namespace">, ns: string): boolean => {
    const missing = lists.missing(NEEDS[rule], ns);
    if (missing.length > 0) unchecked.push({ rule, namespace: ns, kinds: missing });
    return missing.length === 0;
  };
  const cluster = input.cluster?.state === "ready" ? input.cluster : undefined;
  /** Every API group answers: no kind is invisible to the samples. */
  const groupsOk = cluster !== undefined && cluster.unavailableGroups.length === 0;
  /** The namespace's sample is in and shows no object of a custom kind the page does not read. */
  const unblocked = (ns: string): boolean => {
    if (!groupsOk) return false;
    const sample = input.samples.get(ns);
    if (sample?.state !== "ready") return false;
    const kinds = sample.kinds
      .filter((k) => !readByThePage(k.kind) && (k.error !== null || k.objects.length > 0))
      .map((k) => k.kind.kind);
    if (kinds.length > 0) blocked.push({ namespace: ns, kinds: [...new Set(kinds)].sort() });
    return kinds.length === 0;
  };

  const add = (
    rule: RuleId,
    kind: KindRef,
    obj: KubeObject,
    reason: Reason,
    since: number | undefined,
    days: number,
    extras: { sinceKind?: SinceKind; notes?: Note[]; keptBecause?: "retain" } = {},
  ) => {
    const uid = obj.metadata?.uid;
    const name = obj.metadata?.name;
    if (!uid || !name || since === undefined || beingDeleted(obj)) return;
    if (input.now - since < days * DAY_MS) return;
    const namespace = obj.metadata?.namespace ?? null;
    const key = keyOf({ group: kind.group, kind: kind.kind, namespace, name });
    const impact = deletionImpact(graph, key)
      .map((line) => {
        const keys = line.keys.filter((k) => graph.nodes.get(k)?.obj !== undefined);
        return { ...line, keys, count: keys.length };
      })
      .filter((line) => line.count > 0);
    out.push({
      key,
      rule,
      kind,
      namespace,
      name,
      uid,
      resourceVersion: str(obj.metadata?.resourceVersion) ?? "",
      reason,
      since,
      sinceKind: extras.sinceKind ?? "created",
      notes: extras.notes ?? [],
      impact,
      managedBy: managerOf(obj),
      ...(extras.keptBecause ? { keptBecause: extras.keptBecause } : {}),
    });
  };

  /** Something names the object: an edge of the graph (any relation, optional ones too) or an extra reference. */
  const named = (kind: KindRef, obj: KubeObject): boolean => {
    const ns = obj.metadata?.namespace ?? null;
    const name = obj.metadata?.name ?? "";
    const key = keyOf({ group: kind.group, kind: kind.kind, namespace: ns, name });
    return (
      (graph.in.get(key)?.length ?? 0) > 0 ||
      extra.keys.has(key) ||
      extra.anyNamespace.has(`${kind.kind}/${name}`) ||
      extra.qualified.has(`${ns}/${name}`) ||
      (extra.bare.get(ns ?? "")?.has(name) ?? false)
    );
  };

  /** Looked for by the cluster check, every cluster-scoped kind read, and named by none of their objects. */
  const clusterClear = (kind: "ConfigMap" | "Secret", obj: KubeObject): boolean => {
    if (!cluster || cluster.unread.length > 0) return false;
    const key = `${kind}/${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`;
    return cluster.scanned.has(key) && !cluster.referenced.has(key);
  };

  const pvByName = new Map(lists.items(PV).map((pv) => [pv.metadata?.name ?? "", pv]));
  const configMapsOk = input.rules.configMaps && clusterOk("configMap");
  const secretsOk = input.rules.secrets && clusterOk("secret");
  const claimsOk = clusterOk("claim");
  for (const ns of checked) {
    const free = unblocked(ns);
    // ConfigMaps
    if (configMapsOk && free && namespaceOk("configMap", ns)) {
      for (const cm of lists.items(CONFIG_MAP, ns)) {
        if (keptConfigMap(cm) || named(CONFIG_MAP, cm) || !clusterClear("ConfigMap", cm)) continue;
        add("configMap", CONFIG_MAP, cm, { id: "configMapUnused" }, createdAt(cm), input.ages.configs);
      }
    }
    // Secrets
    if (secretsOk && free && !extra.allSecretsIn.has(ns) && namespaceOk("secret", ns)) {
      const grants = lists.complete(REFERENCE_GRANT_KIND, ns)
        ? lists.items(REFERENCE_GRANT_KIND, ns).filter((g) => grantFrom(g).some((f) => f.group === GATEWAY.group && f.kind === GATEWAY.kind))
        : undefined;
      if (grants === undefined) unchecked.push({ rule: "secret", namespace: ns, kinds: [REFERENCE_GRANT_KIND.kind] });
      else {
        const granted = (name: string) =>
          grants.some((g) => grantTo(g).some((to) => to.group === "" && to.kind === "Secret" && (to.name === undefined || to.name === name)));
        for (const secret of lists.items(SECRET, ns)) {
          if (keptSecret(secret) || named(SECRET, secret) || granted(secret.metadata?.name ?? "") || !clusterClear("Secret", secret)) continue;
          add("secret", SECRET, secret, { id: "secretUnused" }, createdAt(secret), input.ages.configs);
        }
      }
    }
    // PersistentVolumeClaims
    if (claimsOk && free && namespaceOk("claim", ns)) {
      const statefulSets = lists.items(STATEFUL_SET, ns);
      const keptForStatefulSet = (name: string) =>
        statefulSets.some((sts) =>
          arr(get(sts, "spec", "volumeClaimTemplates")).some((tpl) => {
            const prefix = `${str(get(tpl, "metadata", "name")) ?? ""}-${sts.metadata?.name ?? ""}-`;
            return name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length));
          }),
        );
      for (const claim of lists.items(PVC, ns)) {
        const name = claim.metadata?.name ?? "";
        if (hasOwners(claim) || named(PVC, claim) || keptForStatefulSet(name)) continue;
        const volume = str(get(claim, "spec", "volumeName"));
        const policy = volume ? str(get(pvByName.get(volume), "spec", "persistentVolumeReclaimPolicy")) : undefined;
        const notes: Note[] =
          volume && policy
            ? [{ id: policy === "Delete" ? "reclaimDelete" : policy === "Retain" ? "reclaimRetain" : "reclaimOther", values: { volume, policy } }]
            : [];
        add("claim", PVC, claim, { id: "claimUnmounted" }, createdAt(claim), input.ages.claims, { notes });
      }
    }
    // Services: an unknown custom kind may run pods for it (an Argo Rollout, a KubeVirt VM, an OpenKruise CloneSet).
    if (free && namespaceOk("service", ns)) {
      const slices = lists.items(ENDPOINT_SLICE, ns);
      const manual = new Set(lists.items(ENDPOINTS, ns).map((e) => e.metadata?.name ?? ""));
      const pods = lists.items(POD, ns);
      const templates = TEMPLATE_KINDS.filter((k) => !same(k, POD)).flatMap((kind) =>
        lists.items(kind, ns).map((obj) => templateLabels(kind, obj) ?? {}),
      );
      for (const svc of lists.items(SERVICE, ns)) {
        const name = svc.metadata?.name ?? "";
        const type = str(get(svc, "spec", "type"));
        if (type === "ExternalName" || hasOwners(svc) || (ns === "default" && name === "kubernetes")) continue;
        const hasEndpoints = slices.some(
          (s) => labelsOf(s)["kubernetes.io/service-name"] === name && arr(get(s, "endpoints")).length > 0,
        );
        if (hasEndpoints) continue;
        const selector: Selector = mapSelector(get(svc, "spec", "selector"));
        if (selector.type === "nothing") {
          const headless = str(get(svc, "spec", "clusterIP")) === "None";
          if (headless || manual.has(name)) continue;
          add("service", SERVICE, svc, { id: "serviceNoSelector" }, createdAt(svc), input.ages.services);
          continue;
        }
        if (pods.some((p) => matches(selector, labelsOf(p))) || templates.some((labels) => matches(selector, labels))) continue;
        add("service", SERVICE, svc, { id: "serviceNoEndpoints" }, createdAt(svc), input.ages.services);
      }
    }
    // ReplicaSets beyond the history limit
    if (namespaceOk("replicaSet", ns)) {
      const replicaSets = lists.items(REPLICA_SET, ns);
      for (const deployment of lists.items(DEPLOYMENT, ns)) {
        const uid = deployment.metadata?.uid;
        if (!uid) continue;
        const revision = (rs: KubeObject) => Number(annotation(rs, "deployment.kubernetes.io/revision") ?? "NaN");
        const owned = replicaSets
          .filter((rs) => {
            const owner = controller(rs);
            return owner !== undefined && same(owner.kind, DEPLOYMENT) && owner.uid === uid;
          })
          .filter((rs) => Number.isFinite(revision(rs)))
          .sort((a, b) => revision(b) - revision(a));
        // The newest revision is the current one, whatever its size; history is the rest.
        const old = owned.slice(1).filter((rs) => (num(get(rs, "spec", "replicas")) ?? 1) === 0 && (num(get(rs, "status", "replicas")) ?? 0) === 0);
        const limit = num(get(deployment, "spec", "revisionHistoryLimit")) ?? 10;
        for (const rs of old.slice(Math.max(0, limit))) {
          add(
            "replicaSet",
            REPLICA_SET,
            rs,
            { id: "replicaSetHistory", values: { revision: revision(rs), deployment: deployment.metadata?.name ?? "", limit } },
            createdAt(rs),
            0,
          );
        }
      }
    }
    // Finished pods
    if (namespaceOk("pod", ns)) {
      for (const pod of lists.items(POD, ns)) {
        const phase = str(get(pod, "status", "phase"));
        if (phase !== "Succeeded" && phase !== "Failed") continue;
        if (annotation(pod, "kubernetes.io/config.mirror") !== undefined) continue;
        const owner = controller(pod);
        if (owner && !POD_OWNERS_WITHOUT_CLEANUP.some((k) => same(k, owner.kind))) continue;
        add("pod", POD, pod, { id: phase === "Succeeded" ? "podSucceeded" : "podFailed" }, podFinishedAt(pod), input.ages.pods, {
          sinceKind: "finished",
        });
      }
    }
    // Finished jobs
    if (namespaceOk("job", ns)) {
      for (const job of lists.items(JOB, ns)) {
        if (hasOwners(job) || get(job, "spec", "ttlSecondsAfterFinished") !== undefined) continue;
        const complete = condition(job, "Complete");
        const failed = condition(job, "Failed");
        if (!complete && !failed) continue;
        const finished = time(get(job, "status", "completionTime")) ?? time(get(complete ?? failed, "lastTransitionTime")) ?? createdAt(job);
        add("job", JOB, job, { id: complete ? "jobComplete" : "jobFailed" }, finished, input.ages.jobs, { sinceKind: "finished" });
      }
    }
  }

  // PersistentVolumes (cluster-wide)
  if (clusterOk("volume")) {
    for (const pv of lists.items(PV)) {
      const phase = str(get(pv, "status", "phase"));
      const claim = get(pv, "spec", "claimRef");
      const claimNs = str(get(claim, "namespace"));
      if (claimNs && input.excluded.has(claimNs)) continue;
      const transition = time(get(pv, "status", "lastPhaseTransitionTime"));
      const since = transition ?? createdAt(pv);
      const sinceKind: SinceKind = transition !== undefined ? "phaseChanged" : "created";
      if (phase === "Released") {
        const claimName = str(get(claim, "name")) ?? "";
        const retained = str(get(pv, "spec", "persistentVolumeReclaimPolicy")) === "Retain";
        add("volume", PV, pv, { id: "volumeReleased", values: { claim: claimNs ? `${claimNs}/${claimName}` : claimName } }, since, input.ages.volumes, {
          sinceKind,
          ...(retained ? { keptBecause: "retain" as const } : {}),
        });
      } else if (phase === "Available" && claim === undefined) {
        add("volume", PV, pv, { id: "volumeAvailable" }, since, input.ages.volumes, { sinceKind });
      }
    }
  }

  // Empty namespaces (only those in view): the watched lists hold nothing, and neither does any served kind sampled.
  if (clusterOk("namespace")) {
    const namespaces = new Map(lists.items(NAMESPACE).map((n) => [n.metadata?.name ?? "", n]));
    for (const ns of checked) {
      const obj = namespaces.get(ns);
      if (!groupsOk) continue;
      if (!obj || ns === "default" || ns.startsWith("kube-") || str(get(obj, "status", "phase")) === "Terminating") continue;
      // A kind not watched is still covered by the sample.
      const missing = lists.missing(CLEANUP_NAMESPACE_KINDS.filter((k) => !lists.skipped(k)), ns);
      if (missing.length > 0) {
        unchecked.push({ rule: "namespace", namespace: ns, kinds: missing });
        continue;
      }
      const sample = input.samples.get(ns);
      if (sample?.state !== "ready") continue;
      const sampledSomething = sample.kinds.some(
        (k) => k.error !== null || k.more || k.objects.some((o) => !sampledByKubernetes(k, o.name, o.serviceAccount)),
      );
      const holds = CLEANUP_NAMESPACE_KINDS.some((kind) => lists.items(kind, ns).some((o) => !createdByKubernetes(kind, o)));
      if (holds || sampledSomething) continue;
      add("namespace", NAMESPACE, obj, { id: "namespaceEmpty" }, createdAt(obj), input.ages.namespaces);
    }
  }

  const sorted = out.sort(
    (a, b) =>
      a.rule.localeCompare(b.rule) ||
      (a.namespace ?? "").localeCompare(b.namespace ?? "") ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  return {
    candidates: sorted.filter((c) => !c.managedBy && !c.keptBecause),
    managed: sorted.filter((c) => c.managedBy),
    kept: sorted.filter((c) => !c.managedBy && c.keptBecause),
    unchecked,
    blocked,
    unavailableGroups: cluster ? [...cluster.unavailableGroups] : [],
    clusterUnread: cluster && (input.rules.configMaps || input.rules.secrets) ? [...cluster.unread] : [],
  };
}

/** What Kubernetes puts into every namespace (as watched objects). */
function createdByKubernetes(kind: KindRef, obj: KubeObject): boolean {
  const name = obj.metadata?.name ?? "";
  if (same(kind, CONFIG_MAP)) return DISTRIBUTED_CONFIG_MAPS.has(name);
  if (same(kind, SERVICE_ACCOUNT)) return name === "default";
  if (same(kind, SECRET))
    return str(get(obj, "type")) === "kubernetes.io/service-account-token" && annotation(obj, SA_NAME_ANNOTATION) === "default";
  return false;
}
