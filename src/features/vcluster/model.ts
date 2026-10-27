// What the vcluster views read from the host cluster's objects, as the vcluster chart and syncer write them
// (github.com/loft-sh/vcluster): the control plane is a StatefulSet or Deployment labelled `app=vcluster` with
// `release=<name>` (`chart/templates/statefulset.yaml`; the CLI lists instances by that label, `pkg/cli/find/find.go`
// `findInContext`), its pods carry the same labels, its Service is `<name>` (port 443 → 8443,
// `chart/templates/service.yaml`) and its kubeconfig Secret `vc-<name>` (`pkg/util/kubeconfig/kubeconfig.go`). A
// paused vcluster has the annotation `loft.sh/paused: "true"` or the label `loft.sh/sleep-mode: "true"`
// (`find.go` `getVCluster`), a scaled-down one zero replicas (`isScaledDown`); the version is the tag of the
// `syncer` container's image. Objects the syncer copies from the virtual cluster carry `vcluster.loft.sh/managed-by`
// and the virtual name, namespace and kind in annotations (`pkg/util/translate/types.go`). Pure functions, no React.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, record, str } = status;

export const STATEFUL_SET: KindRef = { group: "apps", version: "v1", kind: "StatefulSet" };
export const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
export const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
export const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
export const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };

export const APP_LABEL = "app";
export const APP_VALUE = "vcluster";
export const RELEASE_LABEL = "release";
/** The API server's own selector for control planes, their pods and Services. */
export const CONTROL_PLANE_SELECTOR = `${APP_LABEL}=${APP_VALUE}`;
export const SECRET_PREFIX = "vc-";
export const PAUSED_ANNOTATION = "loft.sh/paused";
export const SLEEP_MODE_LABEL = "loft.sh/sleep-mode";
export const SYNCER_CONTAINER = "syncer";

/** On every object the syncer copies to the host (`MarkerLabel`): value = the vcluster's name. */
export const MANAGED_BY_LABEL = "vcluster.loft.sh/managed-by";
/** The virtual namespace of a synced object (`NamespaceLabel`). */
export const NAMESPACE_LABEL = "vcluster.loft.sh/namespace";
export const OBJECT_NAME_ANNOTATION = "vcluster.loft.sh/object-name";
export const OBJECT_NAMESPACE_ANNOTATION = "vcluster.loft.sh/object-namespace";
export const OBJECT_KIND_ANNOTATION = "vcluster.loft.sh/object-kind";

const labelsOf = (obj: KubeObject | undefined): Record<string, string> =>
  record(get(obj, "metadata", "labels")) as Record<string, string>;
const annotationsOf = (obj: KubeObject | undefined): Record<string, string> =>
  record(get(obj, "metadata", "annotations")) as Record<string, string>;

/** Whether the syncer copied this object from a virtual cluster (then it is never a control plane). */
export const isSynced = (obj: KubeObject): boolean => str(labelsOf(obj)[MANAGED_BY_LABEL]) !== undefined;

/** The vcluster's name when `obj` is a control plane StatefulSet or Deployment; `undefined` otherwise. */
export function releaseOf(obj: KubeObject | null | undefined): string | undefined {
  if (!obj || (obj.kind !== "StatefulSet" && obj.kind !== "Deployment")) return undefined;
  const labels = labelsOf(obj);
  if (labels[APP_LABEL] !== APP_VALUE || isSynced(obj)) return undefined;
  return str(labels[RELEASE_LABEL]) || undefined;
}

export const secretName = (name: string): string => `${SECRET_PREFIX}${name}`;

/** As `vcluster connect` names the context (`find.go` `VClusterContextName`); the backend builds the real one. */
export const contextName = (name: string, namespace: string, hostContext: string): string =>
  `vcluster_${name}_${namespace}_${hostContext}`;

export type InstanceState = "paused" | "scaledDown" | "ready" | "degraded" | "notReady";

export const STATE_TONE: Record<InstanceState, Tone> = {
  paused: "muted",
  scaledDown: "muted",
  ready: "success",
  degraded: "warning",
  notReady: "danger",
};

export interface Instance {
  namespace: string;
  name: string;
  workload: KubeObject;
  kind: "StatefulSet" | "Deployment";
  workloadName: string;
  replicas: number;
  readyReplicas: number;
  paused: boolean;
  version?: string;
  created?: string;
}

