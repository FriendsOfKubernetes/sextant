// What the Flux section reads from Flux objects: the kinds it knows, their Ready condition, revision and suspension,
// the source an object uses, the objects a Kustomization or HelmRelease applied (`status.inventory`) and which
// objects use a source. Pure functions, no React.
import type { KindRef, KubeObject, ObjectRef } from "../../api";
import { kindFromApiVersion, status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, str } = status;

export const SOURCE_GROUP = "source.toolkit.fluxcd.io";
export const KUSTOMIZE_GROUP = "kustomize.toolkit.fluxcd.io";
export const HELM_GROUP = "helm.toolkit.fluxcd.io";
export const IMAGE_GROUP = "image.toolkit.fluxcd.io";
export const NOTIFICATION_GROUP = "notification.toolkit.fluxcd.io";

/** One Flux kind: the version registered (served by current Flux; the cluster may prefer another) and its entry. */
export interface FluxKind {
  kind: KindRef;
  /** Position in the sidebar section `flux`. */
  order: number;
  /** Key under `flux:sidebar`. */
  label: string;
  /** A source of artifacts (a Kustomization or HelmRelease may refer to it). */
  source?: boolean;
}

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const GIT_REPOSITORY = k(SOURCE_GROUP, "v1", "GitRepository");
export const OCI_REPOSITORY = k(SOURCE_GROUP, "v1", "OCIRepository");
export const HELM_REPOSITORY = k(SOURCE_GROUP, "v1", "HelmRepository");
export const HELM_CHART = k(SOURCE_GROUP, "v1", "HelmChart");
export const BUCKET = k(SOURCE_GROUP, "v1", "Bucket");
export const KUSTOMIZATION = k(KUSTOMIZE_GROUP, "v1", "Kustomization");
export const HELM_RELEASE = k(HELM_GROUP, "v2", "HelmRelease");
export const IMAGE_REPOSITORY = k(IMAGE_GROUP, "v1", "ImageRepository");
export const IMAGE_POLICY = k(IMAGE_GROUP, "v1", "ImagePolicy");
export const IMAGE_UPDATE_AUTOMATION = k(IMAGE_GROUP, "v1", "ImageUpdateAutomation");
export const PROVIDER = k(NOTIFICATION_GROUP, "v1beta3", "Provider");
export const ALERT = k(NOTIFICATION_GROUP, "v1beta3", "Alert");
export const RECEIVER = k(NOTIFICATION_GROUP, "v1", "Receiver");

/** Sidebar order: Sources, Kustomizations, HelmReleases, Image Automation, Notifications. */
export const FLUX_KINDS: FluxKind[] = [
  { kind: GIT_REPOSITORY, order: 10, label: "gitRepositories", source: true },
  { kind: OCI_REPOSITORY, order: 11, label: "ociRepositories", source: true },
  { kind: HELM_REPOSITORY, order: 12, label: "helmRepositories", source: true },
  { kind: HELM_CHART, order: 13, label: "helmCharts", source: true },
  { kind: BUCKET, order: 14, label: "buckets", source: true },
  { kind: KUSTOMIZATION, order: 20, label: "kustomizations" },
  { kind: HELM_RELEASE, order: 30, label: "helmReleases" },
  { kind: IMAGE_REPOSITORY, order: 40, label: "imageRepositories" },
  { kind: IMAGE_POLICY, order: 41, label: "imagePolicies" },
  { kind: IMAGE_UPDATE_AUTOMATION, order: 42, label: "imageUpdateAutomations" },
  { kind: ALERT, order: 50, label: "alerts" },
  { kind: PROVIDER, order: 51, label: "providers" },
  { kind: RECEIVER, order: 52, label: "receivers" },
];

const same = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) =>
  a.group === b.group && a.kind === b.kind;

/** The Flux kind of `kind` (any version), if it is one. */
export function fluxKind(kind: Pick<KindRef, "group" | "kind">): FluxKind | undefined {
  return FLUX_KINDS.find((f) => same(f.kind, kind));
}

export function isKind(kind: Pick<KindRef, "group" | "kind">, ...kinds: KindRef[]): boolean {
  return kinds.some((other) => same(kind, other));
}

// ---------- Ready, revision, suspension ----------

/** The `Ready` condition, if the object has one (notification Providers and Alerts have no status). */
function readyCondition(obj: KubeObject): unknown {
  return arr(get(obj, "status", "conditions")).find((c) => get(c, "type") === "Ready");
}

/** "True" | "False" | "Unknown" of the Ready condition. */
export function readyStatus(obj: KubeObject): string | undefined {
  return str(get(readyCondition(obj), "status"));
}

export function readyReason(obj: KubeObject): string | undefined {
  return str(get(readyCondition(obj), "reason"));
}

/** The message of the Ready condition: what was applied, or what failed. */
export function readyMessage(obj: KubeObject): string | undefined {
  return str(get(readyCondition(obj), "message"));
}

/** True green, False red, Unknown (reconciling) yellow. */
export function readyTone(value: string): Tone {
  if (value === "True") return "success";
  if (value === "False") return "danger";
  return "warning";
}

