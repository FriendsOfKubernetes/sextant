// What the External Secrets section reads from External Secrets Operator objects (external-secrets.io): the kinds it
// knows, their Ready condition, the store an ExternalSecret reads from, the Secret it writes and the names of the
// remote keys it asks for. Pure functions, no React. Nothing here ever reads a Secret: the target Secret is named and
// linked, its data never fetched (the window gets Secrets stripped by the core anyway, ADR-0014).
import type { KindRef, KubeObject } from "../../api";
import { status } from "../../resources";
import type { Tone } from "../../resources/status";
import type { Detected } from "../problems/model";

const { arr, get, record, str } = status;

export const ESO_GROUP = "external-secrets.io";
const k = (kind: string): KindRef => ({
  group: ESO_GROUP,
  version: "v1",
  kind,
});

export const EXTERNAL_SECRET = k("ExternalSecret");
export const CLUSTER_EXTERNAL_SECRET = k("ClusterExternalSecret");
export const SECRET_STORE = k("SecretStore");
export const CLUSTER_SECRET_STORE = k("ClusterSecretStore");
// PushSecret is served at v1alpha1 for a long time; discovery gives the version the cluster serves.
export const PUSH_SECRET: KindRef = {
  group: ESO_GROUP,
  version: "v1alpha1",
  kind: "PushSecret",
};

/** One kind of the section and its sidebar entry. */
export interface EsoKind {
  kind: KindRef;
  order: number;
  /** Key under `externalsecrets:sidebar`. */
  label: string;
  namespaced: boolean;
}

export const ESO_KINDS: EsoKind[] = [
  {
    kind: EXTERNAL_SECRET,
    order: 10,
    label: "externalSecrets",
    namespaced: true,
  },
  {
    kind: CLUSTER_EXTERNAL_SECRET,
    order: 11,
    label: "clusterExternalSecrets",
    namespaced: false,
  },
  { kind: SECRET_STORE, order: 20, label: "secretStores", namespaced: true },
  {
    kind: CLUSTER_SECRET_STORE,
    order: 21,
    label: "clusterSecretStores",
    namespaced: false,
  },
  { kind: PUSH_SECRET, order: 30, label: "pushSecrets", namespaced: true },
];

export const isKind = (a: Pick<KindRef, "group" | "kind">, ...of: Pick<KindRef, "group" | "kind">[]): boolean =>
  of.some((b) => a.group === b.group && a.kind === b.kind);

export function esoKind(kind: Pick<KindRef, "group" | "kind">): EsoKind | undefined {
  return ESO_KINDS.find((d) => isKind(kind, d.kind));
}

// ---------- Readiness ----------

export type ReadyState = "ready" | "failed" | "pending";

export interface Readiness {
  state: ReadyState;
  reason?: string;
  message?: string;
  since?: string;
}

/** The Ready condition: True is ready, False failed, Unknown or none pending. */
export function readinessOf(obj: KubeObject): Readiness {
  const c = arr(get(obj, "status", "conditions")).find((x) => get(x, "type") === "Ready");
  const value = str(get(c, "status"));
  const state: ReadyState = value === "True" ? "ready" : value === "False" ? "failed" : "pending";
  return {
    state,
    reason: str(get(c, "reason")),
    message: str(get(c, "message")),
    since: str(get(c, "lastTransitionTime")),
  };
}

export const READY_TONE: Record<ReadyState, Tone> = {
  ready: "success",
  failed: "danger",
  pending: "warning",
};

/** Whether an object is in trouble (the tables' "Only problems" filter, the problems screen). */
export function isProblem(obj: KubeObject): boolean {
  return readinessOf(obj).state === "failed";
}

// ---------- ExternalSecret ----------

export interface StoreRef {
  name: string;
  /** `SecretStore` (default) or `ClusterSecretStore`. */
  kind: string;
}

function storeRef(value: unknown): StoreRef | undefined {
  const name = str(get(value, "name"));
  if (!name) return undefined;
  return { name, kind: str(get(value, "kind")) || "SecretStore" };
}

/** The store an ExternalSecret reads from (`spec.secretStoreRef`). */
export const storeRefOf = (es: KubeObject): StoreRef | undefined => storeRef(get(es, "spec", "secretStoreRef"));

/** The stores a PushSecret writes to (`spec.secretStoreRefs`; a ref by label selector has no name and is left out). */
export function pushStoreRefs(push: KubeObject): StoreRef[] {
  return arr(get(push, "spec", "secretStoreRefs"))
    .map(storeRef)
    .filter((r): r is StoreRef => r !== undefined);
}

