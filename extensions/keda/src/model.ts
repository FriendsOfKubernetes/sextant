// KEDA (keda.sh/v1alpha1) as Sextant's former built-in autoscaling view read it (src/features/autoscaling/keda.ts and
// model.ts, ADR-0080), ported unchanged — pure, no DOM: a ScaledObject's or ScaledJob's target, triggers and their
// health, the HPA KEDA manages for a ScaledObject (`keda-hpa-<name>` unless named otherwise), its state in plain words
// from the Ready, Active, Fallback and Paused conditions and the pause annotations, and the short state word of the
// tables. TriggerAuthentications are summarised by where their parameters come from; no Secret value is read.
// `isProblem` is the built-in tables' "Only problems" filter, kept as the reference the manifest is tested against.
import type { KubeObject } from "@sextant/extension-sdk";

/** The tone of a phrase or a status word, as Sextant's own views colour them. */
export type Tone = "success" | "warning" | "danger" | "muted" | "neutral";

export interface KindRef {
  group: string;
  version: string;
  kind: string;
}

export const KEDA_GROUP = "keda.sh";
export const SCALED_OBJECT: KindRef = { group: KEDA_GROUP, version: "v1alpha1", kind: "ScaledObject" };
export const SCALED_JOB: KindRef = { group: KEDA_GROUP, version: "v1alpha1", kind: "ScaledJob" };
export const TRIGGER_AUTHENTICATION: KindRef = { group: KEDA_GROUP, version: "v1alpha1", kind: "TriggerAuthentication" };
export const CLUSTER_TRIGGER_AUTHENTICATION: KindRef = { group: KEDA_GROUP, version: "v1alpha1", kind: "ClusterTriggerAuthentication" };
export const HPA: KindRef = { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" };
export const SECRET: KindRef = { group: "", version: "v1", kind: "Secret" };
export const CONFIG_MAP: KindRef = { group: "", version: "v1", kind: "ConfigMap" };

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

/** `group/version` (or `version`) into a kind reference. */
export function kindFromApiVersion(apiVersion: string, kind: string): KindRef {
  const slash = apiVersion.indexOf("/");
  return slash < 0 ? { group: "", version: apiVersion, kind } : { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1), kind };
}

// ---------- Untyped access, as Sextant's `status` helpers ----------

export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

// ---------- Phrases and conditions ----------

/** A text key and its values, with its tone (the built-in `Phrase`, keys as under `autoscaling:`). */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
  tone?: Tone;
}

export const phrase = (key: string, params?: Phrase["params"], tone?: Tone): Phrase =>
  params === undefined && tone === undefined ? { key } : { key, ...(params ? { params } : {}), ...(tone ? { tone } : {}) };

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export function conditionsOf(obj: unknown): Condition[] {
  return arr(get(obj, "status", "conditions")).flatMap((c) => {
    const type = str(get(c, "type"));
    if (!type) return [];
    const out: Condition = { type, status: str(get(c, "status")) ?? "Unknown" };
    const reason = str(get(c, "reason"));
    const message = str(get(c, "message"));
    const time = str(get(c, "lastTransitionTime"));
    if (reason) out.reason = reason;
    if (message) out.message = message;
    if (time) out.lastTransitionTime = time;
    return [out];
  });
}

export function conditionOf(obj: unknown, type: string): Condition | undefined {
  return conditionsOf(obj).find((c) => c.type === type);
}

// ---------- Status words, as Sextant's `statusTone` ----------

