// Runs the steps of a restart (./model.ts) one at a time (#255, ADR-0112). Each step reads its objects again right
// before sending and refuses when one was replaced, is being deleted or changed owner; each request is sent once
// (ADR-0055) and is limited by the backend's CHANGE_TIMEOUT. "Stop" lets the current request finish and starts nothing
// more; a ReplicaSet's pods stop between two pods. Pods of one controller selected together are, by default, deleted
// one at a time with the same wait for a Ready replacement as a ReplicaSet's pods (`waitShared`).
import {
  acquireWatch,
  api,
  ApiError,
  subscribeWatchKey,
  toApiError,
  watchKey,
  watchStateOf,
  type ClusterId,
  type KubeObject,
  type ObjectRef,
  type WatchSpec,
} from "../../api";
import { i18n } from "../../i18n";
import { status } from "../../resources";
import { restartPatch } from "../argo-rollouts/patches";
import { labelSelectorOf } from "../logs/selector";
import {
  controllerOf,
  deletablePods,
  isArgoRollout,
  isDeleting,
  isMirrorPod,
  isPodReady,
  isSextantPod,
  objectLabel,
  ownedPods,
  POD,
  podController,
  REPLACEMENT_TIMEOUT_MS,
  replicaSetOwner,
  sharedControllers,
  type Owner,
  type RestartStep,
} from "./model";

const { get, num } = status;

export type StepOutcome =
  | { status: "done"; podsDone?: number; podsTotal?: number }
  | {
      status: "failed";
      error: ApiError;
      podsDone?: number;
      podsTotal?: number;
      /** A pod was deleted and its replacement did not become Ready (its controller's other pods are left alone). */
      replacementNotReady?: true;
    }
  /** Stopped by the user within a ReplicaSet's pods. */
  | { status: "stopped"; podsDone: number; podsTotal: number }
  /** Not started: stopped before it. */
  | { status: "skipped" };

export interface Progress {
  /** The step running now. */
  index: number;
  /** A ReplicaSet's pods: how many are restarted, of how many. */
  podsDone?: number;
  podsTotal?: number;
}

export interface RunControl {
  stopped: () => boolean;
  onProgress?: (progress: Progress) => void;
  /** The time `restartAt` is set to (tests). */
  now?: () => Date;
  /** How long a replacement pod may take to be ready (tests). */
  replacementTimeoutMs?: number;
  /**
   * Pods of a controller that two or more steps share are deleted one at a time, each after the replacement of the
   * one before is Ready; one not Ready in time leaves that controller's other pods alone.
   */
  waitShared?: boolean;
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);
const conflict = (key: string, ref: ObjectRef) => new ApiError("conflict", t(key, { name: objectLabel(ref) }));

/** The object as it is now, refused when it was replaced (another uid) or is being deleted. */
async function fresh(clusterId: ClusterId, ref: ObjectRef, uid: string | undefined): Promise<KubeObject> {
  const obj = await api.resources.get(clusterId, ref);
  const now = obj.metadata?.uid;
  if (uid && now && now !== uid) throw conflict("restart:error.replaced", ref);
  if (isDeleting(obj)) throw conflict("restart:error.deleting", ref);
  return obj;
}

/** A rollout restart, or a Rollout's `restartAt`, of the object `obj` read just now. */
async function restartWorkload(clusterId: ClusterId, ref: ObjectRef, obj: KubeObject, now: () => Date): Promise<void> {
  if (isArgoRollout(ref.kind)) {
    await api.resources.patch(clusterId, ref, restartPatch(now()), "merge");
    return;
  }
  // `kubectl rollout restart` refuses a paused Deployment: its new template would not roll out.
  if (ref.kind.kind === "Deployment" && get(obj, "spec", "paused") === true) throw conflict("restart:error.paused", ref);
  await api.actions.restart(clusterId, ref);
}

async function runStep(
  clusterId: ClusterId,
  step: RestartStep,
  index: number,
  control: RunControl,
  waits = false,
): Promise<StepOutcome> {
  const now = control.now ?? (() => new Date());
  switch (step.type) {
    case "rollout":
    case "argoRollout": {
      const obj = await fresh(clusterId, step.target, step.uid);
      await restartWorkload(clusterId, step.target, obj, now);
      return { status: "done" };
    }
    case "owner": {
      for (const rs of step.replicaSets) {
        const owner = replicaSetOwner(await fresh(clusterId, rs.ref, rs.uid));
        if (!owner || owner.uid !== step.uid) throw conflict("restart:error.ownerChanged", rs.ref);
      }
      const obj = await fresh(clusterId, step.target, step.uid);
      await restartWorkload(clusterId, step.target, obj, now);
      return { status: "done" };
    }
    case "pod": {
      const pod = await fresh(clusterId, step.target, step.uid);
      if (podController(pod)?.uid !== step.controller.uid) throw conflict("restart:error.ownerChanged", step.target);
      if (waits) return restartPodAndWait(clusterId, step.target, pod, step.controller, control);
      await api.resources.delete(clusterId, step.target, { uid: pod.metadata?.uid ?? null, resourceVersion: null });
      return { status: "done" };
    }
    case "pods":
      return restartPods(clusterId, step.target, step.uid, index, control);
  }
}

