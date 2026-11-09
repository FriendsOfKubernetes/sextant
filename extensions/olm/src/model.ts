// What the extension reads from the Operator Lifecycle Manager's objects, field by field as OLM writes them
// (operator-framework/api, pkg/operators/v1alpha1/{subscription,clusterserviceversion,installplan,catalogsource}_types.go
// and pkg/operators/v1/{operatorgroup,operator}_types.go), and from OLM v1's ClusterExtension and ClusterCatalog
// (operator-framework/operator-controller, api/v1/{clusterextension,clustercatalog,common}_types.go). Sextant's former
// built-in view's model (ADR-0121), ported unchanged; the problem rules and table columns that replace its detectors
// are declarative in the manifest and checked against `olmProblems`/`isProblem` here by model.test.ts. Pure functions.
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

export const OLM_GROUP = "operators.coreos.com";
/** OLM v1 (operator-controller). */
export const OLM_V1_GROUP = "olm.operatorframework.io";

export interface KindOf {
  group: string;
  version: string;
  kind: string;
}

const k = (group: string, version: string, kind: string): KindOf => ({ group, version, kind });

export const SUBSCRIPTION = k(OLM_GROUP, "v1alpha1", "Subscription");
export const CSV = k(OLM_GROUP, "v1alpha1", "ClusterServiceVersion");
export const INSTALL_PLAN = k(OLM_GROUP, "v1alpha1", "InstallPlan");
export const CATALOG_SOURCE = k(OLM_GROUP, "v1alpha1", "CatalogSource");
export const OPERATOR_GROUP = k(OLM_GROUP, "v1", "OperatorGroup");
/** Cluster-scoped: the components OLM labelled for one operator (`status.components.refs`). */
export const OPERATOR = k(OLM_GROUP, "v1", "Operator");
export const CLUSTER_EXTENSION = k(OLM_V1_GROUP, "v1", "ClusterExtension");
export const CLUSTER_CATALOG = k(OLM_V1_GROUP, "v1", "ClusterCatalog");
export const DEPLOYMENT = k("apps", "v1", "Deployment");
export const CRD = k("apiextensions.k8s.io", "v1", "CustomResourceDefinition");
export const CONFIG_MAP = k("", "v1", "ConfigMap");
export const SERVICE = k("", "v1", "Service");
export const SERVICE_ACCOUNT = k("", "v1", "ServiceAccount");
export const NAMESPACE = k("", "v1", "Namespace");

/** The details sections of the manifest, one per kind, by contribution id. */
export const DETAILS: Record<string, KindOf> = {
  subscription: SUBSCRIPTION,
  csv: CSV,
  "install-plan": INSTALL_PLAN,
  "catalog-source": CATALOG_SOURCE,
  "operator-group": OPERATOR_GROUP,
  operator: OPERATOR,
  "cluster-extension": CLUSTER_EXTENSION,
  "cluster-catalog": CLUSTER_CATALOG,
};

/** Same group and kind: Knative Eventing has a `Subscription` too (messaging.knative.dev). */
export const isKind = (kind: { group: string; kind: string }, def: KindOf): boolean => kind.group === def.group && kind.kind === def.kind;

export interface Condition {
  status: string;
  reason?: string;
  message?: string;
  since?: string;
}

export function conditionOf(obj: KubeObject, type: string): Condition | undefined {
  const c = arr(get(obj, "status", "conditions")).find((x) => get(x, "type") === type);
  if (!c) return undefined;
  return {
    status: str(get(c, "status")) ?? "Unknown",
    reason: str(get(c, "reason")),
    message: str(get(c, "message")),
    since: str(get(c, "lastTransitionTime")),
  };
}

const isTrue = (obj: KubeObject, type: string) => conditionOf(obj, type)?.status === "True";
const strings = (value: unknown): string[] => arr(value).map(str).filter((s): s is string => s !== undefined);

/** A reference to another object in an OLM status (`corev1.ObjectReference`). */
export interface Ref {
  name: string;
  namespace?: string;
}

// ---------- Subscription ----------

