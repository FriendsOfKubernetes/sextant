// What the OpenShift section reads, field by field, as OpenShift's own types name them (github.com/openshift/api):
// Routes (route/v1/types.go), DeploymentConfigs (apps/v1/types.go, consts.go), BuildConfigs and Builds
// (build/v1/types.go, consts.go), ImageStreams (image/v1/types.go) and Projects (project/v1/types.go,
// annotations/annotations.go). Every free text from the cluster goes through `cleanText`, every URI through
// `safeUriText` (no userinfo, query or fragment). A Route's inline certificate fields and a BuildConfig's webhook
// secrets are never read as values: only whether they are set. Pure functions, no React.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import { cleanText, safeUriText } from "../../resources/uri";
import { fnv32a } from "../argo-workflows/model";
import type { Detected } from "../problems/model";

const { arr, get, num, record, str } = status;

export const ROUTE_GROUP = "route.openshift.io";
export const APPS_GROUP = "apps.openshift.io";
export const BUILD_GROUP = "build.openshift.io";
export const IMAGE_GROUP = "image.openshift.io";
export const PROJECT_GROUP = "project.openshift.io";
export const OPENSHIFT_GROUPS: ReadonlySet<string> = new Set([ROUTE_GROUP, APPS_GROUP, BUILD_GROUP, IMAGE_GROUP, PROJECT_GROUP]);

const k = (group: string, kind: string): KindRef => ({ group, version: "v1", kind });

export const ROUTE = k(ROUTE_GROUP, "Route");
export const DEPLOYMENT_CONFIG = k(APPS_GROUP, "DeploymentConfig");
export const BUILD_CONFIG = k(BUILD_GROUP, "BuildConfig");
export const BUILD = k(BUILD_GROUP, "Build");
export const IMAGE_STREAM = k(IMAGE_GROUP, "ImageStream");
export const PROJECT = k(PROJECT_GROUP, "Project");
export const REPLICATION_CONTROLLER: KindRef = { group: "", version: "v1", kind: "ReplicationController" };

export interface OpenShiftKind {
  kind: KindRef;
  order: number;
  /** Key under `openshift:sidebar`. */
  label: string;
  namespaced: boolean;
}

/**
 * The kinds of the section. ImageStreamTags are not among them: the API server serves them without `watch`
 * (`oc api-resources -o wide`), and tables and details follow objects by watching them; an ImageStream's details list
 * its tags instead, from the same fields an ImageStreamTag is built of (`status.tags`).
 */
export const OPENSHIFT_KINDS: OpenShiftKind[] = [
  { kind: ROUTE, order: 10, label: "routes", namespaced: true },
  { kind: DEPLOYMENT_CONFIG, order: 20, label: "deploymentConfigs", namespaced: true },
  { kind: BUILD_CONFIG, order: 30, label: "buildConfigs", namespaced: true },
  { kind: BUILD, order: 40, label: "builds", namespaced: true },
  { kind: IMAGE_STREAM, order: 50, label: "imageStreams", namespaced: true },
  { kind: PROJECT, order: 60, label: "projects", namespaced: false },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

export const openshiftKind = (kind: Pick<KindRef, "group" | "kind">): OpenShiftKind | undefined => OPENSHIFT_KINDS.find((d) => isKind(kind, d.kind));

/** The kinds the problems screen judges (category `openshift`). */
export const PROBLEM_KINDS = [ROUTE, DEPLOYMENT_CONFIG, BUILD, IMAGE_STREAM];
export const isProblemKind = (kind: Pick<KindRef, "group" | "kind">): boolean => isKind(kind, ...PROBLEM_KINDS);

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  since?: string;
}

function conditionsIn(value: unknown): Condition[] {
  return arr(value).map((c) => ({
    type: str(get(c, "type")) ?? "",
    status: str(get(c, "status")) ?? "Unknown",
    reason: str(get(c, "reason")) || undefined,
    message: cleanText(str(get(c, "message"))) || undefined,
    since: str(get(c, "lastTransitionTime")) || undefined,
  }));
}

export const conditionOf = (obj: KubeObject, type: string): Condition | undefined =>
  conditionsIn(get(obj, "status", "conditions")).find((c) => c.type === type);

