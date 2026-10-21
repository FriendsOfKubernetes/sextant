// What the Sealed Secrets section reads from Bitnami Sealed Secrets objects (bitnami.com/v1alpha1 SealedSecret), as
// the controller writes and reads them (bitnami-labs/sealed-secrets: pkg/apis/sealedsecrets/v1alpha1/types.go and
// sealedsecret_expansion.go, pkg/controller/controller.go). Pure functions, no React.
//
// Nothing here reads or shows a value: of `spec.encryptedData` only the key names and the sizes of the sealed
// (ciphertext) values are taken, of `spec.template.data` only the key names; the target Secret is named and linked,
// and the views look at its metadata only (ADR-0109).
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";

const { arr, get, num, record, str } = status;

export const SEALED_GROUP = "bitnami.com";
export const SEALED_SECRET: KindRef = { group: SEALED_GROUP, version: "v1alpha1", kind: "SealedSecret" };
export const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
export const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };

export const isSealedSecret = (kind: Pick<KindRef, "group" | "kind">): boolean =>
  kind.group === SEALED_GROUP && kind.kind === SEALED_SECRET.kind;

// ---------- The controller's annotations and names ----------

const ANNO = "sealedsecrets.bitnami.com/";
/** On the SealedSecret: the scope it was sealed for (the controller reads its own metadata, `labelFor(smeta)`). */
export const CLUSTER_WIDE = `${ANNO}cluster-wide`;
export const NAMESPACE_WIDE = `${ANNO}namespace-wide`;
/** On an existing Secret: the controller may take it over (`isAnnotatedToBeManaged`). */
export const MANAGED = `${ANNO}managed`;
/** On an existing Secret: the controller patches it instead of replacing it (`isAnnotatedToBePatched`). */
export const PATCH = `${ANNO}patch`;
/** On the template: the controller sets no owner reference on the Secret. */
export const SKIP_OWNER_REFERENCES = `${ANNO}skip-set-owner-references`;
/** The label of the controller's key Secrets (`SealedSecretsKeyLabel`); `active` or `compromised`. */
export const KEY_LABEL = `${ANNO}sealed-secrets-key`;

/** Where kubeseal looks by default (`--controller-name`, `--controller-namespace`), and the Helm chart's label. */
export const CONTROLLER_NAME = "sealed-secrets-controller";
export const CONTROLLER_NAMESPACE = "kube-system";
export const CONTROLLER_LABEL = "app.kubernetes.io/name=sealed-secrets";

const annotation = (obj: unknown, key: string): string | undefined => str(get(obj, "metadata", "annotations", key));

// ---------- The Synced condition ----------

/** Synced (True and current), failed (False), progressing (no status yet, or a status of an older generation). */
export type SyncState = "ready" | "progressing" | "failed";

export interface Sync {
  state: SyncState;
  message?: string;
  /** When the condition last changed (`lastTransitionTime`). */
  since?: string;
  /** When the controller last looked (`lastUpdateTime`). */
  checked?: string;
  /** The SealedSecret has no Synced condition at all. */
  noStatus: boolean;
  /** `status.observedGeneration` is behind `metadata.generation`: the status is of an older spec. */
  stale: boolean;
  observedGeneration?: number;
  generation?: number;
}

/**
 * The controller's `Synced` condition (the only one it writes; it sets no reason): True is synced, False failed with
 * the unseal or update error as the message. A status of an older generation tells nothing about the current spec.
 */
export function syncOf(obj: KubeObject): Sync {
  const c = arr(get(obj, "status", "conditions")).find((x) => get(x, "type") === "Synced");
  const value = str(get(c, "status"));
  const generation = num(get(obj, "metadata", "generation"));
  const observedGeneration = num(get(obj, "status", "observedGeneration"));
  const stale = generation !== undefined && observedGeneration !== undefined && observedGeneration < generation;
  const state: SyncState = stale ? "progressing" : value === "True" ? "ready" : value === "False" ? "failed" : "progressing";
  return {
    state,
    message: str(get(c, "message")) || undefined,
    since: str(get(c, "lastTransitionTime")),
    checked: str(get(c, "lastUpdateTime")),
    noStatus: c === undefined,
    stale,
    observedGeneration,
    generation,
  };
}

export const SYNC_TONE: Record<SyncState, Tone> = { ready: "success", progressing: "warning", failed: "danger" };

/** The "Only problems" filter: a failed unseal or update. */
export const isProblem = (obj: KubeObject): boolean => syncOf(obj).state === "failed";

// ---------- Scope ----------

export type Scope = "strict" | "namespaceWide" | "clusterWide";

/**
 * The scope the SealedSecret was sealed for, from its own annotations as the controller reads them when it decrypts
 * (`SecretScope`: cluster-wide wins over namespace-wide, each only when exactly "true"; otherwise strict).
 */