export interface SubscriptionInfo {
  /** The package (`spec.name`). */
  packageName?: string;
  channel?: string;
  source?: string;
  sourceNamespace?: string;
  /** `spec.installPlanApproval`; OLM approves automatically unless it is `Manual`. */
  approval: string;
  startingCSV?: string;
  installedCSV?: string;
  currentCSV?: string;
  /** `status.state`: UpgradePending, UpgradeAvailable, AtLatestKnown, UpgradeFailed, or empty. */
  state?: string;
  /** The current InstallPlan: `status.installPlanRef`, else the older `status.installplan`. */
  installPlan?: Ref;
  lastUpdated?: string;
}

export function subscriptionInfo(sub: KubeObject): SubscriptionInfo {
  const ns = sub.metadata?.namespace;
  const ref = get(sub, "status", "installPlanRef");
  const old = get(sub, "status", "installplan");
  const planName = str(get(ref, "name")) ?? str(get(old, "name"));
  return {
    packageName: str(get(sub, "spec", "name")),
    channel: str(get(sub, "spec", "channel")),
    source: str(get(sub, "spec", "source")),
    sourceNamespace: str(get(sub, "spec", "sourceNamespace")),
    approval: str(get(sub, "spec", "installPlanApproval")) || "Automatic",
    startingCSV: str(get(sub, "spec", "startingCSV")),
    installedCSV: str(get(sub, "status", "installedCSV")) || undefined,
    currentCSV: str(get(sub, "status", "currentCSV")) || undefined,
    state: str(get(sub, "status", "state")) || undefined,
    installPlan: planName ? { name: planName, namespace: str(get(ref, "namespace")) ?? ns } : undefined,
    lastUpdated: str(get(sub, "status", "lastUpdated")),
  };
}

/** The installed CSV is not the one the catalog's channel leads to: an upgrade waits (installing, or for approval). */
export function upgradePending(sub: KubeObject): boolean {
  const { installedCSV, currentCSV } = subscriptionInfo(sub);
  return Boolean(installedCSV && currentCSV && installedCSV !== currentCSV);
}

export type SubscriptionState =
  | "resolutionFailed"
  | "installPlanFailed"
  | "upgradeFailed"
  | "waitingApproval"
  | "upgradePending"
  | "upgradeAvailable"
  | "atLatest"
  | "pending";

export const SUBSCRIPTION_TONE: Record<SubscriptionState, UiTone> = {
  resolutionFailed: "danger",
  installPlanFailed: "danger",
  upgradeFailed: "danger",
  waitingApproval: "warning",
  upgradePending: "warning",
  upgradeAvailable: "warning",
  atLatest: "success",
  pending: "neutral",
};

/** The condition behind a Subscription's state, whose message is the state's tooltip. */
export const STATE_CONDITION: Partial<Record<SubscriptionState, string>> = {
  resolutionFailed: "ResolutionFailed",
  installPlanFailed: "InstallPlanFailed",
  waitingApproval: "InstallPlanPending",
};

/**
 * A Subscription's state from its conditions (subscription_types.go `SubscriptionConditionType`) and `status.state`:
 * the resolver failed, its InstallPlan failed, it waits for an approval (`InstallPlanPending` with reason
 * `RequiresApproval` — the catalog operator puts the plan's phase into the reason, catalog/subscription/state.go
 * `CheckInstallPlanStatus`), an upgrade pending or available, at the latest known version.
 */
export function subscriptionState(sub: KubeObject): SubscriptionState {
  if (isTrue(sub, "ResolutionFailed")) return "resolutionFailed";
  if (isTrue(sub, "InstallPlanFailed")) return "installPlanFailed";
  const info = subscriptionInfo(sub);
  if (info.state === "UpgradeFailed") return "upgradeFailed";
  const pendingPlan = conditionOf(sub, "InstallPlanPending");
  if (pendingPlan?.status === "True" && pendingPlan.reason === "RequiresApproval") return "waitingApproval";
  if (info.state === "UpgradePending" || upgradePending(sub)) return "upgradePending";
  if (info.state === "UpgradeAvailable") return "upgradeAvailable";
  if (info.state === "AtLatestKnown") return "atLatest";
  return "pending";
}

