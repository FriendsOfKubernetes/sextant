// What the extension reads from Crossplane objects (ADR-0101, #213), ported unchanged from Sextant's former built-in
// view: the kinds it knows (XRDs, Compositions and the packages), the kinds the XRDs define (composites and their
// claims), the chain Claim → composite → composed resources by the references Crossplane writes, Synced/Ready and the
// first failing condition, and a package's Installed/Healthy. Both layouts are read: Crossplane v1
// (`spec.resourceRef(s)`, `spec.claimRef`) and v2 (`spec.crossplane.*`). Pure functions; texts are keys of the
// extension's catalogs. The manifest's columns and "Only problems" are tested against these readings.
import type { KubeObject, ObjectRef, UiTone } from "@sextant/extension-sdk";

export interface KindRef {
  group: string;
  version: string;
  kind: string;
}

export const XP_GROUP = "apiextensions.crossplane.io";
export const PKG_GROUP = "pkg.crossplane.io";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const XRD = k(XP_GROUP, "v1", "CompositeResourceDefinition");
export const COMPOSITION = k(XP_GROUP, "v1", "Composition");
export const PROVIDER = k(PKG_GROUP, "v1", "Provider");
export const PKG_CONFIGURATION = k(PKG_GROUP, "v1", "Configuration");
export const FUNCTION = k(PKG_GROUP, "v1", "Function");
export const SECRET = k("", "v1", "Secret");

/** The kinds of the section, all cluster-scoped. */
export const CROSSPLANE_KINDS: readonly KindRef[] = [XRD, COMPOSITION, PROVIDER, PKG_CONFIGURATION, FUNCTION];

export const sameKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) => a.group === b.group && a.kind === b.kind;

export function crossplaneKind(kind: Pick<KindRef, "group" | "kind">): KindRef | undefined {
  return CROSSPLANE_KINDS.find((d) => sameKind(d, kind));
}

export const isPackageKind = (kind: Pick<KindRef, "group" | "kind">) => kind.group === PKG_GROUP;

/** Kinds of installed APIs that may be Crossplane's: not built in, not Kubernetes' own groups, not the static kinds. */
export function mayBeCrossplaneResource(kind: Pick<KindRef, "group" | "kind">): boolean {
  return kind.group.includes(".") && !kind.group.endsWith(".k8s.io") && !crossplaneKind(kind) && kind.group !== PKG_GROUP;
}

// ---------- Field access ----------

export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** `group/version` or a core `v1` and a kind, as a kind reference. */
export function kindFromApiVersion(apiVersion: string, kind: string): KindRef {
  const slash = apiVersion.indexOf("/");
  return slash < 0 ? { group: "", version: apiVersion, kind } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1), kind };
}

export const apiVersionOf = (kind: Pick<KindRef, "group" | "version">) => (kind.group ? `${kind.group}/${kind.version}` : kind.version);

/** The controlling owner, else the first one (Sextant's `controllerOf`). */
export function controllerOf(obj: KubeObject): { apiVersion: string; kind: string; name: string } | undefined {
  const owners = arr(obj.metadata?.ownerReferences);
  const owner = owners.find((o) => get(o, "controller") === true) ?? owners[0];
  if (!owner) return undefined;
  const kind = str(get(owner, "kind"));
  const name = str(get(owner, "name"));
  const apiVersion = str(get(owner, "apiVersion"));
  if (!kind || !name || !apiVersion) return undefined;
  return { apiVersion, kind, name };
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
    return [{ type, status: value, reason: str(get(c, "reason")), message: str(get(c, "message")), lastTransitionTime: str(get(c, "lastTransitionTime")) }];
  });
}

export const conditionOf = (obj: KubeObject, type: string) => conditionsOf(obj).find((c) => c.type === type);
export const conditionStatus = (obj: KubeObject, type: string) => conditionOf(obj, type)?.status;

