// An object made ready for comparison (#156): what differs between two copies of the same configuration only because
// they live in different places or were stored at different times is taken out, so the diff shows the configuration.
//
// Always removed: `status`; `metadata.managedFields`, `uid`, `resourceVersion`, `generation`, `creationTimestamp`
// (also in pod templates), `selfLink`, `namespace` (each side names its own) and the uid of owner references; the
// random suffix of a generated name (`generateName`); generated labels (`pod-template-hash`, `controller-revision-hash`,
// a Job's controller uid) wherever labels or selectors are; the `kubectl.kubernetes.io/last-applied-configuration`,
// `deployment.kubernetes.io/revision` and Sextant's hidden-values annotations; a Secret's `data` and `stringData`
// (always compared by key names and value hashes in the backend, never here).
//
// With "Hide defaults" (off by default) also the fields the API server fills in when a manifest leaves them out
// (`DEFAULTED`): a field is removed only while it holds exactly that default, so a value someone set stays visible.
// Then the user's ignore paths of the kind.
import type { KindRef } from "../../api";
import { parsePath, removeAt } from "./paths";

export interface NormalizeOptions {
  hideDefaults: boolean;
  /** Paths of `paths.ts` (`/spec/replicas`); a path that does not parse is skipped. */
  ignorePaths: readonly string[];
}

const METADATA_NOISE = ["managedFields", "uid", "resourceVersion", "generation", "creationTimestamp", "selfLink", "namespace"];
const GENERATED_LABELS = [
  "pod-template-hash",
  "controller-revision-hash",
  "controller-uid",
  "batch.kubernetes.io/controller-uid",
  "job-name",
  "batch.kubernetes.io/job-name",
];
const NOISE_ANNOTATIONS = [
  "kubectl.kubernetes.io/last-applied-configuration",
  "deployment.kubernetes.io/revision",
  "sextant.dev/values-hidden",
];

/** Where pod specs are: a Pod's own, a workload's template, a CronJob's job template. */
const POD_SPECS = ["/spec/template/spec", "/spec/jobTemplate/spec/template/spec"];

/** Defaulted fields under a pod spec. */
const POD_DEFAULTS: ReadonlyArray<[string, unknown]> = [
  ["/dnsPolicy", "ClusterFirst"],
  ["/restartPolicy", "Always"],
  ["/schedulerName", "default-scheduler"],
  ["/securityContext", {}],
  ["/terminationGracePeriodSeconds", 30],
  ["/enableServiceLinks", true],
  ["/*containers/*/terminationMessagePath", "/dev/termination-log"],
  ["/*containers/*/terminationMessagePolicy", "File"],
  ["/*containers/*/imagePullPolicy", "IfNotPresent"],
  ["/*containers/*/resources", {}],
  ["/*containers/*/ports/*/protocol", "TCP"],
  ["/*containers/*/*Probe/timeoutSeconds", 1],
  ["/*containers/*/*Probe/periodSeconds", 10],
  ["/*containers/*/*Probe/successThreshold", 1],
  ["/*containers/*/*Probe/failureThreshold", 3],
];

/** Defaulted (or assigned) fields per kind (`group/Kind`). */
const KIND_DEFAULTS: Readonly<Record<string, ReadonlyArray<[string, unknown]>>> = {
  "apps/Deployment": [
    ["/spec/revisionHistoryLimit", 10],
    ["/spec/progressDeadlineSeconds", 600],
    ["/spec/strategy", { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } }],
  ],
  "apps/StatefulSet": [
    ["/spec/revisionHistoryLimit", 10],
    ["/spec/podManagementPolicy", "OrderedReady"],
    ["/spec/updateStrategy", { type: "RollingUpdate", rollingUpdate: { partition: 0 } }],
    ["/spec/persistentVolumeClaimRetentionPolicy", { whenDeleted: "Retain", whenScaled: "Retain" }],
  ],
  "apps/DaemonSet": [
    ["/spec/revisionHistoryLimit", 10],
    ["/spec/updateStrategy", { type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } }],
  ],
  "batch/CronJob": [
    ["/spec/concurrencyPolicy", "Allow"],
    ["/spec/suspend", false],
    ["/spec/successfulJobsHistoryLimit", 3],
    ["/spec/failedJobsHistoryLimit", 1],
  ],
  "/Service": [
    ["/spec/type", "ClusterIP"],
    ["/spec/sessionAffinity", "None"],
    ["/spec/ipFamilyPolicy", "SingleStack"],
    ["/spec/internalTrafficPolicy", "Cluster"],
    ["/spec/ports/*/protocol", "TCP"],
  ],
  "/PersistentVolumeClaim": [["/spec/volumeMode", "Filesystem"]],
};

