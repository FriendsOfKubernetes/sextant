// What the Argo CD objects say, read the way the Argo CD UI shows it: sync and health of an Application, its sources
// and destination, the sync history, the resources it manages, and the patches of the actions. No React here.
import type { KindRef, KubeObject, ObjectRef } from "../../api";
import { kindFromApiVersion, status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, record, str } = status;

export const ARGO_GROUP = "argoproj.io";
export const APPLICATION: KindRef = { group: ARGO_GROUP, version: "v1alpha1", kind: "Application" };
export const APPLICATION_SET: KindRef = { group: ARGO_GROUP, version: "v1alpha1", kind: "ApplicationSet" };
export const APP_PROJECT: KindRef = { group: ARGO_GROUP, version: "v1alpha1", kind: "AppProject" };

export const isApplication = (kind: Pick<KindRef, "group" | "kind">): boolean =>
  kind.group === ARGO_GROUP && kind.kind === "Application";

/** The address Argo CD gives the cluster it runs in. */
export const IN_CLUSTER_SERVER = "https://kubernetes.default.svc";
export const IN_CLUSTER_NAME = "in-cluster";

/** Annotation that makes the application controller compare the app again (`normal`) or regenerate its manifests
 * first (`hard`); the controller removes it once done. */
export const REFRESH_ANNOTATION = "argocd.argoproj.io/refresh";
export type RefreshKind = "normal" | "hard";

/** Name recorded as the initiator of the syncs started here (`operation.initiatedBy.username`). */
export const SYNC_INITIATOR = "sextant";

// ---------- Application ----------

export function syncStatus(app: KubeObject): string | undefined {
  return str(get(app, "status", "sync", "status"));
}

export function healthStatus(app: KubeObject): string | undefined {
  return str(get(app, "status", "health", "status"));
}

/** Phase of the last or current operation: Running, Terminating, Succeeded, Failed, Error. */
export function operationPhase(app: KubeObject): string | undefined {
  return str(get(app, "status", "operationState", "phase"));
}

/** A sync (or another operation) is under way: it can be terminated, and a new sync must wait. */
export function operationRunning(app: KubeObject): boolean {
  const phase = operationPhase(app);
  if (phase === "Running" || phase === "Terminating") return true;
  // Asked for and not finished: the controller removes `operation` when the operation ends.
  return get(app, "operation") != null;
}

/** The synced revision(s): one for a single source, one per source otherwise. */
export function revisions(app: KubeObject): string[] {
  const one = str(get(app, "status", "sync", "revision"));
  if (one) return [one];
  return arr(get(app, "status", "sync", "revisions")).filter((r): r is string => typeof r === "string" && r !== "");
}

/** A Git commit as Argo CD shows it (first 7 characters); a tag or a chart version stays whole. */
export function shortRevision(revision: string): string {
  return /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 7) : revision;
}

export interface Destination {
  server?: string;
  name?: string;
  namespace?: string;
}

export function destinationOf(value: unknown): Destination {
  return {
    server: str(get(value, "server")),
    name: str(get(value, "name")),
    namespace: str(get(value, "namespace")),
  };
}

/** The cluster of a destination: its name, `in-cluster` for Argo CD's own cluster, else the server address. */
export function clusterOf(dest: Destination): string {
  if (dest.name) return dest.name;
  if (dest.server === IN_CLUSTER_SERVER) return IN_CLUSTER_NAME;
  return dest.server ?? "";
}

/** Whether the resources of `dest` live in the cluster Argo CD runs in (the one Sextant shows them from). */
export function isInCluster(dest: Destination): boolean {
  return dest.name === IN_CLUSTER_NAME || (!dest.name && dest.server === IN_CLUSTER_SERVER);
}

/** `in-cluster/sextant-argo`, `*\/*`. */
export function destinationText(dest: Destination): string {
  const cluster = clusterOf(dest);
  return dest.namespace ? `${cluster}/${dest.namespace}` : cluster;
}

export function applicationDestination(app: KubeObject): Destination {
  return destinationOf(get(app, "spec", "destination"));
}

export interface Source {
  repoURL?: string;
  path?: string;
  chart?: string;
  targetRevision?: string;
  ref?: string;
}

function sourceOf(value: unknown): Source {
  return {
    repoURL: str(get(value, "repoURL")),
    path: str(get(value, "path")),
    chart: str(get(value, "chart")),
    targetRevision: str(get(value, "targetRevision")),
    ref: str(get(value, "ref")),
  };
}

/** `spec.source`, or every entry of `spec.sources` of a multi-source app. */
export function sourcesOf(app: KubeObject): Source[] {
  const many = arr(get(app, "spec", "sources"));
  if (many.length > 0) return many.map(sourceOf);
  const one = get(app, "spec", "source");
  return one ? [sourceOf(one)] : [];
}

export function isMultiSource(app: KubeObject): boolean {
  return arr(get(app, "spec", "sources")).length > 0;
}

