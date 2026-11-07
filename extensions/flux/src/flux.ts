// What the extension reads from Flux objects, as Sextant's former built-in Flux view read it: the kinds it lists,
// their Ready condition, revision and suspension, the source an object uses, the objects a Kustomization or
// HelmRelease applied (`status.inventory`), which objects use a source, and Reconcile with source's merge patches. Pure
// functions, no DOM.
import type { KubeObject, RefInput } from "@sextant/extension-sdk";

export const SOURCE_GROUP = "source.toolkit.fluxcd.io";
export const KUSTOMIZE_GROUP = "kustomize.toolkit.fluxcd.io";
export const HELM_GROUP = "helm.toolkit.fluxcd.io";
export const IMAGE_GROUP = "image.toolkit.fluxcd.io";
export const NOTIFICATION_GROUP = "notification.toolkit.fluxcd.io";

export interface FluxKind {
  group: string;
  kind: string;
  /** Position in the sidebar section `flux`. */
  order: number;
  /** The key of its plural title (`sidebar.<label>`) and the suffix of its column ids. */
  label: string;
  /** Its icon in Sextant's set. */
  icon: string;
  /** A source of artifacts (a Kustomization or HelmRelease may refer to it). */
  source?: boolean;
  /**
   * It has Ready, Status and Revision columns (every kind does; notification Providers and Alerts of v1beta3 have no
   * status, so theirs stay empty).
   */
  status: boolean;
}

/** Sidebar order: sources, Kustomizations, HelmReleases, image automation, notifications. */
export const FLUX_KINDS: readonly FluxKind[] = [
  { group: SOURCE_GROUP, kind: "GitRepository", order: 10, label: "gitRepositories", icon: "gitRepository", source: true, status: true },
  { group: SOURCE_GROUP, kind: "OCIRepository", order: 11, label: "ociRepositories", icon: "ociRepository", source: true, status: true },
  { group: SOURCE_GROUP, kind: "HelmRepository", order: 12, label: "helmRepositories", icon: "helmRepository", source: true, status: true },
  { group: SOURCE_GROUP, kind: "HelmChart", order: 13, label: "helmCharts", icon: "fluxHelmChart", source: true, status: true },
  { group: SOURCE_GROUP, kind: "Bucket", order: 14, label: "buckets", icon: "bucket", source: true, status: true },
  { group: KUSTOMIZE_GROUP, kind: "Kustomization", order: 20, label: "kustomizations", icon: "kustomization", status: true },
  { group: HELM_GROUP, kind: "HelmRelease", order: 30, label: "helmReleases", icon: "fluxHelmRelease", status: true },
  { group: IMAGE_GROUP, kind: "ImageRepository", order: 40, label: "imageRepositories", icon: "imageRepository", status: true },
  { group: IMAGE_GROUP, kind: "ImagePolicy", order: 41, label: "imagePolicies", icon: "imagePolicy", status: true },
  { group: IMAGE_GROUP, kind: "ImageUpdateAutomation", order: 42, label: "imageUpdateAutomations", icon: "imageUpdateAutomation", status: true },
  { group: NOTIFICATION_GROUP, kind: "Alert", order: 50, label: "alerts", icon: "alert", status: true },
  { group: NOTIFICATION_GROUP, kind: "Provider", order: 51, label: "providers", icon: "provider", status: true },
  { group: NOTIFICATION_GROUP, kind: "Receiver", order: 52, label: "receivers", icon: "receiver", status: true },
];

/** Kinds whose Ready=False is a problem: the sources with an artifact and what applies them. */
export const PROBLEM_KINDS = ["GitRepository", "OCIRepository", "HelmRepository", "Bucket", "Kustomization", "HelmRelease"] as const;

/** Ready=False reasons of a Flux object still working (waiting for a dependency, reconciling), not of a failure. */
export const IN_PROGRESS_REASONS = ["DependencyNotReady", "Progressing", "ProgressingWithRetry", "ReconciliationInProgress"] as const;