export const conditionTone = (value: string | undefined): UiTone =>
  value === "True" ? "success" : value === "False" ? "danger" : value === "Unknown" ? "warning" : "muted";

/** Ready=False reasons that are progress, not failure: a resource being created or deleted. */
const IN_PROGRESS = new Set(["Creating", "Deleting"]);

export type Health = "ready" | "progressing" | "paused" | "failed" | "unknown";
export const HEALTH_TONE: Record<Health, UiTone> = { ready: "success", progressing: "warning", paused: "muted", failed: "danger", unknown: "muted" };

/** The annotation that pauses reconciling (crossplane-runtime `meta.AnnotationKeyReconciliationPaused`, value "true"). */
export const PAUSED_ANNOTATION = "crossplane.io/paused";
/** The reason of `Synced=False` while paused (`ReconcilePaused()`, apis/core/v2/condition.go). */
export const REASON_PAUSED = "ReconcilePaused";

const isPausedCondition = (c: Condition) => c.type === "Synced" && c.status === "False" && c.reason === REASON_PAUSED;

/**
 * Paused by the user: Crossplane writes `Synced=False` with reason `ReconcilePaused` when `crossplane.io/paused` is
 * "true" (or management policies pause it) and leaves the object alone — a state asked for, not a failure.
 */
export function isPaused(obj: KubeObject): boolean {
  const synced = conditionOf(obj, "Synced");
  if (synced && isPausedCondition(synced)) return true;
  return str(get(obj, "metadata", "annotations", PAUSED_ANNOTATION)) === "true";
}

/**
 * A claim's, composite's or managed resource's state: paused when its reconciling is paused (`isPaused`); failed when
 * it is not Synced (Crossplane cannot reconcile it) or not Ready for another reason than being created or deleted;
 * progressing while being created or deleted or Unknown; ready when Ready and not out of sync.
 */
export function resourceHealth(obj: KubeObject): Health {
  if (isPaused(obj)) return "paused";
  const synced = conditionOf(obj, "Synced");
  const ready = conditionOf(obj, "Ready");
  if (!synced && !ready) return "unknown";
  if (synced?.status === "False") return "failed";
  if (ready?.status === "False") return IN_PROGRESS.has(ready.reason ?? "") ? "progressing" : "failed";
  if (ready?.status === "True") return "ready";
  return "progressing";
}

/**
 * The first condition that is False: Synced first (a reconcile error), then the others, Ready last. `Synced=False`
 * for a pause is not a failure and is skipped.
 */
export function firstFailing(obj: KubeObject): Condition | undefined {
  const all = conditionsOf(obj).filter((c) => c.status === "False" && !isPausedCondition(c));
  return all.find((c) => c.type === "Synced") ?? all.find((c) => c.type !== "Ready") ?? all.find((c) => c.type === "Ready");
}

/** A package (Provider, Configuration, Function): Installed and Healthy. */
export function packageHealth(obj: KubeObject): Health {
  const installed = conditionStatus(obj, "Installed");
  const healthy = conditionStatus(obj, "Healthy");
  if (!installed && !healthy) return "unknown";
  if (installed === "False" || healthy === "False") return "failed";
  if (installed === "True" && healthy === "True") return "ready";
  return "progressing";
}

// ---------- XRDs: the kinds they define ----------

export interface XrdInfo {
  name: string;
  uid: string;
  group: string;
  /** The composite kind and its version (the referenceable one, else the first served). */
  composite: KindRef;
  claim?: KindRef;
  established?: string;
  offered?: string;
}

