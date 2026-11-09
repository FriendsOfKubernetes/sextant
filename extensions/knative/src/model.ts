// What the extension reads from Knative Serving objects (`serving.knative.dev`): the kinds it knows, their conditions,
// a Service's URL and revisions, the traffic split, a Revision's replicas and why an object is not ready, in plain
// words. Sextant's former built-in view's model (#213, ADR-0101), ported unchanged, with its problem detector
// (`knativeProblems`) and table filter (`isProblem`) kept as the reference the manifest's declarative rules, "Only
// problems" and columns are tested against (model.test.ts). Pure functions; texts are keys of the extension's
// catalogs with their values.
import type { KubeObject, UiTone } from "@sextant/extension-sdk";

export const get = (obj: unknown, ...path: (string | number)[]): unknown => {
  let at: unknown = obj;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
};
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const labelsOf = (obj: KubeObject): Record<string, string> => record(obj.metadata?.labels) as Record<string, string>;

/** A kind as the SDK names it. */
export interface KindRef {
  group: string;
  version: string;
  kind: string;
}

export type KindOf = Pick<KindRef, "group" | "kind">;

export const SERVING_GROUP = "serving.knative.dev";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const KSERVICE = k(SERVING_GROUP, "v1", "Service");
export const CONFIGURATION = k(SERVING_GROUP, "v1", "Configuration");
export const REVISION = k(SERVING_GROUP, "v1", "Revision");
export const ROUTE = k(SERVING_GROUP, "v1", "Route");
export const DOMAIN_MAPPING = k(SERVING_GROUP, "v1beta1", "DomainMapping");

export interface KnativeKind {
  kind: KindRef;
  order: number;
  /** The sidebar label's key. */
  label: string;
}

export const KNATIVE_KINDS: readonly KnativeKind[] = [
  { kind: KSERVICE, order: 10, label: "services" },
  { kind: CONFIGURATION, order: 20, label: "configurations" },
  { kind: REVISION, order: 30, label: "revisions" },
  { kind: ROUTE, order: 40, label: "routes" },
  { kind: DOMAIN_MAPPING, order: 50, label: "domainMappings" },
];

export const sameKind = (a: KindOf, b: KindOf) => a.group === b.group && a.kind === b.kind;

export function knativeKind(kind: KindOf): KnativeKind | undefined {
  return KNATIVE_KINDS.find((d) => sameKind(d.kind, kind));
}

/** The kind an `apiVersion` and a kind name stand for (the core group's "v1" is the group ""). */
export function kindOfApiVersion(apiVersion: string | undefined, kind: string): KindRef {
  const [group, version] = apiVersion?.includes("/") ? (apiVersion.split("/") as [string, string]) : ["", apiVersion ?? "v1"];
  return { group, version, kind };
}

// ---------- Conditions ----------

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export function conditionsOf(obj: KubeObject): Condition[] {
  return arr(get(obj, "status", "conditions")).flatMap((c) => {
    const type = str(get(c, "type"));
    const value = str(get(c, "status"));
    if (!type || !value) return [];
    return [
      {
        type,
        status: value,
        reason: str(get(c, "reason")),
        message: str(get(c, "message")),
        lastTransitionTime: str(get(c, "lastTransitionTime")),
      },
    ];
  });
}

export const conditionOf = (obj: KubeObject, type: string) => conditionsOf(obj).find((c) => c.type === type);

/** "True" | "False" | "Unknown" of Ready; `undefined` before the controller wrote any status. */
export const readyStatus = (obj: KubeObject) => conditionOf(obj, "Ready")?.status;

export type Health = "ready" | "progressing" | "failed" | "unknown";

/** Ready=True → ready, False → failed, Unknown → still progressing; no condition yet → unknown. */
export function healthOf(obj: KubeObject): Health {
  switch (readyStatus(obj)) {
    case "True":
      return "ready";
    case "False":
      return "failed";
    case "Unknown":
      return "progressing";
    default:
      return "unknown";
  }
}

export const HEALTH_TONE: Record<Health, UiTone> = { ready: "success", progressing: "warning", failed: "danger", unknown: "muted" };