/** Assigned by the cluster rather than defaulted: always different between clusters, hidden with the defaults. */
const KIND_ASSIGNED: Readonly<Record<string, readonly string[]>> = {
  "/Service": ["/spec/clusterIP", "/spec/clusterIPs", "/spec/ipFamilies"],
  "/PersistentVolumeClaim": ["/spec/volumeName"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether two JSON values are equal (key order does not matter). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/** `/*containers/...`: `*` inside a segment matches like a glob (`containers`, `initContainers`, `livenessProbe`). */
function expand(root: unknown, segments: readonly string[], at: (parent: unknown, key: string) => void): void {
  const [head, ...rest] = segments;
  if (head === undefined || typeof root !== "object" || root === null) return;
  const keys = Array.isArray(root) ? root.map((_, i) => String(i)) : Object.keys(root);
  const glob = head.includes("*") && head !== "*" ? new RegExp(`^${head.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i") : null;
  const matching = head === "*" ? keys : glob ? keys.filter((k) => glob.test(k)) : [head];
  for (const key of matching) {
    if (rest.length === 0) at(root, key);
    else expand((root as Record<string, unknown>)[key], rest, at);
  }
}

function removeDefault(root: unknown, path: string, value: unknown): void {
  const segments = parsePath(path);
  if (!segments) return;
  const last = segments[segments.length - 1];
  if (last === undefined) return;
  expand(root, segments.slice(0, -1), (parent, key) => {
    const holder = (parent as Record<string, unknown>)[key];
    if (isRecord(holder) && deepEqual(holder[last], value)) delete holder[last];
  });
  if (segments.length === 1 && isRecord(root) && deepEqual(root[last], value)) delete root[last];
}

function pruneMap(holder: unknown, field: string, keys: readonly string[]): void {
  if (!isRecord(holder)) return;
  const map = holder[field];
  if (!isRecord(map)) return;
  for (const key of keys) delete map[key];
  if (Object.keys(map).length === 0) delete holder[field];
}

/** Removes generated labels from every label map and selector of the object. */
function pruneGeneratedLabels(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(pruneGeneratedLabels);
    return;
  }
  if (!isRecord(value)) return;
  for (const field of ["labels", "matchLabels"]) pruneMap(value, field, GENERATED_LABELS);
  if (isRecord(value.metadata)) delete value.metadata.creationTimestamp;
  for (const child of Object.values(value)) pruneGeneratedLabels(child);
}

function isSecret(kind: Pick<KindRef, "group" | "kind">): boolean {
  return kind.group === "" && kind.kind === "Secret";
}

/** A copy of `obj` of `kind` ready for comparison (see the file comment). */
export function normalize(obj: unknown, kind: Pick<KindRef, "group" | "kind">, options: NormalizeOptions): Record<string, unknown> {
  const copy = isRecord(obj) ? (structuredClone(obj) as Record<string, unknown>) : {};
  delete copy.status;
  const meta = copy.metadata;
  if (isRecord(meta)) {
    for (const field of METADATA_NOISE) delete meta[field];
    const generate = meta.generateName;
    if (typeof generate === "string" && generate && typeof meta.name === "string" && meta.name.startsWith(generate)) {
      meta.name = generate;
    }
    if (Array.isArray(meta.ownerReferences)) {
      for (const owner of meta.ownerReferences) if (isRecord(owner)) delete owner.uid;
    }
    pruneMap(meta, "annotations", NOISE_ANNOTATIONS);
  }
  pruneGeneratedLabels(copy);
  if (isSecret(kind)) {
    delete copy.data;
    delete copy.stringData;
  }
  if (options.hideDefaults) {
    const key = `${kind.group}/${kind.kind}`;
    const specs = kind.group === "" && kind.kind === "Pod" ? ["/spec"] : POD_SPECS;
    for (const spec of specs) {
      for (const [path, value] of POD_DEFAULTS) removeDefault(copy, `${spec}${path}`, value);
    }
    for (const [path, value] of KIND_DEFAULTS[key] ?? []) removeDefault(copy, path, value);
    for (const path of KIND_ASSIGNED[key] ?? []) {
      const segments = parsePath(path);
      if (segments) removeAt(copy, segments);
    }
  }
  for (const path of options.ignorePaths) {
    const segments = parsePath(path);
    if (segments) removeAt(copy, segments);
  }
  return copy;
}
