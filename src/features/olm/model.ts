// What the "Operators (OLM)" section reads from the Operator Lifecycle Manager's objects, field by field as OLM writes
// them (operator-framework/api, pkg/operators/v1alpha1/{subscription,clusterserviceversion,installplan,
// catalogsource}_types.go and pkg/operators/v1/{operatorgroup,operator}_types.go), and from OLM v1's ClusterExtension
// and ClusterCatalog (operator-framework/operator-controller, api/v1/{clusterextension,clustercatalog,common}_types.go).
// A Subscription's state, its installed and current CSV and its InstallPlan; a CSV's phase, requirements, CRDs, install
// strategy Deployments and install modes, and whether it is a copy OLM made in a target namespace (`IsCopied` in
// pkg/operators/v1alpha1/clusterserviceversion.go: the `olm.copiedFrom` label, an `olm.operatorNamespace` annotation of
// another namespace, or `status.reason: Copied`); an InstallPlan's phase and steps; a CatalogSource's connection state;
// an OperatorGroup's target namespaces. And the problem rules of the category `olm`. Pure functions, no React.
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";

const { arr, get, num, record, str } = status;

export const OLM_GROUP = "operators.coreos.com";
/** OLM v1 (operator-controller). */
export const OLM_V1_GROUP = "olm.operatorframework.io";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const SUBSCRIPTION = k(OLM_GROUP, "v1alpha1", "Subscription");
export const CSV = k(OLM_GROUP, "v1alpha1", "ClusterServiceVersion");
export const INSTALL_PLAN = k(OLM_GROUP, "v1alpha1", "InstallPlan");
export const CATALOG_SOURCE = k(OLM_GROUP, "v1alpha1", "CatalogSource");
export const OPERATOR_GROUP = k(OLM_GROUP, "v1", "OperatorGroup");
/** Cluster-scoped: the components OLM labelled for one operator (`status.components.refs`). */
export const OPERATOR = k(OLM_GROUP, "v1", "Operator");
export const CLUSTER_EXTENSION = k(OLM_V1_GROUP, "v1", "ClusterExtension");
export const CLUSTER_CATALOG = k(OLM_V1_GROUP, "v1", "ClusterCatalog");

export interface OlmKind {
  kind: KindRef;
  /** Key under `olm:sidebar` and of the kind's icon and columns. */
  label: string;
  order: number;
  namespaced: boolean;
}

export const OLM_KINDS: readonly OlmKind[] = [
  { kind: SUBSCRIPTION, label: "subscriptions", order: 10, namespaced: true },
  { kind: CSV, label: "csvs", order: 20, namespaced: true },
  { kind: INSTALL_PLAN, label: "installPlans", order: 30, namespaced: true },
  { kind: CATALOG_SOURCE, label: "catalogSources", order: 40, namespaced: true },
  { kind: OPERATOR_GROUP, label: "operatorGroups", order: 50, namespaced: true },
  { kind: OPERATOR, label: "operators", order: 60, namespaced: false },
  { kind: CLUSTER_EXTENSION, label: "clusterExtensions", order: 70, namespaced: false },
  { kind: CLUSTER_CATALOG, label: "clusterCatalogs", order: 80, namespaced: false },
];

/** Same group and kind: Knative Eventing has a `Subscription` too (messaging.knative.dev). */
export const isKind = (kind: Pick<KindRef, "group" | "kind">, def: KindRef): boolean => kind.group === def.group && kind.kind === def.kind;
export const olmKind = (kind: Pick<KindRef, "group" | "kind">): OlmKind | undefined => OLM_KINDS.find((d) => isKind(kind, d.kind));

/** The kinds the problems category `olm` judges (CSVs through the provider, the rest by their watches). */
export const isOlmProblemKind = (kind: Pick<KindRef, "group" | "kind">): boolean =>
  isKind(kind, SUBSCRIPTION) || isKind(kind, CSV) || isKind(kind, CATALOG_SOURCE);

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