/**
 * The condition that says why an object is not ready: the first False condition other than Ready (it names the part
 * that failed: ConfigurationsReady, RoutesReady, ContainerHealthy, ResourcesAvailable…), else Ready itself when not
 * True. `undefined` for a ready object.
 */
export function failingCondition(obj: KubeObject): Condition | undefined {
  const all = conditionsOf(obj);
  const ready = all.find((c) => c.type === "Ready");
  if (ready?.status === "True") return undefined;
  // `Active` False is a revision scaled to zero, never the failure.
  return all.find((c) => c.status === "False" && c.type !== "Ready" && c.type !== "Active") ?? (ready?.status === "False" ? ready : undefined);
}

/** The built-in tables' "Only problems": Ready is False. */
export function isProblem(obj: KubeObject): boolean {
  return readyStatus(obj) === "False";
}

// ---------- Fields ----------

export interface TrafficTarget {
  revisionName?: string;
  configurationName?: string;
  latestRevision: boolean;
  percent?: number;
  tag?: string;
  url?: string;
}

function trafficOf(list: unknown): TrafficTarget[] {
  return arr(list).map((t) => ({
    revisionName: str(get(t, "revisionName")),
    configurationName: str(get(t, "configurationName")),
    latestRevision: get(t, "latestRevision") === true,
    percent: num(get(t, "percent")),
    tag: str(get(t, "tag")),
    url: str(get(t, "url")),
  }));
}

/** The split in effect (`status.traffic`), else what was asked (`spec.traffic`) with `asked` set. */
export function trafficSplit(obj: KubeObject): { targets: TrafficTarget[]; asked: boolean } {
  const actual = trafficOf(get(obj, "status", "traffic"));
  if (actual.length > 0) return { targets: actual, asked: false };
  return { targets: trafficOf(get(obj, "spec", "traffic")), asked: true };
}

/** "name 90% · name 10%" for a table cell (tags in parentheses). */
export function trafficSummary(obj: KubeObject, latestLabel: string): string {
  return trafficSplit(obj)
    .targets.filter((t) => (t.percent ?? 0) > 0)
    .map((t) => `${t.revisionName ?? (t.latestRevision ? latestLabel : (t.configurationName ?? "?"))} ${t.percent ?? 0}%`)
    .join(" · ");
}

export interface ServiceFields {
  url?: string;
  address?: string;
  latestCreated?: string;
  latestReady?: string;
  observedGeneration?: number;
}

export function serviceFields(obj: KubeObject): ServiceFields {
  return {
    url: str(get(obj, "status", "url")),
    address: str(get(obj, "status", "address", "url")),
    latestCreated: str(get(obj, "status", "latestCreatedRevisionName")),
    latestReady: str(get(obj, "status", "latestReadyRevisionName")),
    observedGeneration: num(get(obj, "status", "observedGeneration")),
  };
}

export interface RevisionFields {
  configuration?: string;
  service?: string;
  generation?: string;
  actualReplicas?: number;
  desiredReplicas?: number;
  images: string[];
  concurrency?: number;
  timeoutSeconds?: number;
  routingState?: string;
}

export function revisionFields(obj: KubeObject): RevisionFields {
  const labels = labelsOf(obj);
  const images = arr(get(obj, "status", "containerStatuses"))
    .map((c) => str(get(c, "imageDigest")))
    .filter((v): v is string => Boolean(v));
  const specImages = arr(get(obj, "spec", "containers"))
    .map((c) => str(get(c, "image")))
    .filter((v): v is string => Boolean(v));
  return {
    configuration: labels["serving.knative.dev/configuration"],
    service: labels["serving.knative.dev/service"],
    generation: labels["serving.knative.dev/configurationGeneration"],
    actualReplicas: num(get(obj, "status", "actualReplicas")),
    desiredReplicas: num(get(obj, "status", "desiredReplicas")),
    images: images.length > 0 ? images : specImages,
    concurrency: num(get(obj, "spec", "containerConcurrency")),
    timeoutSeconds: num(get(obj, "spec", "timeoutSeconds")),
    routingState: labels["serving.knative.dev/routingState"],
  };
}