export interface CatalogHealth {
  name: string;
  namespace?: string;
  healthy: boolean;
  lastUpdated?: string;
}

/** `status.catalogHealth`: the catalogs the resolver looked at for this Subscription. */
export function catalogHealthOf(sub: KubeObject): CatalogHealth[] {
  return arr(get(sub, "status", "catalogHealth")).map((h) => ({
    name: str(get(h, "catalogSourceRef", "name")) ?? "",
    namespace: str(get(h, "catalogSourceRef", "namespace")),
    healthy: get(h, "healthy") === true,
    lastUpdated: str(get(h, "lastUpdated")),
  }));
}

// ---------- ClusterServiceVersion ----------

/** The label OLM puts on the copy of a CSV in a target namespace, valued with the original's namespace. */
export const COPIED_LABEL = "olm.copiedFrom";
/** The OperatorGroup's namespace, annotated on every CSV it governs (pkg/operators/v1/operatorgroup_types.go). */
export const OPERATOR_NAMESPACE_ANNOTATION = "olm.operatorNamespace";
/** A label selector the API server applies: originals only, never the copies. */
export const NOT_COPIED_SELECTOR = `!${COPIED_LABEL}`;
/** The labels OLM puts on the Deployments of a CSV's install strategy (pkg/lib/ownerutil/util.go). */
export const OWNER_LABEL = "olm.owner";
export const OWNER_KIND_LABEL = "olm.owner.kind";

/**
 * Whether the CSV is a copy OLM keeps in a target namespace of its OperatorGroup, as OLM's own `IsCopied` decides.
 * A copy mirrors the original's phase; it is never a failure of its own.
 */
export function isCopy(csv: KubeObject): boolean {
  if (str(get(csv, "status", "reason")) === "Copied") return true;
  if (record(csv.metadata?.labels)[COPIED_LABEL] !== undefined) return true;
  const operatorNs = str(record(csv.metadata?.annotations)[OPERATOR_NAMESPACE_ANNOTATION]);
  return operatorNs !== undefined && operatorNs !== csv.metadata?.namespace;
}

/** The namespace of the original of a copy (the label, else the annotation); `undefined` for an original. */
export function copiedFrom(csv: KubeObject): string | undefined {
  if (!isCopy(csv)) return undefined;
  return str(record(csv.metadata?.labels)[COPIED_LABEL]) ?? str(record(csv.metadata?.annotations)[OPERATOR_NAMESPACE_ANNOTATION]);
}

export interface CsvInfo {
  phase?: string;
  reason?: string;
  message?: string;
  since?: string;
  displayName?: string;
  version?: string;
  replaces?: string;
  skips: string[];
  provider?: string;
  minKubeVersion?: string;
}

export function csvInfo(csv: KubeObject): CsvInfo {
  return {
    phase: str(get(csv, "status", "phase")) || undefined,
    reason: str(get(csv, "status", "reason")) || undefined,
    message: str(get(csv, "status", "message")) || undefined,
    since: str(get(csv, "status", "lastTransitionTime")),
    displayName: str(get(csv, "spec", "displayName")),
    version: str(get(csv, "spec", "version")),
    replaces: str(get(csv, "spec", "replaces")),
    skips: strings(get(csv, "spec", "skips")),
    provider: str(get(csv, "spec", "provider", "name")),
    minKubeVersion: str(get(csv, "spec", "minKubeVersion")),
  };
}

/** `ClusterServiceVersionPhase` (clusterserviceversion_types.go). */
export function phaseTone(phase: string | undefined): UiTone {
  switch (phase) {
    case "Succeeded":
      return "success";
    case "Failed":
      return "danger";
    case "Pending":
    case "InstallReady":
    case "Installing":
      return "warning";
    case "Replacing":
    case "Deleting":
      return "muted";
    default:
      return "neutral";
  }
}

export interface Requirement {
  group: string;
  version: string;
  kind: string;
  name: string;
  status: string;
  message?: string;
}

