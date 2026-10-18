// What a custom object (or a PersistentVolume) names among Secrets, ConfigMaps and ServiceAccounts, found by the
// field shapes the known projects use rather than by a list of paths per version (a new field of the same shape is
// found too):
//
//   secretName: "x" (+ secretNamespace)          → Secret x          (cert-manager, Traefik, azureFile)
//   secretNames: ["x", …]                        → Secrets           (Traefik TLSOption clientAuth)
//   secret: "x"                                  → Secret x          (Traefik Middleware basicAuth)
//   credentialName: "x"                          → Secret x anywhere (Istio Gateway: the gateway workload's namespace)
//   <anything>SecretRef / secretRef / …SecretTargetRef / …SecretKeyRef: {name}
//                                                → Secret            (Flux, Issuers, KEDA, External Secrets, CSI)
//   <anything>ConfigMapRef / …ConfigMapTargetRef: {name}  → ConfigMap
//   {kind: "Secret"|"ConfigMap"|"ServiceAccount", name}   → that kind (HelmRelease valuesFrom, caCertificateRefs)
//   certificateRefs: [{name}] (kind Secret by default)    → Secret     (Gateway listeners, ListenerSets)
//   {name, key} under any other key              → Secret, or ConfigMap when the key says so
//                                                  (Prometheus operator basicAuth / tlsConfig / bearerTokenSecret,
//                                                  Velero `credential`)
//   serviceAccountName: "x"                      → ServiceAccount x  (Kustomization, HelmRelease)
//
// A `namespace` beside the name moves the reference there; otherwise it is the object's own namespace, and for a
// cluster-scoped object every namespace. The walk is bounded in depth and in nodes. A false reference only keeps an
// object off the list, which is the safe side.
import type { KubeObject } from "../../api";
import { status } from "../../resources";

const { get, str } = status;

export type ScannedKind = "Secret" | "ConfigMap" | "ServiceAccount";

export interface ScannedRef {
  kind: ScannedKind;
  /** `null`: any namespace (a cluster-scoped referrer naming none, or a reference resolved elsewhere). */
  namespace: string | null;
  name: string;
}

const MAX_DEPTH = 12;
const MAX_NODES = 5000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function kindOfKey(key: string): ScannedKind | undefined {
  const lower = key.toLowerCase();
  if (/configmap(target|key)?ref$/.test(lower)) return "ConfigMap";
  if (/secret(target|key)?ref$/.test(lower) || lower === "bearertokensecret" || lower === "keysecret" || lower === "secret") return "Secret";
  return undefined;
}

export function scanReferences(obj: KubeObject): ScannedRef[] {
  const own = obj.metadata?.namespace ?? null;
  const refs: ScannedRef[] = [];
  let nodes = 0;
  const add = (kind: ScannedKind, name: string | undefined, namespace: string | null | undefined) => {
    if (name) refs.push({ kind, name, namespace: namespace === undefined ? own : namespace });
  };
  const walk = (value: unknown, key: string, depth: number) => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && key === "secretNames") add("Secret", item, undefined);
        else walk(item, key, depth + 1);
      }
      return;
    }
    if (!isObject(value)) return;
    const namespace = str(get(value, "namespace"));
    const named = str(get(value, "name"));
    const kind = str(get(value, "kind"));
    const group = str(get(value, "group")) ?? str(get(value, "apiGroup")) ?? "";
    const byKey = kindOfKey(key);
    if (byKey) add(byKey, named, namespace);
    else if ((kind === "Secret" || kind === "ConfigMap" || kind === "ServiceAccount") && group === "") add(kind, named, namespace);
    else if (key === "certificateRefs" && kind === undefined) add("Secret", named, namespace);
    else if (named && typeof get(value, "key") === "string") add(key.toLowerCase().includes("configmap") ? "ConfigMap" : "Secret", named, namespace);
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") {
        if (k === "secretName") add("Secret", v, str(get(value, "secretNamespace")) ?? namespace);
        else if (k === "secret") add("Secret", v, namespace);
        else if (k === "credentialName") add("Secret", v.includes("/") ? v.slice(v.indexOf("/") + 1) : v, null);
        else if (k === "serviceAccountName") add("ServiceAccount", v, namespace);
      } else walk(v, k, depth + 1);
    }
  };
  walk(get(obj, "spec"), "spec", 0);
  return refs;
}