/** Color of an Argo CD sync status. */
export function syncTone(value: string): Tone {
  if (value === "Synced") return "success";
  if (value === "OutOfSync") return "warning";
  return "muted";
}

/** Color of an Argo CD health status. */
export function healthTone(value: string): Tone {
  switch (value) {
    case "Healthy":
      return "success";
    case "Degraded":
      return "danger";
    case "Progressing":
    case "Missing":
      return "warning";
    default:
      return "muted"; // Suspended, Unknown
  }
}

/** Color of an operation phase. */
export function phaseTone(value: string): Tone {
  if (value === "Succeeded") return "success";
  if (value === "Failed" || value === "Error") return "danger";
  return "warning";
}

// ---------- Sync history ----------

export interface HistoryEntry {
  id: number | undefined;
  revisions: string[];
  deployedAt: string | undefined;
  /** `username` of the initiator; `null` when the controller synced by itself (automated). */
  initiatedBy: string | null | undefined;
  sources: Source[];
}

/** `status.history`, newest first. */
export function syncHistory(app: KubeObject): HistoryEntry[] {
  return arr(get(app, "status", "history"))
    .map((entry): HistoryEntry => {
      const one = str(get(entry, "revision"));
      const many = arr(get(entry, "revisions")).filter((r): r is string => typeof r === "string");
      const by = get(entry, "initiatedBy");
      const username = str(get(by, "username"));
      const source = get(entry, "source");
      return {
        id: num(get(entry, "id")),
        revisions: one ? [one] : many,
        deployedAt: str(get(entry, "deployedAt")),
        initiatedBy: username ?? (get(by, "automated") === true ? null : undefined),
        sources: source ? [sourceOf(source)] : arr(get(entry, "sources")).map(sourceOf),
      };
    })
    .reverse();
}

// ---------- Managed resources and their descendants ----------

export interface ManagedResource {
  group: string;
  version: string;
  kind: string;
  namespace: string | null;
  name: string;
  sync: string | undefined;
  health: string | undefined;
}

/** `status.resources`: what the app manages, with the sync and (when Argo CD keeps it there) health of each. */
export function managedResources(app: KubeObject): ManagedResource[] {
  return arr(get(app, "status", "resources")).map((r) => ({
    group: str(get(r, "group")) ?? "",
    version: str(get(r, "version")) ?? "",
    kind: str(get(r, "kind")) ?? "",
    namespace: str(get(r, "namespace")) || null,
    name: str(get(r, "name")) ?? "",
    sync: str(get(r, "status")),
    health: str(get(r, "health", "status")),
  }));
}

/** Kinds whose objects own others the tree shows: what each one creates. */
const CHILD_KINDS: Record<string, KindRef[]> = {
  "apps/Deployment": [{ group: "apps", version: "v1", kind: "ReplicaSet" }],
  "apps/ReplicaSet": [{ group: "", version: "v1", kind: "Pod" }],
  "apps/StatefulSet": [{ group: "", version: "v1", kind: "Pod" }],
  "apps/DaemonSet": [{ group: "", version: "v1", kind: "Pod" }],
  "batch/CronJob": [{ group: "batch", version: "v1", kind: "Job" }],
  "batch/Job": [{ group: "", version: "v1", kind: "Pod" }],
};

const keyOf = (group: string, kind: string) => `${group}/${kind}`;

/**
 * The kinds to list to find the descendants of `resources` (a Deployment needs its ReplicaSets and their Pods), each
 * with the namespaces to list them in. Sorted, so the result can be compared by value.
 */
export function descendantKinds(resources: ManagedResource[]): { kind: KindRef; namespaces: string[] }[] {
  const wanted = new Map<string, { kind: KindRef; namespaces: Set<string> }>();
  const visit = (group: string, kind: string, namespace: string) => {
    for (const child of CHILD_KINDS[keyOf(group, kind)] ?? []) {
      const key = keyOf(child.group, child.kind);
      const entry = wanted.get(key) ?? { kind: child, namespaces: new Set<string>() };
      if (entry.namespaces.has(namespace)) continue;
      entry.namespaces.add(namespace);
      wanted.set(key, entry);
      visit(child.group, child.kind, namespace);
    }
  };
  for (const r of resources) if (r.namespace) visit(r.group, r.kind, r.namespace);
  return [...wanted.values()]
    .map((e) => ({ kind: e.kind, namespaces: [...e.namespaces].sort() }))
    .sort((a, b) => keyOf(a.kind.group, a.kind.kind).localeCompare(keyOf(b.kind.group, b.kind.kind)));
}

export interface TreeNode {
  ref: ObjectRef;
  /** The managed resource (top level only). */
  managed?: ManagedResource;
  /** The live object (descendants only). */
  obj?: KubeObject;
  children: TreeNode[];
}