/** `status.requirementStatus`: what the CSV needs (CRDs, APIs, permissions) and whether each is there. */
export function requirementsOf(csv: KubeObject): Requirement[] {
  return arr(get(csv, "status", "requirementStatus")).map((r) => ({
    group: str(get(r, "group")) ?? "",
    version: str(get(r, "version")) ?? "",
    kind: str(get(r, "kind")) ?? "",
    name: str(get(r, "name")) ?? "",
    status: str(get(r, "status")) ?? "",
    message: str(get(r, "message")),
  }));
}

/** `StatusReason` of a requirement: Present, NotPresent, PresentNotSatisfied, PresentNotAvailable. */
export function requirementTone(value: string): UiTone {
  if (value === "Present") return "success";
  if (value === "PresentNotAvailable") return "warning";
  if (value === "NotPresent" || value === "PresentNotSatisfied") return "danger";
  return "neutral";
}

export const unmetRequirements = (csv: KubeObject): Requirement[] => requirementsOf(csv).filter((r) => r.status !== "Present");

export interface CrdDescription {
  name: string;
  version?: string;
  kind?: string;
  displayName?: string;
}

/** `spec.customresourcedefinitions.owned` / `.required` (`CRDDescription`). */
export function crdsOf(csv: KubeObject, which: "owned" | "required"): CrdDescription[] {
  return arr(get(csv, "spec", "customresourcedefinitions", which)).map((c) => ({
    name: str(get(c, "name")) ?? "",
    version: str(get(c, "version")),
    kind: str(get(c, "kind")),
    displayName: str(get(c, "displayName")),
  }));
}

/** The names of the Deployments of the install strategy (`spec.install.spec.deployments[].name`, strategy `deployment`). */
export function strategyDeployments(csv: KubeObject): string[] {
  const strategy = str(get(csv, "spec", "install", "strategy"));
  if (strategy !== undefined && strategy !== "deployment") return [];
  return arr(get(csv, "spec", "install", "spec", "deployments"))
    .map((d) => str(get(d, "name")))
    .filter((s): s is string => Boolean(s));
}

export interface InstallMode {
  type: string;
  supported: boolean;
}

/** `spec.installModes`: OwnNamespace, SingleNamespace, MultiNamespace, AllNamespaces. */
export function installModesOf(csv: KubeObject): InstallMode[] {
  return arr(get(csv, "spec", "installModes")).map((m) => ({ type: str(get(m, "type")) ?? "", supported: get(m, "supported") === true }));
}

/**
 * The selector of the Deployments OLM made for the CSV, or `undefined` when the CSV's name cannot be a label value
 * (over 63 characters: OLM could not have labelled them either).
 */
export function deploymentSelector(csv: KubeObject): string | undefined {
  const name = csv.metadata?.name;
  if (!name || name.length > 63) return undefined;
  return `${OWNER_LABEL}=${name},${OWNER_KIND_LABEL}=ClusterServiceVersion`;
}

/** A Deployment's `ready/desired`, as Sextant writes it. */
export function readyOfDesired(obj: KubeObject): string {
  const desired = num(get(obj, "spec", "replicas")) ?? 0;
  const ready = num(get(obj, "status", "readyReplicas")) ?? 0;
  return `${ready}/${desired}`;
}

// ---------- InstallPlan ----------

export interface InstallPlanInfo {
  phase?: string;
  /** `spec.approval`: Automatic or Manual. */
  approval?: string;
  approved: boolean;
  csvNames: string[];
  source?: string;
  sourceNamespace?: string;
  startTime?: string;
  message?: string;
  /** The `Installed` condition when it is False: why the plan failed. */
  failure?: Condition;
}

export function installPlanInfo(ip: KubeObject): InstallPlanInfo {
  const installed = conditionOf(ip, "Installed");
  return {
    phase: str(get(ip, "status", "phase")) || undefined,
    approval: str(get(ip, "spec", "approval")),
    approved: get(ip, "spec", "approved") === true,
    csvNames: strings(get(ip, "spec", "clusterServiceVersionNames")),
    source: str(get(ip, "spec", "source")),
    sourceNamespace: str(get(ip, "spec", "sourceNamespace")),
    startTime: str(get(ip, "status", "startTime")),
    message: str(get(ip, "status", "message")),
    failure: installed?.status === "False" ? installed : undefined,
  };
}