const annotation = (obj: KubeObject, key: string): string | undefined => str(record(obj.metadata?.annotations)[key]) || undefined;
const label = (obj: KubeObject, key: string): string | undefined => str(record(obj.metadata?.labels)[key]) || undefined;

function time(value: string | undefined): number | undefined {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? undefined : t;
}

/** A reference `{kind, name, namespace}` (a trigger's `from`, a build's output). */
export interface Ref {
  kind?: string;
  name: string;
  namespace?: string;
}

function refIn(value: unknown): Ref | undefined {
  const name = str(get(value, "name"));
  if (!name) return undefined;
  return { kind: str(get(value, "kind")) || undefined, name, namespace: str(get(value, "namespace")) || undefined };
}

/** The ImageStream of an `ImageStreamTag` reference `<stream>:<tag>` (or of an `ImageStreamImage` `<stream>@<id>`). */
export function imageStreamOf(ref: Ref | undefined): string | undefined {
  if (!ref || (ref.kind !== "ImageStreamTag" && ref.kind !== "ImageStreamImage")) return undefined;
  return ref.name.split(/[:@]/)[0] || undefined;
}

// ---------- Route ----------

export type Termination = "edge" | "passthrough" | "reencrypt";

export interface RouteTls {
  termination?: string;
  /** `Allow`, `None` (the default: plain HTTP is refused) or `Redirect`. */
  insecure?: string;
  /** Whether the inline PEM fields are set; their values are never read. */
  certificate: boolean;
  key: boolean;
  caCertificate: boolean;
  destinationCACertificate: boolean;
  /** A Secret of the Route's namespace holding the certificate (`externalCertificate`, OpenShift 4.16+). */
  externalCertificate?: string;
}

export function routeTls(obj: KubeObject): RouteTls | undefined {
  const tls = get(obj, "spec", "tls");
  if (!tls || typeof tls !== "object") return undefined;
  const set = (field: string) => Boolean(str(get(tls, field)));
  return {
    termination: str(get(tls, "termination")) || undefined,
    insecure: str(get(tls, "insecureEdgeTerminationPolicy")) || undefined,
    certificate: set("certificate"),
    key: set("key"),
    caCertificate: set("caCertificate"),
    destinationCACertificate: set("destinationCACertificate"),
    externalCertificate: str(get(tls, "externalCertificate", "name")) || undefined,
  };
}

export interface RouteBackend {
  kind: string;
  name: string;
  /** 0–256; 100 when not set (`+kubebuilder:default=100`, route/v1/types.go). */
  weight: number;
  /** The share of the requests, in percent (0 when every weight is 0: the router answers 503). */
  percent: number;
  /** `spec.to` (else an alternate backend). */
  primary: boolean;
}

/** `spec.to` and `spec.alternateBackends`, with each share as the router weighs them. */
export function routeBackends(obj: KubeObject): RouteBackend[] {
  const one = (value: unknown, primary: boolean) => {
    const name = str(get(value, "name"));
    if (!name) return [];
    return [{ kind: str(get(value, "kind")) || "Service", name, weight: num(get(value, "weight")) ?? 100, percent: 0, primary }];
  };
  const list: RouteBackend[] = [...one(get(obj, "spec", "to"), true), ...arr(get(obj, "spec", "alternateBackends")).flatMap((b) => one(b, false))];
  const total = list.reduce((sum, b) => sum + b.weight, 0);
  return list.map((b) => ({ ...b, percent: total > 0 ? (b.weight / total) * 100 : 0 }));
}

/**
 * `spec.port.targetPort`: a number is an endpoint (pod) port, a name an endpoint port name — which is the Service
 * port's name (`endpointsForAlias` in pkg/router/template/template_helper.go of github.com/openshift/router matches
 * `PortName` or `Port` against it). Without it the router sends to every endpoint of the Service.
 */
export function routeTargetPort(obj: KubeObject): number | string | undefined {
  const value = get(obj, "spec", "port", "targetPort");
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return /^\d+$/.test(value) ? Number(value) : value;
  return undefined;
}

export interface RouterAdmission {
  routerName: string;
  host?: string;
  /** `True`, `False` or `Unknown` (no Admitted condition yet). */
  admitted: string;
  reason?: string;
  message?: string;
  since?: string;
  canonicalHostname?: string;
  wildcardPolicy?: string;
}