/** The ksvc a DomainMapping points at (`spec.ref`). */
export function mappingRef(obj: KubeObject): { apiVersion?: string; kind?: string; name?: string; namespace?: string } {
  const ref = get(obj, "spec", "ref");
  return { apiVersion: str(get(ref, "apiVersion")), kind: str(get(ref, "kind")), name: str(get(ref, "name")), namespace: str(get(ref, "namespace")) };
}

/** Owned by a Knative Service (a Configuration or Route the Service made). */
export function ownedByService(obj: KubeObject): boolean {
  return arr(obj.metadata?.ownerReferences).some((o) => get(o, "kind") === "Service" && (str(get(o, "apiVersion")) ?? "").startsWith(`${SERVING_GROUP}/`));
}

// ---------- Plain words ----------

export interface Phrase {
  /** The text's key, under `explain.` (Serving) or `eventing.explain.` (Eventing). */
  key: string;
  params?: Record<string, string>;
}

/** Why an object is (not) ready, in plain words. */
export function explain(kind: KindOf, obj: KubeObject): Phrase | undefined {
  const health = healthOf(obj);
  const f = serviceFields(obj);
  const failing = failingCondition(obj);
  const reason = failing?.reason ?? failing?.type ?? "";
  if (sameKind(kind, REVISION)) {
    if (health === "ready") {
      return conditionOf(obj, "Active")?.status === "False" ? { key: "revisionScaledToZero" } : { key: "revisionReady" };
    }
    if (health === "progressing") return { key: "revisionProgressing" };
    if (health === "unknown") return undefined;
    if (failing?.type === "ContainerHealthy") return { key: "revisionContainerUnhealthy", params: { reason } };
    if (failing?.type === "ResourcesAvailable") return { key: "revisionResourcesUnavailable", params: { reason } };
    return { key: "revisionFailed", params: { reason } };
  }
  if (health === "ready") return f.url ? { key: "readyAt", params: { url: f.url } } : { key: "ready" };
  if (health === "progressing") return { key: "progressing" };
  if (health === "unknown") return undefined;
  if (failing?.type === "ConfigurationsReady" || (sameKind(kind, CONFIGURATION) && f.latestCreated && f.latestCreated !== f.latestReady)) {
    const revision = f.latestCreated ?? "";
    return f.latestReady
      ? { key: "revisionFailedTrafficStays", params: { revision, ready: f.latestReady, reason } }
      : { key: "revisionFailedNoneReady", params: { revision, reason } };
  }
  if (failing?.type === "RoutesReady" || failing?.type === "AllTrafficAssigned" || failing?.type === "IngressReady") {
    return { key: "routeFailed", params: { reason } };
  }
  if (failing?.type === "DomainClaimed") return { key: "domainNotClaimed", params: { reason } };
  if (failing?.type === "CertificateProvisioned") return { key: "certificateFailed", params: { reason } };
  return { key: "notReady", params: { reason } };
}

// ---------- The built-in problems (the reference of the manifest's rules) ----------

/** What the built-in detector found: the reason, the message, when it began, its grace. */
export interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs: number;
  notify: boolean;
}

/** A rollout the next reconcile fixes passes quietly. */
export const KNATIVE_GRACE_MS = 2 * 60_000;

/** A not-ready object's problem, from its failing condition. */
export function notReadyProblem(obj: KubeObject): Detected {
  const failing = failingCondition(obj);
  return {
    reason: failing?.reason ?? "NotReady",
    group: "notReady",
    // Knative's message names the revision that failed ("Revision \"hello-00002\" failed with message: …").
    message: failing?.message,
    since: failing?.lastTransitionTime,
    graceMs: KNATIVE_GRACE_MS,
    notify: true,
  };
}

/**
 * The built-in problems of Knative Serving: a Service that is not ready, and a Configuration of its own (one a Service
 * made is told through that Service). A Revision is not judged: the latest one's failure makes its Configuration and
 * Service not ready, so it counts once, there.
 */
export function servingProblems(kind: KindOf, obj: KubeObject): Detected[] {
  if (!sameKind(kind, KSERVICE) && !sameKind(kind, CONFIGURATION)) return [];
  if (sameKind(kind, CONFIGURATION) && ownedByService(obj)) return [];
  if (readyStatus(obj) !== "False") return [];
  return [notReadyProblem(obj)];
}
