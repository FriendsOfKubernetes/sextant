// What "Restart" does with each object (#255, ADR-0112). Pure: no React and no requests.
//
//   Deployment, StatefulSet, DaemonSet   `kubectl rollout restart`: the pod template's restartedAt annotation (the
//                                        existing `workload_restart`); a paused Deployment is refused as kubectl does
//   Argo Rollouts Rollout                `kubectl argo rollouts restart`: `spec.restartAt` (argo-rollouts/patches.ts)
//   ReplicaSet owned by a Deployment     its Deployment is restarted (a ReplicaSet has no rollout restart, and an old
//   or by a Rollout                      ReplicaSet of a Deployment would only be scaled down again)
//   ReplicaSet without a controller      its pods are deleted one at a time, each after the previous one's
//                                        replacement is ready (./run.ts)
//   Pod of a ReplicaSet, StatefulSet,    the pod is deleted and its controller creates a new one
//   DaemonSet or ReplicationController
//
// Not offered: a ReplicaSet owned by anything else, a pod without a controller (it would not come back), a static
// (mirror) pod, a Job's pod (whether the Job makes another depends on its backoff and pod failure policy), Sextant's
// node-shell pods and debug copies (ADR-0045, ADR-0064), and anything already being deleted.
import type { KindRef, KubeObject, ObjectRef } from "../../api";
import { status } from "../../resources";
import { kindFromApiVersion, refOf } from "../../resources/refs";
import { isKind, ROLLOUT } from "../argo-rollouts/model";

const { arr, get, str } = status;

export const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
export const REPLICA_SET: KindRef = { group: "apps", version: "v1", kind: "ReplicaSet" };

/** How long the pods of an unowned ReplicaSet wait for each replacement to be ready before the rest are left alone. */
export const REPLACEMENT_TIMEOUT_MS = 5 * 60_000;
/** How many objects the confirmation names; the rest are counted in one sentence. */
export const MAX_LISTED = 20;

const is = (kind: Pick<KindRef, "group" | "kind">, group: string, ...kinds: string[]) =>
  kind.group === group && kinds.includes(kind.kind);

/** Kinds `kubectl rollout restart` restarts. */
export const isRolloutKind = (kind: Pick<KindRef, "group" | "kind">) => is(kind, "apps", "Deployment", "StatefulSet", "DaemonSet");
export const isArgoRollout = (kind: Pick<KindRef, "group" | "kind">) => isKind(kind, ROLLOUT);

/** Controllers that recreate a deleted pod of theirs. */
const POD_CONTROLLERS: readonly [string, string][] = [
  ["apps", "ReplicaSet"],
  ["apps", "StatefulSet"],
  ["apps", "DaemonSet"],
  ["", "ReplicationController"],
];

export interface Owner {
  kind: KindRef;
  name: string;
  uid: string;
}

/** The controller owner reference of `obj` (`controller: true`), if any. */
export function controllerOf(obj: KubeObject): Owner | null {
  for (const raw of arr(get(obj, "metadata", "ownerReferences"))) {
    if (get(raw, "controller") !== true) continue;
    const apiVersion = str(get(raw, "apiVersion"));
    const kind = str(get(raw, "kind"));
    const name = str(get(raw, "name"));
    if (!apiVersion || !kind || !name) return null;
    return { kind: kindFromApiVersion(apiVersion, kind), name, uid: str(get(raw, "uid")) ?? "" };
  }
  return null;
}

export const uidOfObject = (obj: KubeObject): string | undefined => obj.metadata?.uid ?? undefined;
export const isDeleting = (obj: KubeObject): boolean => Boolean(get(obj, "metadata", "deletionTimestamp"));
const labelOf = (obj: KubeObject, key: string) => str(get(obj, "metadata", "labels", key));