/** The instance a control plane stands for (`undefined` when it is not one). */
export function instanceOf(obj: KubeObject): Instance | undefined {
  const name = releaseOf(obj);
  const namespace = str(get(obj, "metadata", "namespace"));
  if (!name || !namespace) return undefined;
  const syncer = arr(get(obj, "spec", "template", "spec", "containers")).find((c) => get(c, "name") === SYNCER_CONTAINER);
  // As `getVCluster`: the tag is what follows the only `:` of the image.
  const parts = (str(get(syncer, "image")) ?? "").split(":");
  return {
    namespace,
    name,
    workload: obj,
    kind: obj.kind === "Deployment" ? "Deployment" : "StatefulSet",
    workloadName: str(get(obj, "metadata", "name")) ?? name,
    replicas: num(get(obj, "spec", "replicas")) ?? 1,
    readyReplicas: num(get(obj, "status", "readyReplicas")) ?? 0,
    paused: annotationsOf(obj)[PAUSED_ANNOTATION] === "true" || labelsOf(obj)[SLEEP_MODE_LABEL] === "true",
    version: parts.length === 2 ? parts[1] : undefined,
    created: str(get(obj, "metadata", "creationTimestamp")),
  };
}

/** Every instance of `objects` (StatefulSets and Deployments), by namespace and name. */
export function instancesOf(objects: Iterable<KubeObject>): Instance[] {
  const out: Instance[] = [];
  for (const obj of objects) {
    const instance = instanceOf(obj);
    if (instance) out.push(instance);
  }
  return out.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

export function stateOf(instance: Instance): InstanceState {
  if (instance.paused) return "paused";
  if (instance.replicas === 0) return "scaledDown";
  if (instance.readyReplicas >= instance.replicas) return "ready";
  return instance.readyReplicas > 0 ? "degraded" : "notReady";
}

/** The control plane pods of an instance (not the synced ones that happen to carry the same labels), newest first. */
export function podsOf(instance: Pick<Instance, "namespace" | "name">, pods: Iterable<KubeObject>): KubeObject[] {
  const out: KubeObject[] = [];
  for (const pod of pods) {
    const labels = labelsOf(pod);
    if (
      str(get(pod, "metadata", "namespace")) === instance.namespace &&
      labels[APP_LABEL] === APP_VALUE &&
      labels[RELEASE_LABEL] === instance.name &&
      !isSynced(pod)
    ) {
      out.push(pod);
    }
  }
  const created = (p: KubeObject) => str(get(p, "metadata", "creationTimestamp")) ?? "";
  return out.sort((a, b) => created(b).localeCompare(created(a)));
}

export interface PodSummary {
  total: number;
  ready: number;
  /** Phases other than Running, by count. */
  phases: Record<string, number>;
}

const podReady = (pod: KubeObject): boolean =>
  arr(get(pod, "status", "conditions")).some((c) => get(c, "type") === "Ready" && get(c, "status") === "True");

export function podSummary(pods: readonly KubeObject[]): PodSummary {
  const phases: Record<string, number> = {};
  let ready = 0;
  for (const pod of pods) {
    if (podReady(pod)) ready++;
    const phase = str(get(pod, "status", "phase")) ?? "Unknown";
    if (phase !== "Running") phases[phase] = (phases[phase] ?? 0) + 1;
  }
  return { total: pods.length, ready, phases };
}

/** Whether an object named `name` of `namespace` is among `objects` (metadata-only lists). */
export function hasNamed(objects: Iterable<KubeObject>, namespace: string, name: string): boolean {
  for (const obj of objects) {
    if (str(get(obj, "metadata", "namespace")) === namespace && str(get(obj, "metadata", "name")) === name) return true;
  }
  return false;
}

export interface SyncedObject {
  kind: string;
  hostName: string;
  /** The object in the virtual cluster it stands for; `undefined` when the syncer did not say. */
  virtualName?: string;
  virtualNamespace?: string;
}

/** What a synced host object stands for in the virtual cluster (`undefined` when it is not synced by `vcluster`). */
export function syncedOf(obj: KubeObject, vcluster: string): SyncedObject | undefined {
  const labels = labelsOf(obj);
  if (labels[MANAGED_BY_LABEL] !== vcluster) return undefined;
  const annotations = annotationsOf(obj);
  return {
    kind: obj.kind ?? "",
    hostName: str(get(obj, "metadata", "name")) ?? "",
    virtualName: str(annotations[OBJECT_NAME_ANNOTATION]) || undefined,
    virtualNamespace: str(annotations[OBJECT_NAMESPACE_ANNOTATION]) || str(labels[NAMESPACE_LABEL]) || undefined,
  };
}

/** The namespaces of the instances, sorted, at most `max`. */
export function namespacesOf(instances: readonly Instance[], max: number): string[] {
  return [...new Set(instances.map((i) => i.namespace))].sort().slice(0, max);
}