/** What each router says of the Route (`status.ingress[]`, its `Admitted` condition). */
export function routeAdmissions(obj: KubeObject): RouterAdmission[] {
  return arr(get(obj, "status", "ingress")).map((i) => {
    const admitted = conditionsIn(get(i, "conditions")).find((c) => c.type === "Admitted");
    return {
      routerName: str(get(i, "routerName")) || "",
      host: str(get(i, "host")) || undefined,
      admitted: admitted?.status ?? "Unknown",
      reason: admitted?.reason,
      message: admitted?.message,
      since: admitted?.since,
      canonicalHostname: str(get(i, "routerCanonicalHostname")) || undefined,
      wildcardPolicy: str(get(i, "wildcardPolicy")) || undefined,
    };
  });
}

export type RouteState = "admitted" | "rejected" | "pending";

export const ROUTE_TONE: Record<RouteState, Tone> = { admitted: "success", rejected: "danger", pending: "warning" };

/** Admitted by at least one router; else rejected by one; else no router has answered yet. */
export function routeState(obj: KubeObject): RouteState {
  const all = routeAdmissions(obj);
  if (all.some((a) => a.admitted === "True")) return "admitted";
  if (all.some((a) => a.admitted === "False")) return "rejected";
  return "pending";
}

/** The host: `spec.host`, else the one a router generated (a Route with `spec.subdomain` or none). */
export const routeHost = (obj: KubeObject): string | undefined =>
  str(get(obj, "spec", "host")) || routeAdmissions(obj).find((a) => a.host)?.host;

/** `https://host/path` (or `http://` without TLS): where the Route answers; the Route's own fields only. */
export function routeUrl(obj: KubeObject): string | undefined {
  const host = routeHost(obj);
  if (!host) return undefined;
  const wildcard = str(get(obj, "spec", "wildcardPolicy")) === "Subdomain";
  return `${routeTls(obj) ? "https" : "http"}://${wildcard ? `*.${host.replace(/^[^.]*\./, "")}` : host}${str(get(obj, "spec", "path")) ?? ""}`;
}

/** Why no router admitted it, in the router's words. */
export function routeReason(obj: KubeObject): string | undefined {
  const rejected = routeAdmissions(obj).find((a) => a.admitted === "False");
  return rejected ? rejected.message || rejected.reason : undefined;
}

// ---------- DeploymentConfig ----------

/** The label every ReplicationController of a DeploymentConfig carries (`MakeDeployment`, library-go pkg/apps/appsutil). */
export const DC_NAME_LABEL = "openshift.io/deployment-config.name";
/** The pod label `MakeDeployment` adds (`DeploymentConfigLabel`). */
export const DC_POD_LABEL = "deploymentconfig";
/** ReplicationController annotations the deployer writes (apps/v1/consts.go). */
export const PHASE_ANNOTATION = "openshift.io/deployment.phase";
export const VERSION_ANNOTATION = "openshift.io/deployment-config.latest-version";
export const STATUS_REASON_ANNOTATION = "openshift.io/deployment.status-reason";
export const DEPLOYER_POD_ANNOTATION = "openshift.io/deployer-pod.name";
export const CANCELLED_ANNOTATION = "openshift.io/deployment.cancelled";

export type DcState = "available" | "progressing" | "failed" | "cancelled" | "unavailable" | "paused" | "new";

export const DC_TONE: Record<DcState, Tone> = {
  available: "success",
  progressing: "warning",
  failed: "danger",
  cancelled: "muted",
  unavailable: "warning",
  paused: "muted",
  new: "muted",
};

/**
 * A DeploymentConfig's rollout state from its conditions (apps/v1/consts.go reasons): paused; `Progressing=False` with
 * `ProgressDeadlineExceeded` (the rollout failed, the controller went back to the last good version) or a
 * ReplicationController it could not create; a cancelled rollout; `Progressing` with
 * `NewReplicationControllerAvailable` (done) or another reason (under way); then `Available`. Never deployed: `new`.
 */