type WaitResult = "ok" | "timeout" | "stopped" | ApiError;

/** Resolves once `check` says so (on every change of the watch `key`), or on stop, timeout or a watch error. */
function waitFor(
  key: string,
  check: () => boolean | ApiError,
  timeoutMs: number,
  stopped: () => boolean,
): Promise<WaitResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let unsubscribe = () => {};
    let done = false;
    const finish = (result: WaitResult) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearInterval(timer);
      resolve(result);
    };
    const test = () => {
      const result = check();
      if (result instanceof ApiError) finish(result);
      else if (result) finish("ok");
      else if (stopped()) finish("stopped");
      else if (Date.now() - started >= timeoutMs) finish("timeout");
    };
    unsubscribe = subscribeWatchKey(key, test);
    const timer = setInterval(test, 250);
    test();
  });
}

/** The label selector of a pod controller: `spec.selector` as a LabelSelector, or a ReplicationController's map. */
function controllerSelector(obj: KubeObject): string | null {
  const selector = get(obj, "spec", "selector");
  if (obj.kind === "ReplicationController" && selector && typeof selector === "object") {
    const parts = Object.entries(selector as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`);
    return parts.length > 0 ? parts.join(",") : null;
  }
  return labelSelectorOf(obj);
}

/** How many ready pods the controller wants: a DaemonSet's scheduled count, else `spec.replicas` (1 if unset). */
function desiredOf(obj: KubeObject): number {
  if (obj.kind === "DaemonSet") return num(get(obj, "status", "desiredNumberScheduled")) ?? Number.POSITIVE_INFINITY;
  return num(get(obj, "spec", "replicas")) ?? 1;
}

/**
 * The pods of a controller, followed by one watch of its namespace with its selector (shared through the watch
 * registry) until `release`. `deleteAndWait` deletes one pod with its uid as the precondition, then waits until the
 * controller has as many Ready pods other than the deleted one as it had before (at most `desired`).
 */
interface ControllerPods {
  /** Its pods (by controller reference), not being deleted, sorted by name. */
  pods: () => KubeObject[];
  deleteAndWait: (podRef: ObjectRef, pod: KubeObject) => Promise<WaitResult>;
  release: () => void;
}

async function followControllerPods(
  clusterId: ClusterId,
  namespace: string,
  selector: string,
  ownerUid: string,
  desired: number,
  control: RunControl,
): Promise<ControllerPods | "stopped"> {
  const spec: WatchSpec = { kind: POD, namespaces: [namespace], labelSelector: selector, fieldSelector: null };
  const key = watchKey(clusterId, spec);
  const release = acquireWatch(clusterId, spec);
  const timeoutMs = control.replacementTimeoutMs ?? REPLACEMENT_TIMEOUT_MS;
  const items = () => watchStateOf(clusterId, spec).items.values();
  const watchError = () => {
    const state = watchStateOf(clusterId, spec);
    return state.status === "error" ? (state.error ?? new ApiError("other", "")) : null;
  };
  try {
    const listed = await waitFor(key, () => watchError() ?? watchStateOf(clusterId, spec).status === "ready", timeoutMs, control.stopped);
    if (listed === "stopped") {
      release();
      return "stopped";
    }
    if (listed !== "ok") throw listed === "timeout" ? new ApiError("timeout", t("restart:error.listTimeout")) : listed;
  } catch (err) {
    release();
    throw err;
  }
  return {
    pods: () => ownedPods(items(), ownerUid),
    release,
    deleteAndWait: async (podRef, pod) => {
      const podUid = pod.metadata?.uid ?? null;
      const readyOthers = () => ownedPods(items(), ownerUid).filter((p) => p.metadata?.uid !== podUid && isPodReady(p)).length;
      const wanted = Math.min(readyOthers() + (isPodReady(pod) ? 1 : 0), desired);
      await api.resources.delete(clusterId, podRef, { uid: podUid, resourceVersion: null });
      return waitFor(key, () => watchError() ?? readyOthers() >= wanted, timeoutMs, control.stopped);
    },
  };
}

/** The error of a replacement that did not become Ready (or of the watch that followed it). */
const notReady = (result: "timeout" | ApiError, podRef: ObjectRef): ApiError =>
  result === "timeout" ? new ApiError("timeout", t("restart:error.notReady", { name: objectLabel(podRef) })) : result;

/**
 * One pod of a controller that other selected pods share: deleted, then waited for until the controller has its
 * Ready pods back (the controller read again first: replaced or being deleted sends nothing).
 */
async function restartPodAndWait(
  clusterId: ClusterId,
  podRef: ObjectRef,
  pod: KubeObject,
  controller: Owner,
  control: RunControl,
): Promise<StepOutcome> {
  const ownerRef: ObjectRef = { kind: controller.kind, namespace: podRef.namespace, name: controller.name };
  const owner = await fresh(clusterId, ownerRef, controller.uid);
  const selector = controllerSelector(owner);
  if (!selector || !podRef.namespace) throw new ApiError("notFound", t("restart:error.noPods", { name: objectLabel(ownerRef) }));
  const followed = await followControllerPods(clusterId, podRef.namespace, selector, controller.uid, desiredOf(owner), control);
  if (followed === "stopped") return { status: "skipped" };
  try {
    const result = await followed.deleteAndWait(podRef, pod);
    if (result === "ok" || result === "stopped") return { status: "done" };
    return { status: "failed", error: notReady(result, podRef), replacementNotReady: true };
  } finally {
    followed.release();
  }
}

/**
 * The pods of a ReplicaSet without a controller, deleted one at a time (sorted by name, as listed when the step
 * starts; Sextant's own and static pods are never among them); the next one only after the ReplicaSet has as many
 * ready pods again as before the deletion (at most its desired replicas), within `REPLACEMENT_TIMEOUT_MS`.
 */
async function restartPods(
  clusterId: ClusterId,
  target: ObjectRef,
  uid: string | undefined,
  index: number,
  control: RunControl,
): Promise<StepOutcome> {
  const rs = await fresh(clusterId, target, uid);
  if (controllerOf(rs)) throw conflict("restart:error.ownerChanged", target);
  const selector = labelSelectorOf(rs);
  const rsUid = rs.metadata?.uid;
  if (!selector || !rsUid || !target.namespace) throw new ApiError("notFound", t("restart:error.noPods", { name: objectLabel(target) }));
  const desired = num(get(rs, "spec", "replicas")) ?? 1;
  const followed = await followControllerPods(clusterId, target.namespace, selector, rsUid, desired, control);
  if (followed === "stopped") return { status: "stopped", podsDone: 0, podsTotal: 0 };
  try {
    const pods = deletablePods(followed.pods(), rsUid);
    const total = pods.length;
    if (total === 0) throw new ApiError("notFound", t("restart:error.noPods", { name: objectLabel(target) }));
    for (let done = 0; done < total; done++) {
      if (control.stopped()) return { status: "stopped", podsDone: done, podsTotal: total };
      control.onProgress?.({ index, podsDone: done, podsTotal: total });
      const podRef: ObjectRef = { kind: POD, namespace: target.namespace, name: pods[done]?.metadata?.name ?? "" };
      let pod: KubeObject;
      try {
        pod = await api.resources.get(clusterId, podRef);
      } catch (err) {
        if (toApiError(err).code === "notFound") continue; // already gone: the ReplicaSet replaces it anyway
        throw err;
      }
      const podUid = pod.metadata?.uid;
      // Replaced by another pod of the same name, or already going: nothing to delete.
      if (!podUid || podUid !== pods[done]?.metadata?.uid || isDeleting(pod)) continue;
      // Sextant's own pods and static pods' mirrors are never deleted, whatever the list said (fail closed).
      if (isSextantPod(pod) || isMirrorPod(pod)) continue;
      if (controllerOf(pod)?.uid !== rsUid) throw conflict("restart:error.ownerChanged", podRef);
      const replaced = await followed.deleteAndWait(podRef, pod);
      if (replaced === "stopped") return { status: "stopped", podsDone: done + 1, podsTotal: total };
      if (replaced !== "ok") return { status: "failed", error: notReady(replaced, podRef), podsDone: done + 1, podsTotal: total };
    }
    return { status: "done", podsDone: total, podsTotal: total };
  } finally {
    followed.release();
  }
}

/**
 * Runs `steps` in order; a failed step does not stop the others, "Stop" does. With `waitShared`, a pod whose
 * controller's earlier pod was not replaced by a Ready one is not deleted.
 */
export async function runRestart(clusterId: ClusterId, steps: readonly RestartStep[], control: RunControl): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  const shared = control.waitShared ? new Set(sharedControllers(steps).map((c) => c.controller.uid)) : new Set<string>();
  const blocked = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (control.stopped()) {
      outcomes.push({ status: "skipped" });
      continue;
    }
    const waits = step.type === "pod" && shared.has(step.controller.uid);
    if (waits && blocked.has(step.controller.uid)) {
      const name = objectLabel({ ...step.target, kind: step.controller.kind, name: step.controller.name });
      outcomes.push({ status: "failed", error: new ApiError("conflict", t("restart:error.earlierNotReady", { controller: name })) });
      continue;
    }
    control.onProgress?.({ index });
    let outcome: StepOutcome;
    try {
      outcome = await runStep(clusterId, step, index, control, waits);
    } catch (err) {
      outcome = { status: "failed", error: toApiError(err) };
    }
    if (step.type === "pod" && outcome.status === "failed" && outcome.replacementNotReady) blocked.add(step.controller.uid);
    outcomes.push(outcome);
  }
  return outcomes;
}
