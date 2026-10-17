// Rollout history of Deployments, StatefulSets and DaemonSets, computed the way kubectl does it (no React here).
//
// A Deployment's revisions are the ReplicaSets it controls (`deployment.kubernetes.io/revision`), a StatefulSet's and a
// DaemonSet's the ControllerRevisions it controls (`revision`). The rollback is what `kubectl rollout undo
// --to-revision` changes: a Deployment gets the ReplicaSet's template (without `pod-template-hash`) and its
// annotations (keeping its own revision bookkeeping), a StatefulSet or DaemonSet the template stored in the
// ControllerRevision. Both are sent as a JSON patch through `resource_patch` (kubectl sends the ControllerRevision's
// strategic `$patch: replace` of the template, which comes to the same).
import type { KindRef, KubeObject, WatchSpec } from "../../api";
import { toYaml } from "../details";
import { status } from "../../resources";

const { arr, get, num, record, str } = status;

export const REVISION_ANNOTATION = "deployment.kubernetes.io/revision";
export const CHANGE_CAUSE_ANNOTATION = "kubernetes.io/change-cause";
export const POD_TEMPLATE_HASH = "pod-template-hash";

/** Annotations kubectl keeps from the Deployment instead of taking them from the ReplicaSet (`annotationsToSkip`). */
const ANNOTATIONS_TO_SKIP = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
  REVISION_ANNOTATION,
  "deployment.kubernetes.io/revision-history",
  "deployment.kubernetes.io/desired-replicas",
  "deployment.kubernetes.io/max-replicas",
  "deprecated.deployment.rollback.to",
]);

export type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

/** The kind's rollout flavour, `null` for kinds without a rollout history. */
export function workloadKind(kind: Pick<KindRef, "group" | "kind">): WorkloadKind | null {
  if (kind.group !== "apps") return null;
  return kind.kind === "Deployment" || kind.kind === "StatefulSet" || kind.kind === "DaemonSet" ? kind.kind : null;
}

export interface RevisionInfo {
  revision: number;
  /** The ReplicaSet or ControllerRevision that holds it. */
  name: string;
  created: string | null;
  changeCause: string | null;
  images: string[];
  /** The revision the workload runs (or rolls out to) now. */
  current: boolean;
  /** The pod template of the revision, as the workload would carry it. */
  template: unknown;
  /** The ReplicaSet or ControllerRevision itself. */
  source: KubeObject;
}

/** A label selector string (`app=web,tier in (a,b)`) of the workload's `spec.selector`; `null` if it selects nothing. */
export function selectorOf(workload: KubeObject): string | null {
  const selector = get(workload, "spec", "selector");
  const parts = Object.entries(record(get(selector, "matchLabels"))).map(([k, v]) => `${k}=${String(v)}`);
  for (const e of arr(get(selector, "matchExpressions"))) {
    const key = str(get(e, "key"));
    if (!key) continue;
    const values = arr(get(e, "values")).map(String).join(",");
    const operator = str(get(e, "operator"));
    if (operator === "In") parts.push(`${key} in (${values})`);
    else if (operator === "NotIn") parts.push(`${key} notin (${values})`);
    else if (operator === "Exists") parts.push(key);
    else if (operator === "DoesNotExist") parts.push(`!${key}`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}

/** The watch of the objects that hold the workload's revisions; `null` when there is nothing to watch. */
export function revisionsWatchSpec(workload: KubeObject, kind: WorkloadKind): WatchSpec | null {
  const namespace = workload.metadata?.namespace;
  const labelSelector = selectorOf(workload);
  if (!namespace || !labelSelector) return null;
  return {
    kind: { group: "apps", version: "v1", kind: kind === "Deployment" ? "ReplicaSet" : "ControllerRevision" },
    namespaces: [namespace],
    labelSelector,
    fieldSelector: null,
  };
}

function controlledBy(obj: KubeObject, uid: string | undefined): boolean {
  if (!uid) return false;
  return arr(obj.metadata?.ownerReferences).some((o) => get(o, "controller") === true && get(o, "uid") === uid);
}

function annotation(obj: unknown, key: string): string | null {
  return str(get(obj, "metadata", "annotations", key)) ?? null;
}

/** `value` without `null` members (a template's `creationTimestamp: null`). */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, withoutNulls(v)]),
    );
  }
  return value;
}

/** A copy of a pod template without the `pod-template-hash` label (and without a `$patch` directive). */
function cleanTemplate(template: unknown): unknown {
  if (!template || typeof template !== "object") return template ?? null;
  const copy = structuredClone(template) as Record<string, unknown>;
  delete copy.$patch;
  const labels = get(copy, "metadata", "labels");
  if (labels && typeof labels === "object") delete (labels as Record<string, unknown>)[POD_TEMPLATE_HASH];
  return copy;
}

/** The live pod template of the workload, comparable with a revision's `template`. */
export function liveTemplate(workload: KubeObject): unknown {
  return cleanTemplate(get(workload, "spec", "template"));
}

function imagesOf(template: unknown): string[] {
  return arr(get(template, "spec", "containers"))
    .map((c) => str(get(c, "image")))
    .filter((image): image is string => image !== undefined);
}