export function scopeOf(obj: KubeObject): Scope {
  if (annotation(obj, CLUSTER_WIDE) === "true") return "clusterWide";
  if (annotation(obj, NAMESPACE_WIDE) === "true") return "namespaceWide";
  return "strict";
}

// ---------- Keys and template ----------

export interface SealedKey {
  name: string;
  /** Bytes of the sealed value (the ciphertext, decoded from base64 by its length; it is never decoded). */
  sealedBytes: number;
}

/** Bytes a base64 text decodes to, from its length and padding alone. */
export function base64Bytes(text: string): number {
  const clean = text.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/** The keys of `spec.encryptedData` by name with their sealed sizes, sorted by name. */
export function sealedKeys(obj: KubeObject): SealedKey[] {
  return Object.entries(record(get(obj, "spec", "encryptedData")))
    .map(([name, value]) => ({ name, sealedBytes: typeof value === "string" ? base64Bytes(value) : 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The SealedSecret still carries the deprecated `spec.data` (one sealed Secret instead of per-key values). */
export const usesLegacyData = (obj: KubeObject): boolean => typeof get(obj, "spec", "data") === "string";

export interface TemplateKey {
  name: string;
  /** Set to null in the template: the key is left out of the Secret. */
  omitted: boolean;
}

export interface Template {
  type?: string;
  immutable?: boolean;
  /** The controller sets no owner reference on the Secret. */
  skipOwnerReferences: boolean;
  /** `spec.template.data`: the names of the keys rendered from templates (their text is not shown). */
  dataKeys: TemplateKey[];
}

export function templateOf(obj: KubeObject): Template {
  const t = get(obj, "spec", "template");
  const immutable = get(t, "immutable");
  return {
    type: str(get(t, "type")),
    immutable: typeof immutable === "boolean" ? immutable : undefined,
    skipOwnerReferences: annotation(t, SKIP_OWNER_REFERENCES) === "true",
    dataKeys: Object.entries(record(get(t, "data")))
      .map(([name, value]) => ({ name, omitted: value === null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------- The target Secret ----------

/** The Secret the controller writes: always the SealedSecret's own name, in its namespace (`unseal`). */
export const targetName = (obj: KubeObject): string | undefined => obj.metadata?.name;

export type TargetRelation = "owned" | "ownedByOther" | "managed" | "patched" | "unmanaged";

/**
 * How the Secret (its metadata) stands to the SealedSecret, by the controller's own test before it writes
 * (`IsControlledBy || managed || patch`): owned by this SealedSecret (its uid as the controller), taken over or patched
 * by annotation, or not managed — the controller then refuses to touch it.
 */
export function targetRelation(sealed: KubeObject, secret: KubeObject): TargetRelation {
  const uid = sealed.metadata?.uid;
  const controller = arr(get(secret, "metadata", "ownerReferences")).find((r) => get(r, "controller") === true);
  if (controller && uid && get(controller, "uid") === uid) return "owned";
  if (annotation(secret, PATCH) === "true") return "patched";
  if (annotation(secret, MANAGED) === "true") return "managed";
  return controller ? "ownedByOther" : "unmanaged";
}

export const RELATION_TONE: Record<TargetRelation, Tone> = {
  owned: "success",
  managed: "success",
  patched: "success",
  ownedByOther: "danger",
  unmanaged: "danger",
};

// ---------- Failures in words ----------

export type FailureHint = "noKey" | "unmanaged" | "immutable" | "legacyData";

/** What the controller's error message means, by the texts the controller writes; `undefined` when not recognised. */
export function failureHint(message: string | undefined): FailureHint | undefined {
  if (!message) return undefined;
  if (message.includes("no key could decrypt secret")) return "noKey";
  if (message.includes("is not managed by SealedSecret")) return "unmanaged";
  if (message.includes("immutable")) return "immutable";
  if (message.includes("deprecated 'data' field") || message.includes("deprecated field 'data'")) return "legacyData";
  return undefined;
}

// ---------- The controller ----------

export interface ControllerSummary {
  ready: number;
  desired: number;
  images: string[];
}

export function controllerSummary(deployment: KubeObject): ControllerSummary {
  return {
    ready: num(get(deployment, "status", "readyReplicas")) ?? 0,
    desired: num(get(deployment, "spec", "replicas")) ?? 1,
    images: arr(get(deployment, "spec", "template", "spec", "containers"))
      .map((c) => str(get(c, "image")))
      .filter((i): i is string => Boolean(i)),
  };
}

/** A key Secret by its label (`active`, `compromised`); its data is never read. */
export const keyState = (secret: KubeObject): string | undefined => str(get(secret, "metadata", "labels", KEY_LABEL));