/** The Secret an ExternalSecret writes: `spec.target.name`, else its own name. */
export function targetSecretName(es: KubeObject): string | undefined {
  return str(get(es, "spec", "target", "name")) || es.metadata?.name;
}

/** `spec.target.creationPolicy` (`Owner` by default). */
export const creationPolicyOf = (es: KubeObject): string => str(get(es, "spec", "target", "creationPolicy")) || "Owner";

/** `spec.refreshInterval` as written (`1h`, `0` = fetched once). */
export const refreshIntervalOf = (obj: KubeObject): string | undefined => str(get(obj, "spec", "refreshInterval"));

/** When the data was last fetched (`status.refreshTime`). */
export const lastSyncOf = (obj: KubeObject): string | undefined => str(get(obj, "status", "refreshTime"));

/** One key of the Secret and the remote key it comes from: names only. */
export interface RemoteKey {
  secretKey: string;
  remoteKey: string;
  property?: string;
}

export function remoteKeysOf(es: KubeObject): RemoteKey[] {
  return arr(get(es, "spec", "data")).map((d) => ({
    secretKey: str(get(d, "secretKey")) ?? "",
    remoteKey: str(get(d, "remoteRef", "key")) ?? "",
    property: str(get(d, "remoteRef", "property")),
  }));
}

/** `spec.dataFrom`: each entry as how it takes keys (`extract`, `find`) and the remote key or the search. */
export interface DataFrom {
  how: "extract" | "find" | "generator" | "other";
  what?: string;
}

export function dataFromOf(es: KubeObject): DataFrom[] {
  return arr(get(es, "spec", "dataFrom")).map((d): DataFrom => {
    const extract = get(d, "extract");
    if (extract) return { how: "extract", what: str(get(extract, "key")) };
    const find = get(d, "find");
    if (find) {
      const name = str(get(find, "name", "regexp"));
      const tags = Object.entries(record(get(find, "tags"))).map(([key, v]) => `${key}=${String(v)}`);
      return {
        how: "find",
        what: name ?? (tags.length > 0 ? tags.join(", ") : undefined),
      };
    }
    if (get(d, "sourceRef", "generatorRef"))
      return {
        how: "generator",
        what: str(get(d, "sourceRef", "generatorRef", "name")),
      };
    return { how: "other" };
  });
}

// ---------- Stores ----------

/** The provider a store talks to: the one key of `spec.provider` (`aws`, `vault`, `gcpsm`, …). */
export function providerOf(store: KubeObject): string | undefined {
  return Object.keys(record(get(store, "spec", "provider")))[0];
}

/** `status.capabilities`: ReadOnly, WriteOnly or ReadWrite. */
export const capabilitiesOf = (store: KubeObject): string | undefined => str(get(store, "status", "capabilities"));

// ---------- ClusterExternalSecret ----------

export interface FailedNamespace {
  namespace: string;
  reason?: string;
}

export const provisionedNamespaces = (ces: KubeObject): string[] => arr(get(ces, "status", "provisionedNamespaces")).map(String);

export function failedNamespaces(ces: KubeObject): FailedNamespace[] {
  return arr(get(ces, "status", "failedNamespaces")).map((f) => ({
    namespace: str(get(f, "namespace")) ?? "",
    reason: str(get(f, "reason")),
  }));
}

// ---------- PushSecret ----------

/** The Secret a PushSecret pushes (`spec.selector.secret.name`). */
export const pushSourceSecret = (push: KubeObject): string | undefined => str(get(push, "spec", "selector", "secret", "name"));

/** The remote keys a PushSecret writes, by the Secret key they take: names only. */
export function pushKeysOf(push: KubeObject): RemoteKey[] {
  return arr(get(push, "spec", "data")).map((d) => ({
    secretKey: str(get(d, "match", "secretKey")) ?? "",
    remoteKey: str(get(d, "match", "remoteRef", "remoteKey")) ?? "",
    property: str(get(d, "match", "remoteRef", "property")),
  }));
}

// ---------- Problems ----------

/** The problems of an External Secrets object: Ready=False (a failed sync, an invalid store). */
export function externalSecretsProblems(obj: KubeObject): Detected[] {
  if (obj.metadata?.deletionTimestamp) return [];
  const ready = readinessOf(obj);
  if (ready.state !== "failed") return [];
  return [
    {
      reason: ready.reason || "NotReady",
      group: "notReady",
      message: ready.message,
      since: ready.since,
      notify: true,
    },
  ];
}