/** Sextant's own pods (node shells, debug copies) — never restarted (the rules of node_shell.rs and debug.rs). */
export function isSextantPod(obj: KubeObject): boolean {
  const labels = get(obj, "metadata", "labels");
  const nodeShellLabel = ["sextant.dev/node-shell", "sextant.dev/session", "sextant.dev/owner"].some(
    (key) => typeof labels === "object" && labels !== null && key in labels,
  );
  const nodeShellName = (obj.metadata?.name ?? "").startsWith("sextant-node-shell-");
  const debugCopy = labelOf(obj, "app.kubernetes.io/managed-by") === "sextant" && labelOf(obj, "sextant.dev/debug-copy") === "true";
  return nodeShellLabel || nodeShellName || debugCopy;
}

/** A static pod's mirror: the kubelet owns it and deleting it brings back the same pod. */
export const isMirrorPod = (obj: KubeObject): boolean =>
  str(get(obj, "metadata", "annotations", "kubernetes.io/config.mirror")) !== undefined;

/** The controller that recreates `pod` after its deletion, or null when nothing (or not surely) does. */
export function podController(pod: KubeObject): Owner | null {
  if (isMirrorPod(pod) || isSextantPod(pod)) return null;
  const owner = controllerOf(pod);
  if (!owner) return null;
  return POD_CONTROLLERS.some(([group, kind]) => is(owner.kind, group, kind)) ? owner : null;
}

/** The owner whose restart replaces a ReplicaSet's pods: a Deployment or an Argo Rollout. */
export function replicaSetOwner(rs: KubeObject): Owner | null {
  const owner = controllerOf(rs);
  if (!owner) return null;
  return is(owner.kind, "apps", "Deployment") || isArgoRollout(owner.kind) ? owner : null;
}

export type RestartStep =
  /** `kubectl rollout restart` of a Deployment, StatefulSet or DaemonSet. */
  | { type: "rollout"; target: ObjectRef; uid?: string }
  /** `kubectl argo rollouts restart`. */
  | { type: "argoRollout"; target: ObjectRef; uid?: string }
  /** The owner of `replicaSets` restarted in their place (a Deployment or a Rollout). */
  | { type: "owner"; target: ObjectRef; uid: string; replicaSets: { ref: ObjectRef; uid?: string }[] }
  /** The pods of a ReplicaSet without a controller, deleted one at a time. */
  | { type: "pods"; target: ObjectRef; uid?: string }
  /** One pod, deleted so that `controller` recreates it. */
  | { type: "pod"; target: ObjectRef; uid?: string; controller: Owner };

/** The step that restarts `obj`, or null when Restart is not offered for it. */
function stepOf(obj: KubeObject, kind: KindRef): RestartStep | null {
  if (isDeleting(obj)) return null;
  const target = refOf(obj, kind);
  const uid = uidOfObject(obj);
  if (isRolloutKind(kind)) return { type: "rollout", target, uid };
  if (isArgoRollout(kind)) return { type: "argoRollout", target, uid };
  if (is(kind, "apps", "ReplicaSet")) {
    const owner = replicaSetOwner(obj);
    if (owner) {
      const ownerRef = { kind: owner.kind, namespace: target.namespace, name: owner.name };
      return { type: "owner", target: ownerRef, uid: owner.uid, replicaSets: [{ ref: target, uid }] };
    }
    return controllerOf(obj) ? null : { type: "pods", target, uid };
  }
  if (is(kind, "", "Pod")) {
    const controller = podController(obj);
    return controller ? { type: "pod", target, uid, controller } : null;
  }
  return null;
}

/** Whether Restart is offered for `obj` of `kind`. */
export const canRestart = (obj: KubeObject, kind: KindRef): boolean => stepOf(obj, kind) !== null;

/** Why Restart is not offered for an object (the cases `stepOf` refuses), for the selection bar (ADR-0126). */
export type NotRestartable =
  | { reason: "deleting" }
  | { reason: "mirror" }
  | { reason: "sextant" }
  | { reason: "noController" }
  | { reason: "otherController"; owner: Owner }
  | { reason: "kind" };