export const fluxKind = (group: string | undefined, kind: string | undefined): FluxKind | undefined =>
  FLUX_KINDS.find((k) => k.group === group && k.kind === kind);

/** The API group of an `apiVersion` (`""` for the core group). */
export const groupOf = (apiVersion: string | undefined): string =>
  apiVersion && apiVersion.includes("/") ? apiVersion.slice(0, apiVersion.indexOf("/")) : "";

/** The version of an `apiVersion` (`v1` of `apps/v1` and of `v1`), or `undefined`. */
export const versionOf = (apiVersion: string | undefined): string | undefined =>
  apiVersion ? apiVersion.slice(apiVersion.indexOf("/") + 1) || undefined : undefined;

export const isKind = (obj: KubeObject, group: string, kind: string): boolean =>
  groupOf(obj.apiVersion) === group && obj.kind === kind;

// ---------- Reading fields ----------

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value at `keys` under `value`, or `undefined`. */
export function get(value: unknown, ...keys: (string | number)[]): unknown {
  let at = value;
  for (const key of keys) {
    if (typeof key === "number") {
      if (!Array.isArray(at)) return undefined;
      at = at[key];
    } else {
      if (!isRecord(at)) return undefined;
      at = at[key];
    }
  }
  return at;
}

export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A scalar as text (`prune: true` → "true"). */
export const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;

// ---------- Ready, revision, suspension ----------

function readyCondition(obj: KubeObject): unknown {
  return arr(get(obj, "status", "conditions")).find((c) => get(c, "type") === "Ready");
}

/** "True" | "False" | "Unknown" of the Ready condition. */
export const readyStatus = (obj: KubeObject): string | undefined => str(get(readyCondition(obj), "status"));
export const readyReason = (obj: KubeObject): string | undefined => str(get(readyCondition(obj), "reason"));
/** The message of the Ready condition: what was applied, or what failed. */
export const readyMessage = (obj: KubeObject): string | undefined => str(get(readyCondition(obj), "message"));

/** A tone of Sextant's UI kit (`ui.status`). */
export type Tone = "success" | "warning" | "danger";

/** True green, False red, Unknown (reconciling) yellow, as the built-in view and the Ready column tone it. */
export const readyTone = (value: string): Tone => (value === "True" ? "success" : value === "False" ? "danger" : "warning");

/**
 * The fields the revision is read from, the first with a value: a source's artifact, what a Kustomization applied, the
 * chart version a HelmRelease installed, the image an ImagePolicy chose (`latestImage`, else the tag of `latestRef`),
 * the last scan of an ImageRepository, the commit an ImageUpdateAutomation pushed (or the revision it looked at). The
 * Revision column reads the same paths.
 */
export const REVISION_PATHS = [
  ".status.artifact.revision",
  ".status.lastAppliedRevision",
  ".status.history[0].chartVersion",
  ".status.latestImage",
  ".status.latestRef.tag",
  ".status.lastScanResult.revision",
  ".status.lastPushCommit",
  ".status.observedSourceRevision",
] as const;

/** The revision the object is at; an ImagePolicy's `latestRef` as `name:tag`. */
export function revisionOf(obj: KubeObject): string | undefined {
  const latestRef = get(obj, "status", "latestRef");
  const tag = str(get(latestRef, "tag"));
  const latestImage = latestRef ? `${str(get(latestRef, "name")) ?? ""}${tag ? `:${tag}` : ""}` : undefined;
  return (
    str(get(obj, "status", "artifact", "revision")) ??
    str(get(obj, "status", "lastAppliedRevision")) ??
    str(get(obj, "status", "history", 0, "chartVersion")) ??
    (latestImage || undefined) ??
    str(get(obj, "status", "latestImage")) ??
    str(get(obj, "status", "lastScanResult", "revision")) ??
    str(get(obj, "status", "lastPushCommit")) ??
    str(get(obj, "status", "observedSourceRevision"))
  );
}

export const isSuspended = (obj: KubeObject): boolean => get(obj, "spec", "suspend") === true;

// ---------- References between objects ----------