export const SUBSCRIPTION_TONE: Record<SubscriptionState, Tone> = {
  resolutionFailed: "danger",
  installPlanFailed: "danger",
  upgradeFailed: "danger",
  waitingApproval: "warning",
  upgradePending: "warning",
  upgradeAvailable: "warning",
  atLatest: "success",
  pending: "neutral",
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

/** The Subscription conditions the view lists, in this order (subscription_types.go). */
export const SUBSCRIPTION_CONDITIONS = [
  "ResolutionFailed",
  "CatalogSourcesUnhealthy",
  "InstallPlanFailed",
  "InstallPlanPending",
  "InstallPlanMissing",
  "BundleUnpacking",
  "BundleUnpackFailed",
  "Deprecated",
  "PackageDeprecated",
  "ChannelDeprecated",
  "BundleDeprecated",
] as const;

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
export function phaseTone(phase: string | undefined): Tone {
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
export function requirementTone(value: string): Tone {
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
export function planPhaseTone(phase: string | undefined): Tone {
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
 * object to create, which may be a bundle's Secret) is never read.
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
export function stepTone(value: string): Tone {
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

export function connectionTone(state: string | undefined): Tone {
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

/** A condition of OLM v1 (`Installed`, `Progressing`, `Serving`) as `Status` with its reason. */
export function conditionText(obj: KubeObject, type: string): { text: string; tone: Tone; title?: string } | undefined {
  const c = conditionOf(obj, type);
  if (!c) return undefined;
  // `Progressing` is True while all is well (reason `Succeeded`) and while retrying: the reason tells which.
  const bad = c.status === "False" || ["Retrying", "Blocked", "InvalidConfiguration", "ProgressDeadlineExceeded", "Failed"].includes(c.reason ?? "");
  const tone: Tone = type === "Progressing" ? (bad ? "warning" : "success") : c.status === "True" ? "success" : c.status === "False" ? "danger" : "neutral";
  return { text: c.reason ? `${c.status} (${c.reason})` : c.status, tone, title: c.message };
}

// ---------- Problems (category `olm`) ----------

/** A failed CSV counts after this long: OLM retries some failures (`InstallCheckFailed`, `ComponentUnhealthy`). */
export const CSV_FAILED_GRACE_MS = 5 * 60_000;
/** A Subscription whose resolution failed counts after this long (a catalog may still be coming up). */
export const RESOLUTION_GRACE_MS = 10 * 60_000;
/** A catalog's registry not READY counts after this long. */
export const CATALOG_GRACE_MS = 10 * 60_000;
/** A Subscription's InstallPlan planning or installing counts as stuck after this long. */
export const PLAN_STUCK_MS = 30 * 60_000;

/** Phases of an InstallPlan the Subscription waits through that are no deliberate wait (RequiresApproval is). */
const MOVING_PLAN = new Set(["Planning", "Installing", "InstallPlanNotYetReconciled"]);

function csvProblems(csv: KubeObject): Detected[] {
  // A copy mirrors the original's phase: the original is the one problem.
  if (isCopy(csv)) return [];
  const info = csvInfo(csv);
  if (info.phase !== "Failed") return [];
  return [{ reason: info.reason || "Failed", group: "failed", message: info.message, since: info.since, graceMs: CSV_FAILED_GRACE_MS, notify: true }];
}

function subscriptionProblems(sub: KubeObject): Detected[] {
  const out: Detected[] = [];
  const info = subscriptionInfo(sub);
  const plan = info.installPlan ? { kind: INSTALL_PLAN, namespace: info.installPlan.namespace ?? null, name: info.installPlan.name } : undefined;
  const resolution = conditionOf(sub, "ResolutionFailed");
  if (resolution?.status === "True") {
    out.push({
      reason: resolution.reason || "ResolutionFailed",
      group: "resolutionFailed",
      message: resolution.message,
      since: resolution.since,
      graceMs: RESOLUTION_GRACE_MS,
      notify: true,
    });
  }
  // The Subscription mirrors its current InstallPlan (catalog/subscription/state.go): the failure of the plan it uses
  // now, never of an older plan OLM keeps around. The problem is about the plan.
  const failed = conditionOf(sub, "InstallPlanFailed");
  if (failed?.status === "True") {
    out.push({ reason: failed.reason || "InstallPlanFailed", group: "installPlanFailed", message: failed.message, since: failed.since, notify: true, object: plan });
  }
  const pending = conditionOf(sub, "InstallPlanPending");
  if (pending?.status === "True" && MOVING_PLAN.has(pending.reason ?? "")) {
    out.push({
      reason: "InstallPlanStuck",
      messageKey: "messages.olmPlanStuck",
      messageParams: { phase: pending.reason ?? "" },
      since: pending.since,
      graceMs: PLAN_STUCK_MS,
      stamp: pending.reason,
      notify: true,
      object: plan,
    });
  }
  return out;
}

function catalogProblems(cs: KubeObject): Detected[] {
  const state = catalogInfo(cs).state;
  // Only a registry OLM connects to has a connection state (grpc); a missing one is not judged.
  if (!state || HEALTHY_STATES.has(state)) return [];
  // No stamp: a crash-looping registry moves between TRANSIENT_FAILURE and CONNECTING every few minutes, and a stamp
  // of the state would start the grace again on every move, so it would never end. Unhealthy is one state here.
  return [
    {
      reason: "CatalogSourceNotReady",
      messageKey: "messages.olmCatalogState",
      messageParams: { state },
      graceMs: CATALOG_GRACE_MS,
      notify: true,
    },
  ];
}

/**
 * The problems of an OLM object (category `olm`): a CSV in phase Failed (originals only, after
 * `CSV_FAILED_GRACE_MS`); a Subscription whose resolution failed (after `RESOLUTION_GRACE_MS`), whose current
 * InstallPlan failed (about the plan, at once) or has been planning or installing for `PLAN_STUCK_MS`; a CatalogSource
 * whose registry is not READY (nor IDLE) for `CATALOG_GRACE_MS`. An InstallPlan waiting for approval is a deliberate
 * state, never a problem.
 */
export function olmProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  if (obj.metadata?.deletionTimestamp) return [];
  if (isKind(kind, CSV)) return csvProblems(obj);
  if (isKind(kind, SUBSCRIPTION)) return subscriptionProblems(obj);
  if (isKind(kind, CATALOG_SOURCE)) return catalogProblems(obj);
  return [];
}

/** Counting now: past its grace when the start is known (a state first seen by the store counts here at once). */
function activeNow(d: Detected, now: number): boolean {
  const at = d.since ? Date.parse(d.since) : NaN;
  return !d.graceMs || Number.isNaN(at) || at + d.graceMs <= now;
}

/** The table's "Only problems": what counts now; for an InstallPlan, a failed one. */
export function isProblem(obj: KubeObject, kind: KindRef, now = Date.now()): boolean {
  if (isKind(kind, INSTALL_PLAN)) return installPlanInfo(obj).phase === "Failed";
  return olmProblems(kind, obj).some((d) => activeNow(d, now));
}