/** `InstallPlanPhase` (installplan_types.go). */
export function planPhaseTone(phase: string | undefined): UiTone {
  switch (phase) {
    case "Complete":
      return "success";
    case "Failed":
      return "danger";
    case "RequiresApproval":
    case "Installing":
    case "Planning":
      return "warning";
    default:
      return "neutral";
  }
}

export interface PlanStep {
  resolving: string;
  group: string;
  version: string;
  kind: string;
  name: string;
  status: string;
  optional: boolean;
}

/** Steps listed at most; a plan of a big bundle has hundreds. */
export const MAX_STEPS = 200;

/**
 * `status.plan`: what the plan creates for which CSV and how far it got. A step's `resource.manifest` (the whole
 * object to create, which may be a bundle's Secret) is never read: Sextant hides it from extensions anyway (ADR-0121).
 */
export function stepsOf(ip: KubeObject): { steps: PlanStep[]; total: number } {
  const all = arr(get(ip, "status", "plan"));
  const steps = all.slice(0, MAX_STEPS).map((s) => ({
    resolving: str(get(s, "resolving")) ?? "",
    group: str(get(s, "resource", "group")) ?? "",
    version: str(get(s, "resource", "version")) ?? "",
    kind: str(get(s, "resource", "kind")) ?? "",
    name: str(get(s, "resource", "name")) ?? "",
    status: str(get(s, "status")) ?? "",
    optional: get(s, "optional") === true,
  }));
  return { steps, total: all.length };
}

/** `StepStatus` (installplan_types.go). */
export function stepTone(value: string): UiTone {
  if (value === "Created" || value === "Present") return "success";
  if (value === "WaitingForApi") return "warning";
  if (value === "NotCreated" || value === "UnsupportedResource") return "danger";
  return "neutral";
}

export interface BundleLookup {
  path: string;
  identifier: string;
  /** A True `BundleLookupFailed` condition, else a True `BundleLookupPending`. */
  condition?: { type: string; reason?: string; message?: string };
}

/** `status.bundleLookups`: bundles still being unpacked (or failing to) for the plan. */
export function bundleLookupsOf(ip: KubeObject): BundleLookup[] {
  return arr(get(ip, "status", "bundleLookups")).map((b) => {
    const conds = arr(get(b, "conditions"));
    const c = ["BundleLookupFailed", "BundleLookupPending"]
      .map((type) => conds.find((x) => get(x, "type") === type && get(x, "status") === "True"))
      .find(Boolean);
    return {
      path: str(get(b, "path")) ?? "",
      identifier: str(get(b, "identifier")) ?? "",
      condition: c ? { type: str(get(c, "type")) ?? "", reason: str(get(c, "reason")), message: str(get(c, "message")) } : undefined,
    };
  });
}

// ---------- CatalogSource ----------

export interface CatalogInfo {
  sourceType?: string;
  image?: string;
  address?: string;
  configMap?: string;
  displayName?: string;
  publisher?: string;
  priority?: number;
  /** `spec.updateStrategy.registryPoll.interval`. */
  pollInterval?: string;
  /** `status.connectionState.lastObservedState`: a gRPC connectivity state. */
  state?: string;
  connectedAddress?: string;
  lastConnect?: string;
  latestPoll?: string;
  registryService?: { name?: string; namespace?: string; port?: string; protocol?: string };
  reason?: string;
  message?: string;
}