/** Whether `obj` is owned by the object `group/kind/name` of its own namespace. */
function ownedBy(obj: KubeObject, group: string, kind: string, name: string, uid?: string): boolean {
  return arr(obj.metadata?.ownerReferences).some((o) => {
    if (uid && str(get(o, "uid"))) return str(get(o, "uid")) === uid;
    return (
      str(get(o, "kind")) === kind &&
      str(get(o, "name")) === name &&
      kindFromApiVersion(str(get(o, "apiVersion")) ?? "", kind).group === group
    );
  });
}

function kindOfObject(obj: KubeObject, fallback: KindRef): KindRef {
  const apiVersion = str(obj.apiVersion);
  const kind = str(obj.kind);
  if (!apiVersion || !kind) return fallback;
  return kindFromApiVersion(apiVersion, kind);
}

/**
 * The managed resources with their descendants found among `objects` (by kind, as `descendantKinds` asked for) by
 * `ownerReferences`: Deployment → ReplicaSet → Pod, Job → Pod, … Children are sorted by name.
 */
export function resourceTree(resources: ManagedResource[], objects: Map<string, KubeObject[]>): TreeNode[] {
  const childrenOf = (group: string, kind: string, namespace: string | null, name: string, uid?: string, depth = 0) => {
    if (!namespace || depth > 4) return [];
    const nodes: TreeNode[] = [];
    for (const childKind of CHILD_KINDS[keyOf(group, kind)] ?? []) {
      for (const obj of objects.get(keyOf(childKind.group, childKind.kind)) ?? []) {
        if (obj.metadata?.namespace !== namespace || !ownedBy(obj, group, kind, name, uid)) continue;
        const ref: ObjectRef = { kind: kindOfObject(obj, childKind), namespace, name: obj.metadata?.name ?? "" };
        nodes.push({
          ref,
          obj,
          children: childrenOf(childKind.group, childKind.kind, namespace, ref.name, obj.metadata?.uid, depth + 1),
        });
      }
    }
    return nodes.sort((a, b) => a.ref.name.localeCompare(b.ref.name));
  };
  return resources.map((managed) => ({
    ref: {
      kind: { group: managed.group, version: managed.version, kind: managed.kind },
      namespace: managed.namespace,
      name: managed.name,
    },
    managed,
    children: childrenOf(managed.group, managed.kind, managed.namespace, managed.name),
  }));
}

// ---------- ApplicationSet, AppProject ----------

/** Applications an ApplicationSet generated (`status.resources`). */
export function generatedApplications(appSet: KubeObject): { namespace: string | null; name: string }[] {
  return arr(get(appSet, "status", "resources"))
    .filter((r) => str(get(r, "kind")) === "Application")
    .map((r) => ({ namespace: str(get(r, "namespace")) || null, name: str(get(r, "name")) ?? "" }));
}

export function generatedCount(appSet: KubeObject): number {
  return num(get(appSet, "status", "resourcesCount")) ?? generatedApplications(appSet).length;
}

/** Types of the generators (`list`, `git`, `clusters`, `matrix`, …). */
export function generatorTypes(appSet: KubeObject): string[] {
  return arr(get(appSet, "spec", "generators")).flatMap((g) => Object.keys(record(g)).filter((k) => k !== "selector"));
}

export function projectDestinations(project: KubeObject): Destination[] {
  return arr(get(project, "spec", "destinations")).map(destinationOf);
}

export function projectSources(project: KubeObject): string[] {
  return arr(get(project, "spec", "sourceRepos")).filter((s): s is string => typeof s === "string");
}

// ---------- Patches of the actions (sent with `api.resources.patch`, merge) ----------

export interface SyncOptions {
  /** `null`: each source's own `targetRevision`. */
  revision: string | null;
  prune: boolean;
  dryRun: boolean;
}

/**
 * Starts a sync, as `argocd app sync` does: the operation carries the app's sync options (`CreateNamespace=true`, …)
 * and retry policy, which the controller does not take from the spec for a manual sync.
 */
export function syncPatch(app: KubeObject, options: SyncOptions): Record<string, unknown> {
  const sync: Record<string, unknown> = { prune: options.prune, dryRun: options.dryRun };
  if (options.revision) sync.revision = options.revision;
  const syncOptions = arr(get(app, "spec", "syncPolicy", "syncOptions"));
  if (syncOptions.length > 0) sync.syncOptions = syncOptions;
  const operation: Record<string, unknown> = { initiatedBy: { username: SYNC_INITIATOR }, sync };
  const retry = get(app, "spec", "syncPolicy", "retry");
  if (retry && typeof retry === "object") operation.retry = retry;
  return { operation };
}

export function refreshPatch(kind: RefreshKind): Record<string, unknown> {
  return { metadata: { annotations: { [REFRESH_ANNOTATION]: kind } } };
}

/** Asks the controller to stop the running operation (what `argocd app terminate-op` does). */
export function terminatePatch(): Record<string, unknown> {
  return { status: { operationState: { phase: "Terminating" } } };
}

/** The revision a sync starts from by default: the (only) source's `targetRevision`, `HEAD` when it has none. */
export function defaultRevision(app: KubeObject): string {
  return sourcesOf(app)[0]?.targetRevision || "HEAD";
}
