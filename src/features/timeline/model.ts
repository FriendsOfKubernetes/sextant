// Change timeline (#145), the pure part: what of an object counts as a change, the diff of two versions of it, and who
// made a change (field managers). No React, no clock, no watch.
//
//   isRecordedKind(kind)            // Pods, ReplicaSets, Events, EndpointSlices, Leases… churn: never recorded
//   projection(kind, obj)           // the object without status and bookkeeping (resourceVersion, managedFields, …)
//   canonical(projection)           // a stable text of it (sorted keys; long values replaced by a hash)
//   diffObjects(kind, before, after) // the changed fields, clipped; a Secret's values never appear
//   changedManagers(before, now)    // which field managers made the change
//
// Secrets arrive without their values (`""` for every key, `sextant.dev/values-hidden`): only key names can change
// here, and a Secret's diff never carries a value even if one arrived. Secret material other kinds hold inline (a
// Route's key, a BuildConfig's webhook secrets, a HelmChart's values, a k3s node's arguments: `inline-secrets.json`)
// does arrive whole; the projection keeps each such value only as a salted hash (so a change of it is still seen) and
// a diff names its path without a value.
import type { FieldManager, KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import { isInlineSecretPath, replaceInlineSecrets } from "../../resources/inlineSecrets";

const { arr, get, str } = status;

/** A field that changed between two versions of an object. */
export interface FieldChange {
  /** `spec.replicas`, `metadata.labels["app.kubernetes.io/version"]`, `spec.template.spec.containers[web].image`. */
  path: string;
  op: "added" | "removed" | "changed";
  /** The values as text, clipped to `MAX_VALUE_SHOWN`; absent for a Secret's values, inline secrets and long values. */
  before?: string;
  after?: string;
  /** A value was too long to keep: only that it changed is known. */
  long?: true;
}

/** At most this many changes are kept per recorded change; `more` counts the rest. */
export const MAX_CHANGES = 30;
/** A value is shown up to this many characters. */
export const MAX_VALUE_SHOWN = 200;
/** A value longer than this is kept only as a hash (ConfigMap data, embedded documents). */
export const MAX_VALUE_KEPT = 2048;

const k = (group: string, kind: string) => `${group}/${kind}`;

/** Kinds whose objects come and go or change all the time on their own: their story is told by their owners. */
const NOT_RECORDED = new Set([
  k("", "Pod"),
  k("apps", "ReplicaSet"),
  k("apps", "ControllerRevision"),
  k("", "Event"),
  k("events.k8s.io", "Event"),
  k("", "Endpoints"),
  k("discovery.k8s.io", "EndpointSlice"),
  k("coordination.k8s.io", "Lease"),
  k("", "ComponentStatus"),
  k("", "Binding"),
  k("metrics.k8s.io", "PodMetrics"),
  k("metrics.k8s.io", "NodeMetrics"),
  k("apiextensions.k8s.io", "CustomResourceDefinition"),
]);

/** Groups of high-churn objects of add-ons (Cilium endpoints and identities, Calico's IPAM blocks). */
const NOT_RECORDED_GROUPS = new Set(["metrics.k8s.io", "crd.projectcalico.org"]);
const NOT_RECORDED_CILIUM = new Set(["CiliumEndpoint", "CiliumIdentity", "CiliumNode", "CiliumEndpointSlice"]);

export function isRecordedKind(kind: Pick<KindRef, "group" | "kind">): boolean {
  if (NOT_RECORDED.has(k(kind.group, kind.kind)) || NOT_RECORDED_GROUPS.has(kind.group)) return false;
  return !(kind.group === "cilium.io" && NOT_RECORDED_CILIUM.has(kind.kind));
}

/** Annotations controllers rewrite as bookkeeping (or that repeat the spec): never a change of their own. */
const NOISY_ANNOTATIONS = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
  "deployment.kubernetes.io/revision-history",
  "deployment.kubernetes.io/desired-replicas",
  "deployment.kubernetes.io/max-replicas",
  "control-plane.alpha.kubernetes.io/leader",
  "endpoints.kubernetes.io/last-change-trigger-time",
  "batch.kubernetes.io/job-tracking",
  "volume.kubernetes.io/selected-node",
  "volume.beta.kubernetes.io/storage-provisioner",
  "volume.kubernetes.io/storage-provisioner",
  "sextant.dev/values-hidden",
]);
const NOISY_ANNOTATION_PREFIXES = ["autoscaling.alpha.kubernetes.io/", "pv.kubernetes.io/"];

export function isNoisyAnnotation(key: string): boolean {
  return NOISY_ANNOTATIONS.has(key) || NOISY_ANNOTATION_PREFIXES.some((p) => key.startsWith(p));
}