/** An object another one names; its version when the reference gives one (else Sextant takes the kind's own). */
export interface FluxRef {
  group: string;
  version?: string;
  kind: string;
  name: string;
  namespace: string | null;
}

export const refInput = (r: FluxRef): RefInput => ({
  kind: r.version ? { group: r.group, version: r.version, kind: r.kind } : { group: r.group, kind: r.kind },
  namespace: r.namespace,
  name: r.name,
});

/** A `sourceRef`/`chartRef`-like field as a reference; the namespace defaults to the object's own. */
function refFrom(field: unknown, obj: KubeObject, group: string): FluxRef | undefined {
  const kind = str(get(field, "kind"));
  const name = str(get(field, "name"));
  if (!kind || !name) return undefined;
  const apiVersion = str(get(field, "apiVersion"));
  const version = versionOf(apiVersion);
  return {
    group: apiVersion ? groupOf(apiVersion) : group,
    ...(version ? { version } : {}),
    kind,
    name,
    namespace: str(get(field, "namespace")) ?? obj.metadata.namespace ?? null,
  };
}

/**
 * The source an object takes its artifact from: `spec.sourceRef` (Kustomization, HelmChart, ImageUpdateAutomation),
 * `spec.chart.spec.sourceRef` or `spec.chartRef` (HelmRelease).
 */
export function sourceRefOf(obj: KubeObject): FluxRef | undefined {
  return (
    refFrom(get(obj, "spec", "sourceRef"), obj, SOURCE_GROUP) ??
    refFrom(get(obj, "spec", "chart", "spec", "sourceRef"), obj, SOURCE_GROUP) ??
    refFrom(get(obj, "spec", "chartRef"), obj, SOURCE_GROUP)
  );
}

/** The fields the Source column reads the source's name from (its kind is the tooltip), as `sourceRefOf` does. */
export const SOURCE_NAME_PATHS = [".spec.sourceRef.name", ".spec.chart.spec.sourceRef.name", ".spec.chartRef.name"] as const;
export const SOURCE_KIND_PATHS = [".spec.sourceRef.kind", ".spec.chart.spec.sourceRef.kind", ".spec.chartRef.kind"] as const;

/** The HelmChart the helm-controller made for a HelmRelease (`status.helmChart` = "namespace/name"). */
export function helmChartOf(obj: KubeObject): FluxRef | undefined {
  const value = str(get(obj, "status", "helmChart"));
  const slash = value?.indexOf("/") ?? -1;
  if (!value || slash < 0) return undefined;
  return { group: SOURCE_GROUP, kind: "HelmChart", namespace: value.slice(0, slash), name: value.slice(slash + 1) };
}

/** Whether `obj` (a Kustomization, HelmRelease, …) takes its artifact from `source`. */
export function usesSource(obj: KubeObject, source: KubeObject): boolean {
  const ref = sourceRefOf(obj);
  return (
    ref !== undefined &&
    ref.group === groupOf(source.apiVersion) &&
    ref.kind === source.kind &&
    ref.name === source.metadata.name &&
    ref.namespace === (source.metadata.namespace ?? null)
  );
}

/** A reference by name to an object of `kind` in the namespace of `obj` (`providerRef`, `imageRepositoryRef`, `dependsOn`). */
export function localRef(obj: KubeObject, group: string, kind: string, field: unknown): FluxRef | undefined {
  const name = str(get(field, "name"));
  if (!name) return undefined;
  return { group, kind, name, namespace: str(get(field, "namespace")) ?? obj.metadata.namespace ?? null };
}

/**
 * The objects listed in `status.inventory.entries` (Kustomization; HelmRelease since Flux 2.8). An entry id is
 * `<namespace>_<name>_<group>_<Kind>` (cli-utils' object metadata: an empty namespace for cluster-scoped objects, an
 * empty group for the core API, ":" of a name written as "__"); `v` is the version, which the links open.
 */