/** The revisions of `workload` among `objects` (ReplicaSets or ControllerRevisions), oldest first. */
export function revisionsOf(workload: KubeObject, kind: WorkloadKind, objects: Iterable<KubeObject>): RevisionInfo[] {
  const uid = workload.metadata?.uid;
  const revisions: RevisionInfo[] = [];
  for (const obj of objects) {
    if (!controlledBy(obj, uid)) continue;
    const revision =
      kind === "Deployment" ? Number.parseInt(annotation(obj, REVISION_ANNOTATION) ?? "", 10) : num(get(obj, "revision"));
    if (revision === undefined || !Number.isFinite(revision)) continue;
    const template = cleanTemplate(
      kind === "Deployment" ? get(obj, "spec", "template") : get(obj, "data", "spec", "template"),
    );
    revisions.push({
      revision,
      name: obj.metadata?.name ?? "",
      created: str(obj.metadata?.creationTimestamp) ?? null,
      changeCause: annotation(obj, CHANGE_CAUSE_ANNOTATION),
      images: imagesOf(template),
      current: false,
      template,
      source: obj,
    });
  }
  revisions.sort((a, b) => a.revision - b.revision);
  const current = currentRevision(workload, kind, revisions);
  for (const r of revisions) r.current = r.revision === current;
  return revisions;
}

function currentRevision(workload: KubeObject, kind: WorkloadKind, revisions: RevisionInfo[]): number | undefined {
  const newest = revisions.at(-1)?.revision;
  if (kind === "Deployment") {
    const own = Number.parseInt(annotation(workload, REVISION_ANNOTATION) ?? "", 10);
    return revisions.some((r) => r.revision === own) ? own : newest;
  }
  if (kind === "StatefulSet") {
    const name = str(get(workload, "status", "updateRevision"));
    return revisions.find((r) => r.name === name)?.revision ?? newest;
  }
  return newest;
}

/** Text of a template for the diff: keys sorted, `null`s left out. */
export function templateYaml(template: unknown): string {
  if (template === null || template === undefined) return "";
  return toYaml(canonical(withoutNulls(template)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** Whether the workload already runs the template of `revision` (a rollback would change nothing). */
export function matchesLive(workload: KubeObject, revision: RevisionInfo): boolean {
  return templateYaml(liveTemplate(workload)) === templateYaml(revision.template);
}

/** Why a rollback cannot be sent now, or `null`. */
export function rollbackBlocker(workload: KubeObject, kind: WorkloadKind): "paused" | null {
  return kind === "Deployment" && get(workload, "spec", "paused") === true ? "paused" : null;
}

/** The JSON patch (`resource_patch`, type `json`) that brings `workload` back to `revision`. */
export function rollbackPatch(workload: KubeObject, kind: WorkloadKind, revision: RevisionInfo): unknown[] {
  const template = { op: "replace", path: "/spec/template", value: revision.template };
  if (kind !== "Deployment") return [template];
  const annotations: Record<string, string> = {};
  const own = record(workload.metadata?.annotations);
  for (const key of ANNOTATIONS_TO_SKIP) {
    const value = own[key];
    if (typeof value === "string") annotations[key] = value;
  }
  for (const [key, value] of Object.entries(record(revision.source.metadata?.annotations))) {
    if (!ANNOTATIONS_TO_SKIP.has(key) && typeof value === "string") annotations[key] = value;
  }
  return [template, { op: "replace", path: "/metadata/annotations", value: annotations }];
}

export type RolloutState = "complete" | "progressing" | "paused" | "failed";

export interface RolloutStatus {
  state: RolloutState;
  desired: number;
  updated: number;
  ready: number;
  available: number;
  /** The controller has not seen the latest spec yet. */
  pendingObservation: boolean;
  /** Why it is stuck (`ProgressDeadlineExceeded`) and the controller's message. */
  reason?: string;
  message?: string;
}

const n = (value: unknown) => num(value) ?? 0;

/** Where the rollout stands, as `kubectl rollout status` reads it. */
export function rolloutStatus(workload: KubeObject, kind: WorkloadKind): RolloutStatus {
  const s = get(workload, "status");
  const generation = num(workload.metadata?.generation);
  const observed = num(get(s, "observedGeneration"));
  const pendingObservation = generation !== undefined && (observed === undefined || observed < generation);

  if (kind === "Deployment") {
    const desired = num(get(workload, "spec", "replicas")) ?? 1;
    const updated = n(get(s, "updatedReplicas"));
    const total = n(get(s, "replicas"));
    const ready = n(get(s, "readyReplicas"));
    const available = n(get(s, "availableReplicas"));
    const base = { desired, updated, ready, available, pendingObservation };
    const progressing = arr(get(s, "conditions")).find((c) => get(c, "type") === "Progressing");
    if (str(get(progressing, "reason")) === "ProgressDeadlineExceeded") {
      return { ...base, state: "failed", reason: "ProgressDeadlineExceeded", message: str(get(progressing, "message")) };
    }
    if (get(workload, "spec", "paused") === true) return { ...base, state: "paused" };
    const done = !pendingObservation && updated >= desired && total <= updated && available >= updated;
    return { ...base, state: done ? "complete" : "progressing" };
  }

  if (kind === "StatefulSet") {
    const desired = num(get(workload, "spec", "replicas")) ?? 1;
    const updated = n(get(s, "updatedReplicas"));
    const ready = n(get(s, "readyReplicas"));
    const available = n(get(s, "availableReplicas"));
    const base = { desired, updated, ready, available, pendingObservation };
    const partition = num(get(workload, "spec", "updateStrategy", "rollingUpdate", "partition")) ?? 0;
    const rolled =
      partition > 0
        ? updated >= desired - partition
        : str(get(s, "updateRevision")) === str(get(s, "currentRevision")) || updated >= desired;
    const done = !pendingObservation && ready >= desired && rolled;
    return { ...base, state: done ? "complete" : "progressing" };
  }

  const desired = n(get(s, "desiredNumberScheduled"));
  const updated = n(get(s, "updatedNumberScheduled"));
  const ready = n(get(s, "numberReady"));
  const available = n(get(s, "numberAvailable"));
  const done = !pendingObservation && updated >= desired && available >= desired;
  return { desired, updated, ready, available, pendingObservation, state: done ? "complete" : "progressing" };
}