const GOOD = new Set(["Running", "Active", "Bound", "Available", "Ready", "True", "Complete", "deployed"]);
const DONE = new Set(["Succeeded", "Completed", "Released", "Terminated"]);
export const BAD = ["Failed", "Error", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled", "Lost", "Evicted", "Unknown", "False", "failed"];
export const GOOD_WORDS = [...GOOD];
export const DONE_WORDS = [...DONE];

/** Color of a status word. */
export function statusTone(status: string): Tone {
  if (GOOD.has(status)) return "success";
  if (DONE.has(status)) return "muted";
  if (BAD.includes(status) || status.startsWith("Init:Err") || status.startsWith("Init:Crash")) return "danger";
  return "warning";
}

// ---------- ScaledObject and ScaledJob ----------

export const PAUSED = "autoscaling.keda.sh/paused";
export const PAUSED_REPLICAS = "autoscaling.keda.sh/paused-replicas";

export interface TargetRef {
  apiVersion: string;
  kind: string;
  name: string;
}

/** What a ScaledObject scales (Deployment by default). */
export function scaleTargetOf(obj: KubeObject): TargetRef | undefined {
  const ref = get(obj, "spec", "scaleTargetRef");
  const name = str(get(ref, "name"));
  if (!name) return undefined;
  return { apiVersion: str(get(ref, "apiVersion")) ?? "apps/v1", kind: str(get(ref, "kind")) ?? "Deployment", name };
}

/** The HPA KEDA creates for a ScaledObject. */
export function managedHpaName(obj: KubeObject): string {
  return (
    str(get(obj, "status", "hpaName")) ??
    str(get(obj, "spec", "advanced", "horizontalPodAutoscalerConfig", "name")) ??
    `keda-hpa-${obj.metadata?.name ?? ""}`
  );
}

export interface TriggerRow {
  type: string;
  name?: string;
  /** Metadata as `key=value`, at most `MAX_METADATA`. */
  metadata: string[];
  auth?: { kind: "TriggerAuthentication" | "ClusterTriggerAuthentication"; name: string };
  metricType?: string;
  /** Consecutive failures KEDA counts for the trigger; `undefined` when it reports none. */
  failures?: number;
  health?: string;
}

const MAX_METADATA = 8;

/** The triggers, with the health KEDA reports for each (`status.health["s<index>-…"]`). */
export function triggersOf(obj: KubeObject): TriggerRow[] {
  const health = record(get(obj, "status", "health"));
  return arr(get(obj, "spec", "triggers")).map((t, i) => {
    const row: TriggerRow = {
      type: str(get(t, "type")) ?? "",
      metadata: Object.entries(record(get(t, "metadata")))
        .filter(([, v]) => v !== "" && v !== null && v !== undefined)
        .slice(0, MAX_METADATA)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`),
    };
    const name = str(get(t, "name"));
    if (name) row.name = name;
    const authName = str(get(t, "authenticationRef", "name"));
    if (authName) {
      row.auth = {
        kind: str(get(t, "authenticationRef", "kind")) === "ClusterTriggerAuthentication" ? "ClusterTriggerAuthentication" : "TriggerAuthentication",
        name: authName,
      };
    }
    const metricType = str(get(t, "metricType"));
    if (metricType) row.metricType = metricType;
    const entry = Object.entries(health).find(([key]) => key.startsWith(`s${i}-`));
    if (entry) {
      const failures = num(get(entry[1], "numberOfFailures"));
      const state = str(get(entry[1], "status"));
      if (failures !== undefined) row.failures = failures;
      if (state) row.health = state;
    }
    return row;
  });
}

export interface KedaState {
  /** The plain-language state, most important first. */
  phrases: Phrase[];
  ready: boolean;
  active: boolean;
  paused: boolean;
  fallback: boolean;
}

/** The state of a ScaledObject (`job` false) or a ScaledJob (`job` true). */
export function kedaState(obj: KubeObject, job = false): KedaState {
  const annotations = record(obj.metadata?.annotations);
  const ready = conditionOf(obj, "Ready");
  const active = conditionOf(obj, "Active");
  const fallback = conditionOf(obj, "Fallback");
  const pausedCond = conditionOf(obj, "Paused");
  const pausedReplicas = str(annotations[PAUSED_REPLICAS]);
  const paused = pausedCond?.status === "True" || str(annotations[PAUSED]) === "true" || pausedReplicas !== undefined;
  const phrases: Phrase[] = [];
  if (ready && ready.status !== "True") phrases.push(phrase("keda.notReady", { reason: ready.reason ?? ready.status }, "danger"));
  if (paused) {
    phrases.push(
      pausedReplicas !== undefined
        ? phrase("keda.pausedAt", { annotation: PAUSED_REPLICAS, replicas: pausedReplicas }, "warning")
        : phrase("keda.paused", { annotation: PAUSED }, "warning"),
    );
  }
  if (fallback?.status === "True") {
    const replicas = num(get(obj, "spec", "fallback", "replicas"));
    phrases.push(phrase("keda.fallback", { replicas: replicas ?? "?" }, "warning"));
  }
  for (const t of triggersOf(obj)) {
    if (t.failures !== undefined && t.failures > 0) {
      phrases.push(phrase("keda.triggerFailing", { trigger: t.name ?? t.type, count: t.failures }, "danger"));
    }
  }
  if (!paused && active) {
    const min = num(get(obj, "spec", "minReplicaCount")) ?? 0;
    const max = num(get(obj, "spec", "maxReplicaCount")) ?? 100;
    const idle = num(get(obj, "spec", "idleReplicaCount"));
    if (active.status === "True") phrases.push(job ? phrase("keda.jobActive", { max }, "success") : phrase("keda.active", { min: Math.max(min, 1), max }, "success"));
    else if (job) phrases.push(phrase("keda.jobInactive", undefined, "neutral"));
    else if (idle !== undefined) phrases.push(phrase("keda.inactiveIdle", { replicas: idle }, "neutral"));
    else phrases.push(phrase("keda.inactive", { replicas: Math.max(min, 1) }, "neutral"));
  }
  return { phrases, ready: ready?.status === "True", active: active?.status === "True", paused, fallback: fallback?.status === "True" };
}

/** A short state for the tables: Paused, Fallback, Active, Inactive, or the Ready reason when not ready. */
export function stateWord(obj: KubeObject): string | undefined {
  const s = kedaState(obj);
  const ready = conditionOf(obj, "Ready");
  if (ready && ready.status !== "True") return ready.reason ?? "NotReady";
  if (s.paused) return "Paused";
  if (s.fallback) return "Fallback";
  const active = conditionOf(obj, "Active");
  if (!active) return undefined;
  return s.active ? "Active" : "Inactive";
}

/** The tone of the state word in the tables. */
export function stateTone(value: string): Tone {
  return value === "Active" ? "success" : value === "Inactive" ? "muted" : value === "Paused" || value === "Fallback" ? "warning" : statusTone(value);
}

/** Trigger types as one line for the tables. */
export function triggerTypes(obj: KubeObject): string[] {
  return [...new Set(triggersOf(obj).map((t) => t.type).filter(Boolean))];
}

/** The Ready condition's status, as the tables' Ready column, and its tone. */
export const readyOf = (o: KubeObject): string | undefined => conditionOf(o, "Ready")?.status;
export const readyTone = (value: string): Tone => (value === "True" ? "success" : value === "False" ? "danger" : "warning");

// ---------- TriggerAuthentication ----------

export interface AuthSource {
  parameter: string;
  /** "Secret", "ConfigMap", "env", or the provider ("hashiCorpVault", "azureKeyVault", …). */
  from: string;
  /** The Secret, ConfigMap or variable name. */
  name?: string;
  key?: string;
}

export const PROVIDERS = ["hashiCorpVault", "azureKeyVault", "awsSecretManager", "gcpSecretManager", "boundServiceAccountToken"] as const;

/** Where a TriggerAuthentication's parameters come from (names only, never values). */
export function authSources(obj: KubeObject): { sources: AuthSource[]; podIdentity?: string } {
  const spec = get(obj, "spec");
  const sources: AuthSource[] = [];
  const ref = (from: string, list: unknown, nameField: string, keyField?: string) => {
    for (const r of arr(list)) {
      const source: AuthSource = { parameter: str(get(r, "parameter")) ?? "", from };
      const name = str(get(r, nameField));
      const key = keyField ? str(get(r, keyField)) : undefined;
      if (name) source.name = name;
      if (key) source.key = key;
      sources.push(source);
    }
  };
  ref("Secret", get(spec, "secretTargetRef"), "name", "key");
  ref("ConfigMap", get(spec, "configMapTargetRef"), "name", "key");
  ref("env", get(spec, "env"), "name");
  for (const provider of PROVIDERS) {
    const p = get(spec, provider);
    if (p === undefined) continue;
    const params = arr(get(p, "credentials")).length > 0 ? get(p, "credentials") : get(p, "secrets");
    if (arr(params).length === 0) sources.push({ parameter: "", from: provider });
    else ref(provider, params, "path");
  }
  const out: { sources: AuthSource[]; podIdentity?: string } = { sources };
  const identity = str(get(spec, "podIdentity", "provider"));
  if (identity) out.podIdentity = identity;
  return out;
}

/** The Sources column: where the parameters come from, each once, then the pod identity provider. */
export function sourcesText(obj: KubeObject): string {
  const { sources, podIdentity } = authSources(obj);
  return [...new Set([...sources.map((s) => s.from), ...(podIdentity ? [podIdentity] : [])])].join(", ");
}

// ---------- "Only problems" ----------

/** Whether a KEDA object needs attention (the built-in tables' "Only problems": Ready False, or a reached limit). */
export function isProblem(o: KubeObject): boolean {
  const ready = conditionOf(o, "Ready");
  return ready !== undefined && ready.status === "False";
}