export function parseXrd(obj: KubeObject): XrdInfo | undefined {
  const group = str(get(obj, "spec", "group"));
  const kind = str(get(obj, "spec", "names", "kind"));
  if (!group || !kind) return undefined;
  const versions = arr(get(obj, "spec", "versions"));
  const version =
    str(get(versions.find((v) => get(v, "referenceable") === true), "name")) ??
    str(get(versions.find((v) => get(v, "served") !== false), "name")) ??
    "v1";
  const claimKind = str(get(obj, "spec", "claimNames", "kind"));
  return {
    name: obj.metadata?.name ?? "",
    uid: obj.metadata?.uid ?? "",
    group,
    composite: { group, version, kind },
    claim: claimKind ? { group, version, kind: claimKind } : undefined,
    established: conditionStatus(obj, "Established"),
    offered: conditionStatus(obj, "Offered"),
  };
}

export type Role = "claim" | "composite";

/** Whether `kind` is a composite or a claim one of `xrds` defines. */
export function roleOf(kind: Pick<KindRef, "group" | "kind">, xrds: readonly XrdInfo[]): Role | undefined {
  for (const x of xrds) {
    if (sameKind(kind, x.composite)) return "composite";
    if (x.claim && sameKind(kind, x.claim)) return "claim";
  }
  return undefined;
}

// ---------- References ----------