/** Why Restart is not offered for `obj` of `kind`, or null when it is. */
export function whyNotRestart(obj: KubeObject, kind: KindRef): NotRestartable | null {
  if (stepOf(obj, kind) !== null) return null;
  if (isDeleting(obj)) return { reason: "deleting" };
  if (is(kind, "apps", "ReplicaSet")) {
    const owner = controllerOf(obj);
    return owner ? { reason: "otherController", owner } : { reason: "kind" };
  }
  if (!is(kind, "", "Pod")) return { reason: "kind" };
  if (isMirrorPod(obj)) return { reason: "mirror" };
  if (isSextantPod(obj)) return { reason: "sextant" };
  const owner = controllerOf(obj);
  return owner ? { reason: "otherController", owner } : { reason: "noController" };
}

const refKey = (r: ObjectRef) => JSON.stringify([r.kind.group, r.kind.kind, r.namespace ?? "", r.name]);

/**
 * The steps restarting `objects`, in their order; ReplicaSets of one owner make one step of the owner, and an owner
 * selected itself is restarted once. Objects Restart does not apply to are left out.
 */
export function planRestart(objects: readonly KubeObject[], kind: KindRef): RestartStep[] {
  const steps: RestartStep[] = [];
  const byTarget = new Map<string, RestartStep>();
  for (const obj of objects) {
    const step = stepOf(obj, kind);
    if (!step) continue;
    const key = refKey(step.target);
    const earlier = byTarget.get(key);
    if (earlier?.type === "owner" && step.type === "owner" && earlier.uid === step.uid) {
      earlier.replicaSets.push(...step.replicaSets);
      continue;
    }
    if (earlier) continue;
    byTarget.set(key, step);
    steps.push(step);
  }
  return steps;
}

/** Whether a pod's Ready condition is True. */
export function isPodReady(pod: KubeObject): boolean {
  return arr(get(pod, "status", "conditions")).some((c) => get(c, "type") === "Ready" && get(c, "status") === "True");
}

/** Pods of the ReplicaSet `rsUid` (by controller reference) among `pods`, not being deleted, sorted by name. */
export function ownedPods(pods: Iterable<KubeObject>, rsUid: string): KubeObject[] {
  const result: KubeObject[] = [];
  for (const pod of pods) {
    if (isDeleting(pod)) continue;
    if (controllerOf(pod)?.uid === rsUid) result.push(pod);
  }
  return result.sort((a, b) => (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""));
}

/** A controller of two or more of the pods to restart: deleted back to back, they may take its workload down. */
export interface SharedController {
  controller: Owner;
  namespace: string | null;
  /** How many of the steps delete one of its pods. */
  count: number;
}

/** The controllers that two or more `pod` steps of `steps` share, in the order they first appear. */
export function sharedControllers(steps: readonly RestartStep[]): SharedController[] {
  const byUid = new Map<string, SharedController>();
  for (const step of steps) {
    if (step.type !== "pod" || !step.controller.uid) continue;
    const entry = byUid.get(step.controller.uid);
    if (entry) entry.count++;
    else byUid.set(step.controller.uid, { controller: step.controller, namespace: step.target.namespace ?? null, count: 1 });
  }
  return [...byUid.values()].filter((c) => c.count > 1);
}

/** Pods `restartPods` may delete: owned by the ReplicaSet and neither Sextant's own nor a static pod's mirror. */
export function deletablePods(pods: Iterable<KubeObject>, rsUid: string): KubeObject[] {
  return ownedPods(pods, rsUid).filter((pod) => !isSextantPod(pod) && !isMirrorPod(pod));
}

/** "Deployment demo/web": a kind and a name as data, for the sentences that name objects. */
export function objectLabel(r: ObjectRef): string {
  return `${r.kind.kind} ${r.namespace ? `${r.namespace}/${r.name}` : r.name}`;
}