export function dcState(obj: KubeObject): DcState {
  if (get(obj, "spec", "paused") === true) return "paused";
  const progressing = conditionOf(obj, "Progressing");
  const available = conditionOf(obj, "Available");
  if (progressing?.reason === "ProgressDeadlineExceeded" || progressing?.reason === "ReplicationControllerCreateError") return "failed";
  if (conditionOf(obj, "ReplicaFailure")?.status === "True") return "failed";
  if (progressing?.reason === "RolloutCancelled") return "cancelled";
  if (progressing?.status === "True" && progressing.reason !== "NewReplicationControllerAvailable") return "progressing";
  if (available?.status === "True") return "available";
  if (available?.status === "False") return "unavailable";
  return (num(get(obj, "status", "latestVersion")) ?? 0) === 0 ? "new" : "progressing";
}

/** Why the rollout failed or waits, in the controller's words. */
export function dcReason(obj: KubeObject): string | undefined {
  for (const type of ["Progressing", "ReplicaFailure", "Available"]) {
    const c = conditionOf(obj, type);
    const bad = type === "ReplicaFailure" ? c?.status === "True" : c?.status === "False";
    if (bad && (c?.message || c?.reason)) return c.message || c.reason;
  }
  return cleanText(str(get(obj, "status", "details", "message")));
}

export interface DcReplicas {
  desired: number;
  current: number;
  ready: number;
  updated: number;
  available: number;
}

export function dcReplicas(obj: KubeObject): DcReplicas {
  const s = (f: string) => num(get(obj, "status", f)) ?? 0;
  return { desired: num(get(obj, "spec", "replicas")) ?? 0, current: s("replicas"), ready: s("readyReplicas"), updated: s("updatedReplicas"), available: s("availableReplicas") };
}

export const latestVersionOf = (obj: KubeObject): number => num(get(obj, "status", "latestVersion")) ?? 0;

/** The ReplicationController of a version: `<name>-<version>` (`LatestDeploymentNameForConfigAndVersion`). */
export const rcNameOf = (dc: KubeObject, version = latestVersionOf(dc)): string => `${dc.metadata?.name ?? ""}-${version}`;

export interface DcTrigger {
  type: string;
  /** ImageChange: redeploys on a new image (`automatic`), and for which containers. */
  automatic?: boolean;
  containers: string[];
  from?: Ref;
  lastTriggeredImage?: string;
}

export function dcTriggers(obj: KubeObject): DcTrigger[] {
  return arr(get(obj, "spec", "triggers")).map((t) => {
    const params = get(t, "imageChangeParams");
    return {
      type: str(get(t, "type")) ?? "",
      automatic: params ? get(params, "automatic") === true : undefined,
      containers: arr(get(params, "containerNames")).map(String),
      from: refIn(get(params, "from")),
      lastTriggeredImage: str(get(params, "lastTriggeredImage")) || undefined,
    };
  });
}

export interface DcStrategy {
  /** `Rolling` (the default), `Recreate` or `Custom`. */
  type: string;
  maxSurge?: string;
  maxUnavailable?: string;
  timeoutSeconds?: number;
  hooks: string[];
}

export function dcStrategy(obj: KubeObject): DcStrategy {
  const s = get(obj, "spec", "strategy");
  const type = str(get(s, "type")) || "Rolling";
  const params = type === "Recreate" ? get(s, "recreateParams") : type === "Rolling" ? get(s, "rollingParams") : undefined;
  const text = (v: unknown) => (typeof v === "number" || typeof v === "string" ? String(v) : undefined);
  return {
    type,
    maxSurge: text(get(params, "maxSurge")),
    maxUnavailable: text(get(params, "maxUnavailable")),
    timeoutSeconds: num(get(params, "timeoutSeconds")),
    hooks: ["pre", "mid", "post"].filter((h) => get(params, h) !== undefined && get(params, h) !== null),
  };
}

/** The causes of the latest rollout (`status.details.causes`): `ConfigChange`, `ImageChange` (with its image). */
export const dcCauses = (obj: KubeObject): string[] =>
  arr(get(obj, "status", "details", "causes")).map((c) => {
    const from = refIn(get(c, "imageTrigger", "from"));
    const type = str(get(c, "type")) ?? "";
    return from ? `${type}: ${from.name}` : type;
  });

