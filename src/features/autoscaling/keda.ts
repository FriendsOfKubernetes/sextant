// KEDA (keda.sh/v1alpha1) as the autoscaling views read it — pure, no React: a ScaledObject's or ScaledJob's target,
// triggers and their health, the HPA KEDA manages for a ScaledObject (`keda-hpa-<name>` unless named otherwise),
// and its state in plain words from the Ready, Active, Fallback and Paused conditions and the pause annotations.
// TriggerAuthentications are summarised by where their parameters come from; no Secret value is read.
import type { KubeObject } from "../../api";
import { status } from "../../resources";
import { conditionOf, phrase, type Phrase } from "./model";

const { arr, get, num, record, str } = status;

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

/** Trigger types as one line for the tables. */
export function triggerTypes(obj: KubeObject): string[] {
  return [...new Set(triggersOf(obj).map((t) => t.type).filter(Boolean))];
}

// ---------- TriggerAuthentication ----------

export interface AuthSource {
  parameter: string;
  /** "Secret", "ConfigMap", "env", or the provider ("hashiCorpVault", "azureKeyVault", …). */
  from: string;
  /** The Secret, ConfigMap or variable name. */
  name?: string;
  key?: string;
}

const PROVIDERS = ["hashiCorpVault", "azureKeyVault", "awsSecretManager", "gcpSecretManager", "boundServiceAccountToken"];

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