const isSecret = (kind: Pick<KindRef, "group" | "kind">) => kind.group === "" && kind.kind === "Secret";

/** The object's controller, if any. */
export function controllerKind(obj: KubeObject): string | undefined {
  const owner = arr(obj.metadata?.ownerReferences).find((o) => get(o, "controller") === true);
  return owner ? str(get(owner, "kind")) : undefined;
}

/** A Job a CronJob started: one run of many, told by its CronJob. */
export function isOwnedRun(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): boolean {
  return kind.group === "batch" && kind.kind === "Job" && controllerKind(obj) === "CronJob";
}

function sortedRecord(value: unknown, keep: (key: string) => boolean = () => true): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) if (keep(key)) out[key] = (value as Record<string, unknown>)[key];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Random per page load: an inline secret's hash says only whether it changed, and is never kept beyond the page. */
const INLINE_SALT = Math.random().toString(36).slice(2) + Date.now().toString(36);
const HIDDEN_MARK = "\u0000hidden:";
const hiddenMark = (value: unknown) => `${HIDDEN_MARK}${hashText(INLINE_SALT + JSON.stringify(value))}`;

/**
 * What a change of `obj` is about: its top-level fields but `status` (and `apiVersion`/`kind`), and of its metadata
 * the labels, the annotations that are not bookkeeping, the finalizers and the owners. A Secret keeps only the names
 * of its keys; a value at an inline secret path of the kind only as a salted hash.
 */
export function projection(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const meta = obj.metadata ?? {};
  const metadata: Record<string, unknown> = {};
  const labels = sortedRecord(meta.labels);
  if (labels) metadata.labels = labels;
  const annotations = sortedRecord(meta.annotations, (key) => !isNoisyAnnotation(key));
  if (annotations) metadata.annotations = annotations;
  if (arr(meta.finalizers).length > 0) metadata.finalizers = meta.finalizers;
  const owners = arr(meta.ownerReferences).map((o) => ({
    kind: str(get(o, "kind")),
    name: str(get(o, "name")),
    ...(get(o, "controller") === true ? { controller: true } : {}),
  }));
  if (owners.length > 0) metadata.ownerReferences = owners;
  if (Object.keys(metadata).length > 0) out.metadata = metadata;

  for (const key of Object.keys(obj).sort()) {
    if (key === "apiVersion" || key === "kind" || key === "metadata" || key === "status") continue;
    let value = (obj as Record<string, unknown>)[key];
    if (isSecret(kind) && (key === "data" || key === "stringData")) {
      // Names only: the values are not here (and must never be kept if they were).
      const names = sortedRecord(value);
      value = names ? Object.fromEntries(Object.keys(names).map((n) => [n, ""])) : undefined;
    }
    if (kind.group === "" && kind.kind === "PersistentVolumeClaim" && key === "spec" && value && typeof value === "object") {
      // Set once by the binder when the claim binds: bookkeeping, not a change of the request.
      const { volumeName: _bound, ...rest } = value as Record<string, unknown>;
      value = rest;
    }
    if (value !== undefined) out[key] = value;
  }
  return replaceInlineSecrets(kind.group, kind.kind, out, hiddenMark);
}

/** FNV-1a, 52 bits: a short stand-in for a long value. */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100019d) >>> 0;
  }
  return (h1 >>> 0).toString(36) + (h2 & 0xfffff).toString(36);
}

/** The text a long value is kept as: only its hash and length. */
const LONG_MARK = "\u0000long:";
const longMark = (text: string) => `${LONG_MARK}${text.length}:${hashText(text)}`;
const isLong = (value: unknown) => typeof value === "string" && value.startsWith(LONG_MARK);

/** The projection with every long string value replaced by its hash, keys sorted: equal objects, equal text. */
export function canonical(value: unknown): string {
  return JSON.stringify(shorten(value));
}