export interface Rollout {
  name: string;
  version?: number;
  /** `New`, `Pending`, `Running`, `Complete` or `Failed` (the RC's `openshift.io/deployment.phase`). */
  phase?: string;
  reason?: string;
  cancelled: boolean;
  replicas: number;
  ready: number;
  deployerPod?: string;
  created?: string;
}

export const PHASE_TONE = (phase: string | undefined): Tone =>
  phase === "Complete" ? "success" : phase === "Failed" ? "danger" : phase === "Running" || phase === "Pending" ? "warning" : "muted";

/**
 * The rollouts of a DeploymentConfig from its ReplicationControllers: those it controls (owner reference) or that carry
 * its name label, newest version first.
 */
export function rolloutsOf(dc: KubeObject, rcs: readonly KubeObject[]): Rollout[] {
  const name = dc.metadata?.name;
  const uid = dc.metadata?.uid;
  return rcs
    .filter((rc) => {
      if (rc.metadata?.namespace !== dc.metadata?.namespace) return false;
      const owners = arr(rc.metadata?.ownerReferences);
      const owner = owners.find((o) => get(o, "controller") === true);
      if (owner) return str(get(owner, "kind")) === "DeploymentConfig" && (uid ? str(get(owner, "uid")) === uid : str(get(owner, "name")) === name);
      return label(rc, DC_NAME_LABEL) === name;
    })
    .map((rc) => {
      const version = Number(annotation(rc, VERSION_ANNOTATION));
      return {
        name: rc.metadata?.name ?? "",
        version: Number.isFinite(version) ? version : undefined,
        phase: annotation(rc, PHASE_ANNOTATION),
        reason: cleanText(annotation(rc, STATUS_REASON_ANNOTATION)),
        cancelled: (annotation(rc, CANCELLED_ANNOTATION) ?? "").toLowerCase() === "true",
        replicas: num(get(rc, "spec", "replicas")) ?? 0,
        ready: num(get(rc, "status", "readyReplicas")) ?? 0,
        deployerPod: annotation(rc, DEPLOYER_POD_ANNOTATION),
        created: str(rc.metadata?.creationTimestamp),
      };
    })
    .sort((a, b) => (b.version ?? -1) - (a.version ?? -1) || b.name.localeCompare(a.name));
}

/**
 * Whether "Rollout latest" may be sent, as `oc rollout latest` decides: not for a paused config, nor while the
 * latest version's ReplicationController has not ended (`IsTerminatedDeployment`). `undefined`: allowed. The core
 * checks the same again right before sending.
 */
export function rolloutBlock(dc: KubeObject, rcs: readonly KubeObject[] | undefined): "paused" | "inProgress" | undefined {
  if (get(dc, "spec", "paused") === true) return "paused";
  const latest = rcs?.find((rc) => rc.metadata?.name === rcNameOf(dc));
  const phase = latest ? annotation(latest, PHASE_ANNOTATION) : undefined;
  if (latest && phase !== "Complete" && phase !== "Failed") return "inProgress";
  return undefined;
}

// ---------- BuildConfig and Build ----------

/** Builds of a BuildConfig carry its name as a label (`BuildConfigLabel`, build/v1/consts.go), cut to 63 characters. */
export const BC_LABEL = "openshift.io/build-config.name";
export const BC_ANNOTATION = "openshift.io/build-config.name";
export const BUILD_NUMBER_ANNOTATION = "openshift.io/build.number";
export const BUILD_POD_ANNOTATION = "openshift.io/build.pod-name";
export const BC_PAUSED_ANNOTATION = "openshift.io/build-config.paused";

/** A label value as `LabelValue` (pkg/build/buildutil) cuts it: at most 63 characters, ending alphanumeric. */
export function labelValue(name: string): string {
  let value = name.slice(0, 63);
  while (value && !/^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/.test(value)) value = value.slice(0, -1);
  return value;
}

/**
 * The build pod's name: `openshift.io/build.pod-name`, else `GetBuildPodName` (pkg/build/buildutil of
 * openshift-controller-manager, `naming.GetPodName` of library-go): `<build>-build`, or past 63 characters the build's
 * name cut to 48, the FNV-1a hash of the name and `-build`.
 */