export function catalogInfo(cs: KubeObject): CatalogInfo {
  const service = get(cs, "status", "registryService");
  return {
    sourceType: str(get(cs, "spec", "sourceType")),
    image: str(get(cs, "spec", "image")),
    address: str(get(cs, "spec", "address")),
    configMap: str(get(cs, "spec", "configMap")),
    displayName: str(get(cs, "spec", "displayName")),
    publisher: str(get(cs, "spec", "publisher")),
    priority: num(get(cs, "spec", "priority")),
    pollInterval: str(get(cs, "spec", "updateStrategy", "registryPoll", "interval")),
    state: str(get(cs, "status", "connectionState", "lastObservedState")) || undefined,
    connectedAddress: str(get(cs, "status", "connectionState", "address")),
    lastConnect: str(get(cs, "status", "connectionState", "lastConnect")),
    latestPoll: str(get(cs, "status", "latestImageRegistryPoll")),
    registryService: service
      ? {
          name: str(get(service, "serviceName")),
          namespace: str(get(service, "serviceNamespace")),
          port: str(get(service, "port")),
          protocol: str(get(service, "protocol")),
        }
      : undefined,
    reason: str(get(cs, "status", "reason")),
    message: str(get(cs, "status", "message")),
  };
}

/**
 * gRPC connectivity states that are not a fault: READY, and IDLE — a healthy channel with no call in flight (grpc-go
 * `connectivity.State`).
 */
const HEALTHY_STATES = new Set(["READY", "IDLE"]);

export function connectionTone(state: string | undefined): UiTone {
  if (state === "READY") return "success";
  if (state === "IDLE") return "neutral";
  if (state === "CONNECTING") return "warning";
  if (state === "TRANSIENT_FAILURE" || state === "SHUTDOWN") return "danger";
  return "neutral";
}

// ---------- OperatorGroup ----------

export interface OperatorGroupInfo {
  targetNamespaces: string[];
  selector?: unknown;
  /** `status.namespaces`; OLM writes `[""]` for all namespaces. */
  namespaces: string[];
  allNamespaces: boolean;
  /** `spec.upgradeStrategy`, `Default` when unset. */
  upgradeStrategy: string;
  serviceAccountName?: string;
  staticProvidedAPIs: boolean;
  providedAPIs: string[];
  lastUpdated?: string;
}

export function operatorGroupInfo(og: KubeObject): OperatorGroupInfo {
  const namespaces = strings(get(og, "status", "namespaces"));
  const provided = str(record(og.metadata?.annotations)["olm.providedAPIs"]);
  return {
    targetNamespaces: strings(get(og, "spec", "targetNamespaces")),
    selector: get(og, "spec", "selector"),
    namespaces: namespaces.filter((n) => n !== ""),
    allNamespaces: namespaces.includes(""),
    upgradeStrategy: str(get(og, "spec", "upgradeStrategy")) || "Default",
    serviceAccountName: str(get(og, "spec", "serviceAccountName")),
    staticProvidedAPIs: get(og, "spec", "staticProvidedAPIs") === true,
    providedAPIs: provided ? provided.split(",").filter(Boolean) : [],
    lastUpdated: str(get(og, "status", "lastUpdated")),
  };
}

/** A label selector's `matchLabels` and `matchExpressions` as chips, as Sextant's details write them. */
export function selectorChips(selector: unknown): string[] {
  const labels = Object.entries(record(get(selector, "matchLabels"))).map(([key, v]) => `${key}=${String(v)}`);
  const expressions = arr(get(selector, "matchExpressions")).map((e) => {
    const values = arr(get(e, "values")).map(String).join(", ");
    return `${str(get(e, "key")) ?? ""} ${str(get(e, "operator")) ?? ""}${values ? ` (${values})` : ""}`;
  });
  return [...labels, ...expressions];
}

// ---------- Operator (v1) ----------

export interface ComponentRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  conditions: string[];
}

/** Components listed at most. */
export const MAX_COMPONENTS = 200;

/** `status.components.refs`: what OLM labelled as this operator's, each with its conditions as `Type=Status`. */
export function componentsOf(op: KubeObject): { refs: ComponentRef[]; total: number } {
  const all = arr(get(op, "status", "components", "refs"));
  const refs = all.slice(0, MAX_COMPONENTS).map((r) => ({
    apiVersion: str(get(r, "apiVersion")) ?? "",
    kind: str(get(r, "kind")) ?? "",
    name: str(get(r, "name")) ?? "",
    namespace: str(get(r, "namespace")),
    conditions: arr(get(r, "conditions")).map((c) => `${str(get(c, "type")) ?? ""}=${str(get(c, "status")) ?? ""}`),
  }));
  return { refs, total: all.length };
}