export interface Ref {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

function refAt(value: unknown): Ref | undefined {
  const apiVersion = str(get(value, "apiVersion"));
  const kind = str(get(value, "kind"));
  const name = str(get(value, "name"));
  if (!apiVersion || !kind || !name) return undefined;
  return { apiVersion, kind, name, namespace: str(get(value, "namespace")) };
}

/** v1 keeps Crossplane's fields in `spec`, v2 in `spec.crossplane`. */
const xpField = (obj: KubeObject, field: string): unknown => get(obj, "spec", "crossplane", field) ?? get(obj, "spec", field);

/** A claim's composite. */
export const resourceRefOf = (claim: KubeObject): Ref | undefined => refAt(xpField(claim, "resourceRef"));
/** A composite's claim. */
export const claimRefOf = (composite: KubeObject): Ref | undefined => refAt(xpField(composite, "claimRef"));
/** A composite's composed resources. */
export function resourceRefsOf(composite: KubeObject): Ref[] {
  return arr(xpField(composite, "resourceRefs")).flatMap((r) => refAt(r) ?? []);
}
export const compositionOf = (obj: KubeObject): string | undefined => str(get(xpField(obj, "compositionRef"), "name"));

export function connectionSecretOf(obj: KubeObject): { name: string; namespace: string | null } | undefined {
  const ref = get(obj, "spec", "writeConnectionSecretToRef");
  const name = str(get(ref, "name"));
  if (!name) return undefined;
  return { name, namespace: str(get(ref, "namespace")) ?? obj.metadata?.namespace ?? null };
}

/** An object reference of `ref`; a ref without a namespace takes `fallbackNamespace` (a v2 composite's own). */
export function objectRefOf(ref: Ref, fallbackNamespace: string | null): ObjectRef {
  return { kind: kindFromApiVersion(ref.apiVersion, ref.kind), namespace: ref.namespace ?? fallbackNamespace, name: ref.name };
}

// ---------- Managed resources ----------

/** A managed resource by its shape: what it asks the provider for, or which ProviderConfig it uses. */
export function looksManaged(obj: KubeObject): boolean {
  return get(obj, "spec", "forProvider") !== undefined || get(obj, "spec", "providerConfigRef") !== undefined;
}

export interface ManagedFields {
  externalName?: string;
  providerConfig?: string;
  deletionPolicy?: string;
  managementPolicies: string[];
  composite?: string;
  claimName?: string;
  claimNamespace?: string;
}

export function managedFields(obj: KubeObject): ManagedFields {
  const labels = record(obj.metadata?.labels) as Record<string, string>;
  return {
    externalName: str(get(obj, "metadata", "annotations", "crossplane.io/external-name")),
    providerConfig: str(get(obj, "spec", "providerConfigRef", "name")),
    deletionPolicy: str(get(obj, "spec", "deletionPolicy")),
    managementPolicies: arr(get(obj, "spec", "managementPolicies")).map(str).filter((v): v is string => Boolean(v)),
    composite: labels["crossplane.io/composite"],
    claimName: labels["crossplane.io/claim-name"],
    claimNamespace: labels["crossplane.io/claim-namespace"],
  };
}

// ---------- Packages and Compositions ----------

export interface PackageFields {
  package?: string;
  revision?: string;
  identifier?: string;
  activation?: string;
}

export function packageFields(obj: KubeObject): PackageFields {
  return {
    package: str(get(obj, "spec", "package")),
    revision: str(get(obj, "status", "currentRevision")),
    identifier: str(get(obj, "status", "currentIdentifier")),
    activation: str(get(obj, "spec", "revisionActivationPolicy")),
  };
}

export interface CompositionFields {
  compositeType?: string;
  mode: string;
  steps: { step: string; fn?: string }[];
  resources: number;
}

export function compositionFields(obj: KubeObject): CompositionFields {
  const type = get(obj, "spec", "compositeTypeRef");
  const apiVersion = str(get(type, "apiVersion"));
  const kind = str(get(type, "kind"));
  const steps = arr(get(obj, "spec", "pipeline")).map((s) => ({ step: str(get(s, "step")) ?? "", fn: str(get(s, "functionRef", "name")) }));
  return {
    compositeType: apiVersion && kind ? `${kind}.${apiVersion}` : undefined,
    mode: str(get(obj, "spec", "mode")) ?? (steps.length > 0 ? "Pipeline" : "Resources"),
    steps,
    resources: arr(get(obj, "spec", "resources")).length,
  };
}

// ---------- Plain words ----------

export interface Phrase {
  /** Key under `explain.`. */
  key: string;
  params?: Record<string, string>;
}

/** A claim's, composite's or managed resource's state in plain words. */
export function explainResource(obj: KubeObject): Phrase | undefined {
  const failing = firstFailing(obj);
  const reason = failing?.reason ?? "";
  switch (resourceHealth(obj)) {
    case "ready":
      return { key: "ready" };
    case "paused":
      return { key: "paused" };
    case "progressing":
      return conditionOf(obj, "Ready")?.reason === "Deleting" ? { key: "deleting" } : { key: "creating" };
    case "failed":
      return failing?.type === "Synced" ? { key: "notSynced", params: { reason } } : { key: "notReady", params: { reason } };
    case "unknown":
      return undefined;
  }
}

export function explainPackage(obj: KubeObject): Phrase | undefined {
  const installed = conditionOf(obj, "Installed");
  const healthy = conditionOf(obj, "Healthy");
  switch (packageHealth(obj)) {
    case "ready":
      return { key: "packageHealthy" };
    case "progressing":
      return { key: "packageInstalling" };
    case "failed":
      return installed?.status === "False"
        ? { key: "packageNotInstalled", params: { reason: installed.reason ?? "" } }
        : { key: "packageUnhealthy", params: { reason: healthy?.reason ?? "" } };
    case "unknown":
      return undefined;
  }
}

export function explainXrd(info: XrdInfo): Phrase {
  if (info.established !== "True") return { key: "xrdNotEstablished" };
  if (info.claim && info.offered !== "True") return { key: "xrdClaimNotOffered", params: { claim: info.claim.kind } };
  return info.claim
    ? { key: "xrdEstablishedWithClaim", params: { kind: info.composite.kind, claim: info.claim.kind } }
    : { key: "xrdEstablished", params: { kind: info.composite.kind } };
}

// ---------- The rows of "Composite Resources" ----------

/** XRDs whose kinds are watched at most (two kinds each). */
export const MAX_XRDS = 20;
/** Rows kept at most; beyond it the page says it shows a part. */
export const MAX_ROWS = 5000;
/** Rows drawn at most. */
export const MAX_SHOWN = 500;

export interface Row {
  ref: ObjectRef;
  uid: string;
  role: Role;
  health: Health;
  synced?: string;
  ready?: string;
  failing?: Condition;
  composition?: string;
  /** A composite a claim stands for: its problems are told through the claim. */
  claimed: boolean;
  created?: string;
}

/** One claim or composite as a row. */
export function toRow(obj: KubeObject, kind: KindRef, role: Role): Row {
  return {
    ref: { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" },
    uid: obj.metadata?.uid ?? `${obj.metadata?.namespace ?? ""}/${obj.metadata?.name ?? ""}`,
    role,
    health: resourceHealth(obj),
    synced: conditionStatus(obj, "Synced"),
    ready: conditionStatus(obj, "Ready"),
    failing: firstFailing(obj),
    composition: compositionOf(obj),
    claimed: role === "composite" && claimRefOf(obj) !== undefined,
    created: str(obj.metadata?.creationTimestamp),
  };
}

const RANK: Record<Health, number> = { failed: 0, progressing: 1, unknown: 2, paused: 3, ready: 4 };

/** Problems first, then by kind, namespace and name. */
export const byState = (a: Row, b: Row) =>
  RANK[a.health] - RANK[b.health] ||
  a.ref.kind.kind.localeCompare(b.ref.kind.kind) ||
  (a.ref.namespace ?? "").localeCompare(b.ref.namespace ?? "") ||
  a.ref.name.localeCompare(b.ref.name);

// ---------- Problems (the built-in category `crossplane`, ported unchanged as the reference of the manifest's rules) ----------

/** A failure the next reconcile fixes passes quietly. */
export const FAILURE_GRACE_MS = 2 * 60_000;
/** Still being created after this long: worth a look (a managed database can take a quarter of an hour). */
export const CREATING_GRACE_MS = 30 * 60_000;

/**
 * Whether the built-in category `crossplane` counted a row: a claim or an unclaimed composite that is not Synced, or not
 * Ready for another reason than being created or deleted (and one still being created after `CREATING_GRACE_MS`).
 */
export function isProblemRow(row: Row): boolean {
  if (row.claimed || row.health === "ready" || row.health === "paused" || row.health === "unknown") return false;
  return !(row.health === "progressing" && row.failing?.reason === "Deleting");
}

/** A problem as the built-in category told it. */
export interface BuiltInProblem {
  key: string;
  notifyKey: string;
  uid: string;
  object: ObjectRef;
  reason: string;
  message?: string;
  since?: string;
  firstSeen: number;
  activeAt: number;
}

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * The built-in category's problems of the rows (its `toProblems`, unchanged); `firstSeen` keeps when each was first
 * seen. The manifest's rules are tested against it (`model.test.ts`).
 */
export function builtInProblems(rows: readonly Row[], firstSeen: Map<string, number>, now: number): BuiltInProblem[] {
  const keys = new Set<string>();
  const out: BuiltInProblem[] = [];
  for (const row of rows) {
    if (row.claimed || row.health === "ready" || row.health === "paused" || row.health === "unknown") continue;
    const creating = row.health === "progressing";
    // Deleting is the user's own doing: never a problem.
    if (creating && row.failing?.reason === "Deleting") continue;
    const condition = row.failing;
    const reason = condition?.reason ?? (creating ? "Creating" : `${condition?.type ?? "Ready"}=False`);
    const key = `${row.uid}|${reason}`;
    keys.add(key);
    const first = firstSeen.get(key) ?? now;
    firstSeen.set(key, first);
    const start = time(condition?.lastTransitionTime) ?? first;
    out.push({
      key,
      notifyKey: `${row.uid}|notReady`,
      uid: row.uid,
      object: row.ref,
      reason,
      message: condition?.message,
      since: condition?.lastTransitionTime,
      firstSeen: first,
      activeAt: start + (creating ? CREATING_GRACE_MS : FAILURE_GRACE_MS),
    });
  }
  for (const key of [...firstSeen.keys()]) if (!keys.has(key)) firstSeen.delete(key);
  return out;
}