export function buildPodName(build: KubeObject): string | undefined {
  const name = build.metadata?.name;
  const annotated = annotation(build, BUILD_POD_ANNOTATION);
  if (annotated) return annotated;
  if (!name) return undefined;
  const plain = `${name}-build`;
  if (plain.length <= 63) return plain;
  return `${name.slice(0, 63 - 10 - "build".length)}-${fnv32a(name).toString(16).padStart(8, "0")}-build`;
}

export const buildConfigOf = (build: KubeObject): string | undefined =>
  str(get(build, "status", "config", "name")) || annotation(build, BC_ANNOTATION) || label(build, BC_LABEL);

export function buildNumber(build: KubeObject): number | undefined {
  const n = Number(annotation(build, BUILD_NUMBER_ANNOTATION));
  return Number.isFinite(n) && annotation(build, BUILD_NUMBER_ANNOTATION) !== undefined ? n : undefined;
}

export type BuildPhase = "New" | "Pending" | "Running" | "Complete" | "Failed" | "Error" | "Cancelled";

export const buildPhase = (build: KubeObject): string => str(get(build, "status", "phase")) || "New";

export const BUILD_TONE = (phase: string): Tone =>
  phase === "Complete" ? "success" : phase === "Failed" || phase === "Error" ? "danger" : phase === "Cancelled" ? "muted" : "warning";

export const isFailedBuild = (build: KubeObject): boolean => ["Failed", "Error"].includes(buildPhase(build));

/** The build's duration in ms: `status.duration` (nanoseconds), else from its start to its end. */
export function buildDurationMs(build: KubeObject, now?: number): number | undefined {
  const ns = num(get(build, "status", "duration"));
  if (ns !== undefined && ns > 0) return ns / 1e6;
  const start = time(str(get(build, "status", "startTimestamp")));
  const end = time(str(get(build, "status", "completionTimestamp"))) ?? (["New", "Pending", "Running"].includes(buildPhase(build)) ? now : undefined);
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
}

/** Why a build failed, in the build controller's words: `status.message`, else `status.reason`. */
export const buildReason = (build: KubeObject): string | undefined =>
  cleanText(str(get(build, "status", "message"))) || str(get(build, "status", "reason")) || undefined;

export interface BuildSource {
  /** `Git`, `Dockerfile`, `Binary`, `Image` or `None`. */
  type?: string;
  /** The Git URI without userinfo, query or fragment. */
  uri?: string;
  ref?: string;
  contextDir?: string;
  /** An inline Dockerfile is set (its text is in the YAML). */
  dockerfile: boolean;
  /** The Secret that clones the source (its name only). */
  secret?: string;
}

/** `spec.source` of a BuildConfig or a Build. */
export function buildSource(obj: KubeObject): BuildSource {
  const src = get(obj, "spec", "source");
  return {
    type: str(get(src, "type")) || undefined,
    uri: safeUriText(str(get(src, "git", "uri"))),
    ref: str(get(src, "git", "ref")) || undefined,
    contextDir: str(get(src, "contextDir")) || undefined,
    dockerfile: Boolean(str(get(src, "dockerfile"))),
    secret: str(get(src, "sourceSecret", "name")) || undefined,
  };
}

export interface BuildStrategy {
  /** `Source`, `Docker`, `Custom` or `JenkinsPipeline`. */
  type?: string;
  /** The builder image (`from`) of a Source, Docker or Custom strategy. */
  from?: Ref;
}

export function buildStrategy(obj: KubeObject): BuildStrategy {
  const s = get(obj, "spec", "strategy");
  const type = str(get(s, "type")) || undefined;
  const params = get(s, "sourceStrategy") ?? get(s, "dockerStrategy") ?? get(s, "customStrategy");
  return { type, from: refIn(get(params, "from")) };
}

/** `spec.output.to`: an `ImageStreamTag` or a `DockerImage`. */
export const buildOutput = (obj: KubeObject): Ref | undefined => refIn(get(obj, "spec", "output", "to"));

/**
 * The BuildConfig's triggers by type (`GitHub`, `Generic`, `GitLab`, `Bitbucket`, `ImageChange`, `ConfigChange`, the
 * deprecated lowercase ones too). A webhook trigger's secret is never read; an ImageChange trigger's image is.
 */