function shorten(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_VALUE_KEPT ? longMark(value) : value;
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = shorten((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** A value as shown: strings as they are, anything else as JSON; clipped. */
export function showValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_VALUE_SHOWN ? `${text.slice(0, MAX_VALUE_SHOWN - 1)}…` : text;
}

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const childPath = (path: string, key: string) =>
  PLAIN_KEY.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Items of a list matched by `name` when every item has a distinct one (containers, env, volumes, ports). */
function byName(items: unknown[]): Map<string, unknown> | undefined {
  const out = new Map<string, unknown>();
  for (const item of items) {
    const name = isRecord(item) ? item.name : undefined;
    if (typeof name !== "string" || out.has(name)) return undefined;
    out.set(name, item);
  }
  return out;
}

export interface Diff {
  changes: FieldChange[];
  /** Changes beyond `MAX_CHANGES`, left out. */
  more: number;
}

/**
 * The fields that differ between two projections (`projection` or parsed `canonical` text), in path order, at most
 * `MAX_CHANGES`. A Secret's values are never in the result.
 */
export function diffObjects(kind: Pick<KindRef, "group" | "kind">, before: unknown, after: unknown): Diff {
  const changes: FieldChange[] = [];
  let more = 0;
  const hidden = (path: string) =>
    (isSecret(kind) && (path.startsWith("data") || path.startsWith("stringData"))) || isInlineSecretPath(kind.group, kind.kind, path);
  const push = (path: string, op: FieldChange["op"], a: unknown, b: unknown) => {
    if (changes.length >= MAX_CHANGES) {
      more++;
      return;
    }
    const change: FieldChange = { path, op };
    if (isLong(a) || isLong(b)) change.long = true;
    if (!hidden(path)) {
      if (op !== "added" && !isLong(a)) change.before = showValue(a);
      if (op !== "removed" && !isLong(b)) change.after = showValue(b);
    }
    changes.push(change);
  };
  const walk = (path: string, a: unknown, b: unknown) => {
    if (a === undefined && b === undefined) return;
    if (a === undefined) return push(path, "added", a, b);
    if (b === undefined) return push(path, "removed", a, b);
    if (isRecord(a) && isRecord(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) walk(childPath(path, key), a[key], b[key]);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const named = byName(a);
      const namedB = named && byName(b);
      if (named && namedB) {
        for (const name of [...new Set([...named.keys(), ...namedB.keys()])]) {
          walk(`${path}[${name}]`, named.get(name), namedB.get(name));
        }
        return;
      }
      const scalars = [...a, ...b].every((v) => v === null || typeof v !== "object");
      if (scalars) {
        if (JSON.stringify(a) !== JSON.stringify(b)) push(path, "changed", a, b);
        return;
      }
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(`${path}[${i}]`, a[i], b[i]);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) push(path, "changed", a, b);
  };
  walk("", before, after);
  return { changes, more };
}

// ---------- Who ----------

const sameManager = (a: FieldManager, b: FieldManager) =>
  a.manager === b.manager && a.operation === b.operation && (a.subresource ?? null) === (b.subresource ?? null);

const managerTime = (m: FieldManager) => {
  const t = m.time ? Date.parse(m.time) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/** Who made a change: the field managers, and whether they are known exactly or only likely. */
export interface Who {
  managers: FieldManager[];
  /** `true`: their `time` moved since the object was last looked at. `false`: the most recent ones, a likely guess. */
  exact: boolean;
}

/**
 * The managers behind a change: those whose entry is new or whose `time` moved since `before` (the object's managers
 * as last read), else the most recent ones. Writes through `status` are a controller reporting, never a change of the
 * object here, so they are left out. `null` when nothing can tell.
 */
export function changedManagers(before: readonly FieldManager[] | undefined, now: readonly FieldManager[]): Who | null {
  const relevant = now.filter((m) => m.subresource !== "status");
  if (before) {
    const moved = relevant.filter((m) => !before.some((b) => sameManager(b, m) && b.time === m.time));
    if (moved.length > 0) return { managers: moved, exact: true };
  }
  const latest = Math.max(...relevant.map(managerTime));
  if (!Number.isFinite(latest)) return null;
  return { managers: relevant.filter((m) => managerTime(m) === latest), exact: false };
}

/**
 * A known field manager as people call it (`kubectl apply`, Helm, Argo CD, Flux…); `undefined` for any other, shown
 * as its own name. Sextant's own (`sextant`) is named by the caller in the UI language.
 */
export function friendlyManager(manager: string): string | undefined {
  if (manager === "kubectl-client-side-apply" || manager === "kubectl") return "kubectl apply";
  if (manager.startsWith("kubectl-")) return `kubectl ${manager.slice("kubectl-".length)}`;
  if (manager === "helm") return "Helm";
  if (manager === "argocd-controller" || manager === "argocd-application-controller") return "Argo CD";
  if (manager === "argocd-server") return "Argo CD (UI / API)";
  if (manager === "kustomize-controller") return "Flux (kustomize-controller)";
  if (manager === "helm-controller") return "Flux (helm-controller)";
  if (manager === "kube-controller-manager") return "kube-controller-manager";
  if (manager === "Terraform" || manager.startsWith("terraform-provider")) return "Terraform";
  if (manager.startsWith("pulumi")) return "Pulumi";
  if (manager === "k9s") return "k9s";
  return undefined;
}

/** Sextant's own field manager (the window's changes and an AI agent's through Sextant). */
export const SEXTANT_MANAGER = "sextant";