// ---------- OLM v1: ClusterExtension and ClusterCatalog ----------

export interface ExtensionInfo {
  packageName?: string;
  version?: string;
  channels: string[];
  upgradeConstraintPolicy?: string;
  namespace?: string;
  serviceAccount?: string;
  installedBundle?: string;
  installedVersion?: string;
}

export function extensionInfo(ext: KubeObject): ExtensionInfo {
  const catalog = get(ext, "spec", "source", "catalog");
  return {
    packageName: str(get(catalog, "packageName")),
    version: str(get(catalog, "version")),
    channels: strings(get(catalog, "channels")),
    upgradeConstraintPolicy: str(get(catalog, "upgradeConstraintPolicy")),
    namespace: str(get(ext, "spec", "namespace")),
    serviceAccount: str(get(ext, "spec", "serviceAccount", "name")),
    installedBundle: str(get(ext, "status", "install", "bundle", "name")),
    installedVersion: str(get(ext, "status", "install", "bundle", "version")),
  };
}

export interface CatalogV1Info {
  sourceType?: string;
  image?: string;
  resolvedImage?: string;
  pollIntervalMinutes?: number;
  priority?: number;
  availabilityMode?: string;
  baseUrl?: string;
  lastUnpacked?: string;
}

export function catalogV1Info(cat: KubeObject): CatalogV1Info {
  return {
    sourceType: str(get(cat, "spec", "source", "type")),
    image: str(get(cat, "spec", "source", "image", "ref")),
    resolvedImage: str(get(cat, "status", "resolvedSource", "image", "ref")),
    pollIntervalMinutes: num(get(cat, "spec", "source", "image", "pollIntervalMinutes")),
    priority: num(get(cat, "spec", "priority")),
    availabilityMode: str(get(cat, "spec", "availabilityMode")),
    baseUrl: str(get(cat, "status", "urls", "base")),
    lastUnpacked: str(get(cat, "status", "lastUnpacked")),
  };
}

/** Reasons of OLM v1's `Progressing` that mean it is not going well (True while retrying). */
export const BAD_PROGRESS_REASONS = ["Retrying", "Blocked", "InvalidConfiguration", "ProgressDeadlineExceeded", "Failed"];

/** A condition of OLM v1 (`Installed`, `Progressing`, `Serving`) as `Status` with its reason. */
export function conditionText(obj: KubeObject, type: string): { text: string; tone: UiTone; title?: string } | undefined {
  const c = conditionOf(obj, type);
  if (!c) return undefined;
  // `Progressing` is True while all is well (reason `Succeeded`) and while retrying: the reason tells which.
  const bad = c.status === "False" || BAD_PROGRESS_REASONS.includes(c.reason ?? "");
  const tone: UiTone = type === "Progressing" ? (bad ? "warning" : "success") : c.status === "True" ? "success" : c.status === "False" ? "danger" : "neutral";
  return { text: c.reason ? `${c.status} (${c.reason})` : c.status, tone, title: c.message };
}

// ---------- Problems (the built-in category `olm`, now the manifest's rules) ----------

/** A failed CSV counts after this long: OLM retries some failures (`InstallCheckFailed`, `ComponentUnhealthy`). */
export const CSV_FAILED_GRACE_MS = 5 * 60_000;
/** A Subscription whose resolution failed counts after this long (a catalog may still be coming up). */
export const RESOLUTION_GRACE_MS = 10 * 60_000;
/** A catalog's registry not READY counts after this long. */
export const CATALOG_GRACE_MS = 10 * 60_000;
/** A Subscription's InstallPlan planning or installing counts as stuck after this long. */
export const PLAN_STUCK_MS = 30 * 60_000;

/** Phases of an InstallPlan the Subscription waits through that are no deliberate wait (RequiresApproval is). */
export const MOVING_PLAN = ["Planning", "Installing", "InstallPlanNotYetReconciled"];