export function bcTriggers(obj: KubeObject): { type: string; from?: Ref }[] {
  return arr(get(obj, "spec", "triggers")).map((t) => ({ type: str(get(t, "type")) ?? "", from: refIn(get(t, "imageChange", "from")) }));
}

export const bcPaused = (obj: KubeObject): boolean => (annotation(obj, BC_PAUSED_ANNOTATION) ?? "").toLowerCase() === "true";

/** The builds of a BuildConfig among `builds` (its config reference, annotation or label), newest number first. */
export function buildsOf(bc: KubeObject, builds: readonly KubeObject[]): KubeObject[] {
  const name = bc.metadata?.name;
  return builds
    .filter((b) => b.metadata?.namespace === bc.metadata?.namespace && buildConfigOf(b) === name)
    .sort((a, b) => (buildNumber(b) ?? -1) - (buildNumber(a) ?? -1) || (b.metadata?.name ?? "").localeCompare(a.metadata?.name ?? ""));
}

/** What started a build (`spec.triggeredBy[].message`). */
export const triggeredBy = (build: KubeObject): string[] =>
  arr(get(build, "spec", "triggeredBy"))
    .map((c) => cleanText(str(get(c, "message"))))
    .filter((m): m is string => Boolean(m));

// ---------- ImageStream ----------

export interface StreamTag {
  name: string;
  /** Where the tag points (`spec.tags[].from`): a `DockerImage`, another `ImageStreamTag`, … */
  from?: Ref;
  scheduled: boolean;
  referencePolicy?: string;
  /** The current image (`status.tags[].items[0]`). */
  image?: string;
  dockerImageReference?: string;
  created?: string;
  generation?: number;
  /** Images the tag pointed to (newest first, the current one included). */
  history: number;
  /** `ImportSuccess=False`: the last import of the tag failed. */
  importError?: { reason?: string; message?: string; since?: string };
}