/**
 * The revision the object is at: a source's artifact, what a Kustomization applied, the chart version a HelmRelease
 * installed, the image an ImagePolicy chose, the last scan of an ImageRepository, the commit an
 * ImageUpdateAutomation pushed (or the revision it looked at).
 */
export function revisionOf(obj: KubeObject): string | undefined {
  const latestRef = get(obj, "status", "latestRef");
  const latestImage = latestRef
    ? `${str(get(latestRef, "name")) ?? ""}${str(get(latestRef, "tag")) ? `:${str(get(latestRef, "tag"))}` : ""}`
    : undefined;
  const release = arr(get(obj, "status", "history"))[0];
  return (
    str(get(obj, "status", "artifact", "revision")) ??
    str(get(obj, "status", "lastAppliedRevision")) ??
    str(get(release, "chartVersion")) ??
    latestImage ??
    str(get(obj, "status", "latestImage")) ??
    str(get(obj, "status", "lastScanResult", "revision")) ??
    str(get(obj, "status", "lastPushCommit")) ??
    str(get(obj, "status", "observedSourceRevision"))
  );
}

export function isSuspended(obj: KubeObject): boolean {
  return get(obj, "spec", "suspend") === true;
}

// ---------- References between objects ----------

/** An object another one names: its kind (with the version to ask for) and where it is. */
export interface FluxRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | null;
}

function apiVersionOf(kind: KindRef): string {
  return kind.group ? `${kind.group}/${kind.version}` : kind.version;
}

/** A `sourceRef`/`chartRef`-like field as a reference; the namespace defaults to the object's own. */
function refFrom(field: unknown, obj: KubeObject, group: string): FluxRef | undefined {
  const kind = str(get(field, "kind"));
  const name = str(get(field, "name"));
  if (!kind || !name) return undefined;
  const known = fluxKind({ group, kind });
  const apiVersion = str(get(field, "apiVersion")) ?? (known ? apiVersionOf(known.kind) : `${group}/v1`);
  return { apiVersion, kind, name, namespace: str(get(field, "namespace")) ?? obj.metadata?.namespace ?? null };
}

/**
 * The source an object takes its artifact from: `spec.sourceRef` (Kustomization, HelmChart,
 * ImageUpdateAutomation), `spec.chart.spec.sourceRef` or `spec.chartRef` (HelmRelease).
 */
export function sourceRefOf(obj: KubeObject): FluxRef | undefined {
  return (
    refFrom(get(obj, "spec", "sourceRef"), obj, SOURCE_GROUP) ??
    refFrom(get(obj, "spec", "chart", "spec", "sourceRef"), obj, SOURCE_GROUP) ??
    refFrom(get(obj, "spec", "chartRef"), obj, SOURCE_GROUP)
  );
}

/** The HelmChart the helm-controller made for a HelmRelease (`status.helmChart` = "namespace/name"). */
export function helmChartOf(obj: KubeObject): FluxRef | undefined {
  const value = str(get(obj, "status", "helmChart"));
  const slash = value?.indexOf("/") ?? -1;
  if (!value || slash < 0) return undefined;
  return {
    apiVersion: apiVersionOf(HELM_CHART),
    kind: "HelmChart",
    namespace: value.slice(0, slash),
    name: value.slice(slash + 1),
  };
}

/** Whether `obj` (a Kustomization, HelmRelease, HelmChart, …) takes its artifact from `source`. */
export function usesSource(obj: KubeObject, source: KubeObject): boolean {
  const ref = sourceRefOf(obj);
  if (!ref) return false;
  const kind = kindFromApiVersion(ref.apiVersion, ref.kind);
  return (
    kind.group === kindFromApiVersion(source.apiVersion ?? "", source.kind ?? "").group &&
    ref.kind === source.kind &&
    ref.name === source.metadata?.name &&
    ref.namespace === (source.metadata?.namespace ?? null)
  );
}

/**
 * The objects listed in `status.inventory.entries` (Kustomization; HelmRelease since Flux 2.8). An entry id is
 * `<namespace>_<name>_<group>_<Kind>` (cli-utils' object metadata: an empty namespace for cluster-scoped objects, an
 * empty group for the core API, ":" of a name written as "__"); `v` is the version.
 */
export function inventoryOf(obj: KubeObject): ObjectRef[] {
  const refs: ObjectRef[] = [];
  for (const entry of arr(get(obj, "status", "inventory", "entries"))) {
    const id = str(get(entry, "id"));
    const version = str(get(entry, "v")) ?? "v1";
    const fields = id?.split("_") ?? [];
    if (fields.length < 4) continue;
    const namespace = fields[0] ?? "";
    const kind = fields[fields.length - 1] ?? "";
    const group = fields[fields.length - 2] ?? "";
    const name = fields.slice(1, -2).join("_").replaceAll("__", ":");
    // "a__b" (a colon) splits into "a", "", "b": joined back above, then turned into ":".
    if (!name || !kind) continue;
    refs.push({ kind: { group, version, kind }, namespace: namespace || null, name });
  }
  return refs;
}

/** Label selector of what helm-controller created for a HelmRelease. */
export function helmReleaseSelector(obj: KubeObject): string {
  const { name = "", namespace = "" } = obj.metadata ?? {};
  return `helm.toolkit.fluxcd.io/name=${name},helm.toolkit.fluxcd.io/namespace=${namespace}`;
}