/** A problem as the built-in detector found it. */
export interface Found {
  reason: string;
  group?: string;
  message?: string;
  messageParams?: Record<string, string>;
  since?: string;
  graceMs?: number;
  /** The problem is about this object, not the one judged (the Subscription's InstallPlan). */
  about?: Ref;
}

function csvProblems(csv: KubeObject): Found[] {
  // A copy mirrors the original's phase: the original is the one problem.
  if (isCopy(csv)) return [];
  const info = csvInfo(csv);
  if (info.phase !== "Failed") return [];
  return [{ reason: info.reason || "Failed", group: "failed", message: info.message, since: info.since, graceMs: CSV_FAILED_GRACE_MS }];
}

function subscriptionProblems(sub: KubeObject): Found[] {
  const out: Found[] = [];
  const info = subscriptionInfo(sub);
  const plan = info.installPlan;
  const resolution = conditionOf(sub, "ResolutionFailed");
  if (resolution?.status === "True") {
    out.push({
      reason: resolution.reason || "ResolutionFailed",
      group: "resolutionFailed",
      message: resolution.message,
      since: resolution.since,
      graceMs: RESOLUTION_GRACE_MS,
    });
  }
  // The Subscription mirrors its current InstallPlan (catalog/subscription/state.go): the failure of the plan it uses
  // now, never of an older plan OLM keeps around. The problem is about the plan.
  const failed = conditionOf(sub, "InstallPlanFailed");
  if (failed?.status === "True") {
    out.push({ reason: failed.reason || "InstallPlanFailed", group: "installPlanFailed", message: failed.message, since: failed.since, about: plan });
  }
  const pending = conditionOf(sub, "InstallPlanPending");
  if (pending?.status === "True" && MOVING_PLAN.includes(pending.reason ?? "")) {
    out.push({ reason: "InstallPlanStuck", messageParams: { phase: pending.reason ?? "" }, since: pending.since, graceMs: PLAN_STUCK_MS, about: plan });
  }
  return out;
}

function catalogProblems(cs: KubeObject): Found[] {
  const state = catalogInfo(cs).state;
  // Only a registry OLM connects to has a connection state (grpc); a missing one is not judged.
  if (!state || HEALTHY_STATES.has(state)) return [];
  return [{ reason: "CatalogSourceNotReady", messageParams: { state }, graceMs: CATALOG_GRACE_MS }];
}

/**
 * The problems of an OLM object, as the built-in category `olm` found them: a CSV in phase Failed (originals only,
 * after `CSV_FAILED_GRACE_MS`); a Subscription whose resolution failed (after `RESOLUTION_GRACE_MS`), whose current
 * InstallPlan failed (at once) or has been planning or installing for `PLAN_STUCK_MS`; a CatalogSource whose registry
 * is not READY (nor IDLE) for `CATALOG_GRACE_MS`. An InstallPlan waiting for approval is never a problem.
 */
export function olmProblems(kind: { group: string; kind: string }, obj: KubeObject): Found[] {
  if (obj.metadata?.deletionTimestamp) return [];
  if (isKind(kind, CSV)) return csvProblems(obj);
  if (isKind(kind, SUBSCRIPTION)) return subscriptionProblems(obj);
  if (isKind(kind, CATALOG_SOURCE)) return catalogProblems(obj);
  return [];
}

/** Counting now: past its grace when the start is known (a state first seen counts at once). */
function activeNow(d: Found, now: number): boolean {
  const at = d.since ? Date.parse(d.since) : NaN;
  return !d.graceMs || Number.isNaN(at) || at + d.graceMs <= now;
}

/** The built-in table's "Only problems": what counts now; for an InstallPlan, a failed one. */
export function isProblem(obj: KubeObject, kind: { group: string; kind: string }, now = Date.now()): boolean {
  if (isKind(kind, INSTALL_PLAN)) return installPlanInfo(obj).phase === "Failed";
  return olmProblems(kind, obj).some((d) => activeNow(d, now));
}