/** The tags of an ImageStream: of the spec and of the status, merged by name, sorted. */
export function streamTags(obj: KubeObject): StreamTag[] {
  const tags = new Map<string, StreamTag>();
  const of = (name: string): StreamTag => {
    let tag = tags.get(name);
    if (!tag) tags.set(name, (tag = { name, scheduled: false, history: 0 }));
    return tag;
  };
  for (const t of arr(get(obj, "spec", "tags"))) {
    const name = str(get(t, "name"));
    if (!name) continue;
    const tag = of(name);
    tag.from = refIn(get(t, "from"));
    tag.scheduled = get(t, "importPolicy", "scheduled") === true;
    tag.referencePolicy = str(get(t, "referencePolicy", "type")) || undefined;
  }
  for (const t of arr(get(obj, "status", "tags"))) {
    const name = str(get(t, "tag"));
    if (!name) continue;
    const tag = of(name);
    const items = arr(get(t, "items"));
    const latest = items[0];
    tag.image = str(get(latest, "image")) || undefined;
    tag.dockerImageReference = str(get(latest, "dockerImageReference")) || undefined;
    tag.created = str(get(latest, "created")) || undefined;
    tag.generation = num(get(latest, "generation"));
    tag.history = items.length;
    const failed = conditionsIn(get(t, "conditions")).find((c) => c.type === "ImportSuccess" && c.status === "False");
    if (failed) tag.importError = { reason: failed.reason, message: failed.message, since: failed.since };
  }
  return [...tags.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const failedImports = (obj: KubeObject): StreamTag[] => streamTags(obj).filter((t) => t.importError);

/** `status.dockerImageRepository` (inside the cluster) and `publicDockerImageRepository` (from outside). */
export const streamRepositories = (obj: KubeObject) => ({
  internal: str(get(obj, "status", "dockerImageRepository")) || undefined,
  public: str(get(obj, "status", "publicDockerImageRepository")) || undefined,
});

// ---------- Project ----------

/** Annotations of annotations/annotations.go and project/v1/types.go. */
export const DISPLAY_NAME_ANNOTATION = "openshift.io/display-name";
export const DESCRIPTION_ANNOTATION = "openshift.io/description";
export const REQUESTER_ANNOTATION = "openshift.io/requester";
export const NODE_SELECTOR_ANNOTATION = "openshift.io/node-selector";

export const projectInfo = (obj: KubeObject) => ({
  displayName: cleanText(annotation(obj, DISPLAY_NAME_ANNOTATION)),
  description: cleanText(annotation(obj, DESCRIPTION_ANNOTATION)),
  requester: annotation(obj, REQUESTER_ANNOTATION),
  nodeSelector: annotation(obj, NODE_SELECTOR_ANNOTATION),
  phase: str(get(obj, "status", "phase")) || undefined,
});

// ---------- Problems ----------

/** A Route no router admitted counts after this long (a router takes seconds to answer a new Route). */
export const ROUTE_GRACE_MS = 2 * 60_000;
/** A failing tag import counts after this long (imports are retried; one failure can pass). */
export const IMPORT_GRACE_MS = 5 * 60_000;
/** A failed Build is a problem for a day after it ended. */
export const FAILED_BUILD_MS = 24 * 3600_000;

/** When a build ended: `completionTimestamp`, else its start, else its creation. */
export function buildEndedAt(build: KubeObject): string | undefined {
  for (const value of [str(get(build, "status", "completionTimestamp")), str(get(build, "status", "startTimestamp")), str(build.metadata?.creationTimestamp)])
    if (time(value) !== undefined) return value;
  return undefined;
}

/**
 * The problems of an OpenShift object: a Route no router admitted (after a grace, from its rejection or its creation);
 * a DeploymentConfig whose rollout failed (`ProgressDeadlineExceeded`, or a ReplicationController it could not
 * create); a Build that failed or errored, for a day after it ended (a later build of the same BuildConfig tells it
 * instead: `across.ts`); an ImageStream with a tag whose import fails (after a grace). `now` only for the table filter.
 */
export function openshiftProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject, now?: number): Detected[] {
  if (obj.metadata?.deletionTimestamp) return [];
  if (isKind(kind, ROUTE)) {
    const state = routeState(obj);
    if (state === "admitted") return [];
    const rejected = routeAdmissions(obj).find((a) => a.admitted === "False");
    return [
      {
        reason: rejected?.reason || "NotAdmitted",
        group: "notAdmitted",
        message: routeReason(obj),
        since: rejected?.since ?? str(obj.metadata?.creationTimestamp),
        graceMs: ROUTE_GRACE_MS,
        notify: true,
      },
    ];
  }
  if (isKind(kind, DEPLOYMENT_CONFIG)) {
    if (dcState(obj) !== "failed") return [];
    const progressing = conditionOf(obj, "Progressing");
    const failure = conditionOf(obj, "ReplicaFailure");
    const c = progressing?.status === "False" ? progressing : failure?.status === "True" ? failure : progressing;
    return [{ reason: c?.reason || "RolloutFailed", group: "rolloutFailed", message: dcReason(obj), since: c?.since, notify: true }];
  }
  if (isKind(kind, BUILD)) {
    if (!isFailedBuild(obj)) return [];
    const ended = buildEndedAt(obj);
    const at = time(ended);
    const until = at === undefined ? undefined : at + FAILED_BUILD_MS;
    if (until !== undefined && now !== undefined && Number.isFinite(now) && now >= until) return [];
    return [
      {
        reason: str(get(obj, "status", "reason")) || (buildPhase(obj) === "Error" ? "BuildError" : "BuildFailed"),
        group: "buildFailed",
        message: cleanText(str(get(obj, "status", "message"))),
        since: ended,
        until,
        notify: true,
      },
    ];
  }
  if (isKind(kind, IMAGE_STREAM)) {
    const failed = failedImports(obj);
    if (failed.length === 0) return [];
    const first = failed[0]!;
    const since = failed.map((t) => t.importError?.since).filter((s): s is string => time(s) !== undefined).sort()[0];
    return [
      {
        reason: "ImportFailed",
        group: "importFailed",
        // The image registry's answer names the image it could not import.
        message: first.importError?.message || first.importError?.reason,
        since,
        graceMs: IMPORT_GRACE_MS,
        notify: true,
      },
    ];
  }
  return [];
}

/** Whether the table's "Only problems" filter shows the object (no grace; a failed Build however long ago). */
export const isProblem = (obj: KubeObject, kind: Pick<KindRef, "group" | "kind">): boolean =>
  isKind(kind, BUILD) ? isFailedBuild(obj) : openshiftProblems(kind, obj).length > 0;
