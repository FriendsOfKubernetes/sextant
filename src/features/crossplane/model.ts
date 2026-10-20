// What the Crossplane section reads from Crossplane objects (#213): the kinds it knows (XRDs, Compositions and the
// packages), the kinds the XRDs define (composites and their claims), the chain Claim → composite → composed
// resources by the references Crossplane writes, Synced/Ready and the first failing condition, and a package's
// Installed/Healthy. Both layouts are read: Crossplane v1 (`spec.resourceRef(s)`, `spec.claimRef`) and v2
// (`spec.crossplane.*`). Pure functions, no React; texts are i18n keys under `crossplane:`.
import type { KindRef, KubeObject, ObjectRef } from "../../api";
import { kindFromApiVersion, status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, str } = status;

export const XP_GROUP = "apiextensions.crossplane.io";
export const PKG_GROUP = "pkg.crossplane.io";

const k = (group: string, version: string, kind: string): KindRef => ({ group, version, kind });

export const XRD = k(XP_GROUP, "v1", "CompositeResourceDefinition");
export const COMPOSITION = k(XP_GROUP, "v1", "Composition");
export const PROVIDER = k(PKG_GROUP, "v1", "Provider");
export const PKG_CONFIGURATION = k(PKG_GROUP, "v1", "Configuration");
export const FUNCTION = k(PKG_GROUP, "v1", "Function");

export interface CrossplaneKind {
  kind: KindRef;
  order: number;
  /** Key under `crossplane:sidebar`. */
  label: string;
}

/** All cluster-scoped. */
export const CROSSPLANE_KINDS: readonly CrossplaneKind[] = [
  { kind: XRD, order: 20, label: "xrds" },
  { kind: COMPOSITION, order: 30, label: "compositions" },
  { kind: PROVIDER, order: 40, label: "providers" },
  { kind: PKG_CONFIGURATION, order: 50, label: "configurations" },
  { kind: FUNCTION, order: 60, label: "functions" },
];

export const sameKind = (a: Pick<KindRef, "group" | "kind">, b: Pick<KindRef, "group" | "kind">) =>
  a.group === b.group && a.kind === b.kind;

export function crossplaneKind(kind: Pick<KindRef, "group" | "kind">): CrossplaneKind | undefined {
  return CROSSPLANE_KINDS.find((d) => sameKind(d.kind, kind));
}

export const isPackageKind = (kind: Pick<KindRef, "group" | "kind">) => kind.group === PKG_GROUP;
export const apiVersionOf = (kind: KindRef) => `${kind.group}/${kind.version}`;

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

export const conditionTone = (value: string | undefined): Tone =>
  value === "True" ? "success" : value === "False" ? "danger" : value === "Unknown" ? "warning" : "muted";

/** Ready=False reasons that are progress, not failure: a resource being created or deleted. */
const IN_PROGRESS = new Set(["Creating", "Deleting"]);

export type Health = "ready" | "progressing" | "failed" | "unknown";
export const HEALTH_TONE: Record<Health, Tone> = { ready: "success", progressing: "warning", failed: "danger", unknown: "muted" };

/**
 * A claim's, composite's or managed resource's state: failed when it is not Synced (Crossplane cannot reconcile it)
 * or not Ready for another reason than being created or deleted; progressing while being created or deleted or
 * Unknown; ready when Ready and not out of sync.
 */
export function resourceHealth(obj: KubeObject): Health {
  const synced = conditionOf(obj, "Synced");
  const ready = conditionOf(obj, "Ready");
  if (!synced && !ready) return "unknown";
  if (synced?.status === "False") return "failed";
  if (ready?.status === "False") return IN_PROGRESS.has(ready.reason ?? "") ? "progressing" : "failed";
  if (ready?.status === "True") return "ready";
  return "progressing";
}

/** The first condition that is False: Synced first (a reconcile error), then the others, Ready last. */
export function firstFailing(obj: KubeObject): Condition | undefined {
  const all = conditionsOf(obj).filter((c) => c.status === "False");
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
  const labels = status.labelsOf(obj);
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
  /** Key under `crossplane:explain`. */
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