export function inventoryOf(obj: KubeObject): FluxRef[] {
  const refs: FluxRef[] = [];
  for (const entry of arr(get(obj, "status", "inventory", "entries"))) {
    const fields = str(get(entry, "id"))?.split("_") ?? [];
    if (fields.length < 4) continue;
    const namespace = fields[0] ?? "";
    const kind = fields[fields.length - 1] ?? "";
    const group = fields[fields.length - 2] ?? "";
    // "a__b" (a colon) splits into "a", "", "b": joined back, then turned into ":".
    const name = fields.slice(1, -2).join("_").replaceAll("__", ":");
    if (!name || !kind) continue;
    const version = str(get(entry, "v"));
    refs.push({ group, ...(version ? { version } : {}), kind, namespace: namespace || null, name });
  }
  return refs;
}

/** Label selector of what helm-controller created for a HelmRelease. */
export function helmReleaseSelector(obj: KubeObject): string {
  const { name, namespace = "" } = obj.metadata;
  return `helm.toolkit.fluxcd.io/name=${name},helm.toolkit.fluxcd.io/namespace=${namespace}`;
}

/**
 * Where a HelmRelease's objects are: its target namespace (`spec.targetNamespace`, else its own), and its storage
 * namespace when that differs.
 */
export function helmReleaseNamespaces(obj: KubeObject): string[] {
  const own = obj.metadata.namespace ?? "";
  const target = str(get(obj, "spec", "targetNamespace")) ?? own;
  const storage = str(get(obj, "spec", "storageNamespace")) ?? str(get(obj, "status", "storageNamespace")) ?? own;
  return target === storage ? [target] : [target, storage];
}

/** Kinds a Helm chart usually creates; helm-controller labels them with the HelmRelease's name and namespace. */
export const LABELLED_KINDS: readonly { group: string; kind: string }[] = [
  { group: "apps", kind: "Deployment" },
  { group: "apps", kind: "StatefulSet" },
  { group: "apps", kind: "DaemonSet" },
  { group: "batch", kind: "Job" },
  { group: "batch", kind: "CronJob" },
  { group: "", kind: "Service" },
  { group: "", kind: "ConfigMap" },
  { group: "", kind: "Secret" },
  { group: "", kind: "ServiceAccount" },
  { group: "", kind: "PersistentVolumeClaim" },
  { group: "networking.k8s.io", kind: "Ingress" },
];

/** The same object whatever version names it. */
export const refKey = (r: FluxRef): string => `${r.group}/${r.kind}/${r.namespace ?? ""}/${r.name}`;

/** The object as a reference. */
export const refOf = (obj: KubeObject, fallback: { group: string; kind: string }): FluxRef => ({
  group: obj.apiVersion ? groupOf(obj.apiVersion) : fallback.group,
  ...(versionOf(obj.apiVersion) ? { version: versionOf(obj.apiVersion) } : {}),
  kind: obj.kind ?? fallback.kind,
  namespace: obj.metadata.namespace ?? null,
  name: obj.metadata.name,
});

// ---------- Changes ----------

/** The annotation every Flux controller watches: a new value asks it to reconcile now. */
export const REQUESTED_AT_ANNOTATION = "reconcile.fluxcd.io/requestedAt";

/**
 * Asks the controller to reconcile the object now: Reconcile with source's patch. Reconcile now, Suspend and Resume are
 * patches fixed in the manifest, which Sextant sends itself (`{{now}}` is the time it sends them).
 */
export const reconcilePatch = (now: Date) => ({ metadata: { annotations: { [REQUESTED_AT_ANNOTATION]: now.toISOString() } } });

/**
 * What to reconcile, in order, for "Reconcile with source": the source of a Kustomization; the chart source of a
 * HelmRelease and then its HelmChart (the chart is pulled again only when the HelmChart reconciles); the object last.
 */
export function withSourceOrder(obj: KubeObject, self: FluxRef): FluxRef[] {
  const release = isKind(obj, HELM_GROUP, "HelmRelease");
  const refs = [sourceRefOf(obj), release ? helmChartOf(obj) : undefined].filter((r): r is FluxRef => r !== undefined);
  const unique = refs.filter((r, i) => refs.findIndex((other) => refKey(other) === refKey(r)) === i);
  return [...unique, self];
}
