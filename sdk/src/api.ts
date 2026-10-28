// The parameters and results of the extension API (Sextant's `src-tauri/src/extensions/api.rs` reads the parameters
// strictly: an unknown field is `invalid`). `clusterId` may be left out: it is the cluster of the frame's context.
import type { ClusterId } from "./generated/ClusterId";
import type { ConnectionState } from "./generated/ConnectionState";
import type { KindRef } from "./generated/KindRef";
import type { ObjectRef } from "./generated/ObjectRef";
import type { PatchType } from "./generated/PatchType";
import type { ResourceKind } from "./generated/ResourceKind";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import type { WatchUpdate } from "./generated/WatchUpdate";
import type { HostContext } from "./protocol";

export type { ClusterId, ConnectionState, JsonValue, KindRef, ObjectRef, PatchType, ResourceKind, WatchUpdate };

/** A kind: the API group (`""` for the core group) and kind; without a version, the one the cluster serves. */
export interface KindInput {
  group?: string;
  version?: string;
  kind: string;
}

/** An object: its kind, namespace (for a namespaced kind) and name — an `ObjectRef` with the version optional. */
export interface RefInput {
  kind: KindInput;
  namespace?: string | null;
  name: string;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  [field: string]: unknown;
}

/** An object as the cluster has it (a Secret always comes without its values). */
export interface KubeObject<Spec = Record<string, unknown>, Status = Record<string, unknown>> {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
  spec?: Spec;
  status?: Status;
  [field: string]: unknown;
}

/** A cluster the extension may reach. */
export interface ClusterSummary {
  id: ClusterId;
  /** Its display name in Sextant (the context name unless renamed). */
  name: string;
  context: string;
  server: string;
  state: ConnectionState;
}

interface OnCluster {
  /** Default: the cluster of the context. */
  clusterId?: ClusterId;
}

export type KindsParams = OnCluster;

export interface ListParams extends OnCluster {
  kind: KindInput;
  /** One namespace; without it, every namespace the extension may read. */
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  /** At most this many objects (default 500, at most 5000). */
  limit?: number;
}

export interface ListResult<T = KubeObject> {
  items: T[];
  /** More objects were there than `limit`. */
  truncated: boolean;
  /** Without `namespace`, when the extension may read only some namespaces: the ones listed. */
  namespaces?: string[];
}

export interface GetParams extends OnCluster {
  ref: RefInput;
}

export interface WatchParams extends OnCluster {
  kind: KindInput;
  /** Only these namespaces; without them, every namespace the extension may read. */
  namespaces?: string[];
  labelSelector?: string;
  fieldSelector?: string;
  /** Only `{apiVersion, kind, metadata}` of each object. */
  metadataOnly?: boolean;
}

export interface ApplyParams extends OnCluster {
  /** One or more YAML documents. */
  yaml: string;
}

export interface PatchParams extends OnCluster {
  ref: RefInput;
  /** A merge patch (an object) or a JSON patch (a list of operations). */
  patch: JsonValue;
  patchType: PatchType;
}

export interface DeleteParams extends OnCluster {
  ref: RefInput;
}

export interface LogsParams extends OnCluster {
  namespace: string;
  pod: string;
  container?: string;
  /** The last this many lines (default 200). */
  lines?: number;
  /** The previous run of the container. */
  previous?: boolean;
}

export interface SecretParams extends OnCluster {
  namespace: string;
  name: string;
  key: string;
}

/** Every method: its parameters and its result. */
export interface Methods {
  "context.get": { params: undefined; result: HostContext };
  "ui.openDetails": { params: RefInput; result: null };
  "ui.navigate": { params: { page: string }; result: null };
  "ui.notify": { params: { text: string }; result: null };
  "ui.close": { params: undefined; result: null };
  "resources.unwatch": { params: { stream: string | number }; result: null };
  "clusters.list": { params: undefined; result: ClusterSummary[] };
  kinds: { params: { clusterId: ClusterId }; result: ResourceKind[] };
  "resources.list": { params: ListParams & { clusterId: ClusterId }; result: ListResult };
  "resources.get": { params: GetParams & { clusterId: ClusterId }; result: KubeObject };
  "resources.watch": { params: WatchParams & { clusterId: ClusterId }; result: { stream: string | number } };
  "resources.apply": { params: ApplyParams & { clusterId: ClusterId }; result: ObjectRef[] };
  "resources.patch": { params: PatchParams & { clusterId: ClusterId }; result: KubeObject };
  "resources.delete": { params: DeleteParams & { clusterId: ClusterId }; result: null };
  "logs.tail": { params: LogsParams & { clusterId: ClusterId }; result: string };
  "secret.value": { params: SecretParams & { clusterId: ClusterId }; result: string };
  "storage.get": { params: { key: string }; result: JsonValue };
  "storage.set": { params: { key: string; value: JsonValue }; result: null };
  "storage.remove": { params: { key: string }; result: null };
  "backend.call": { params: { method: string; params?: JsonValue }; result: JsonValue };
}

/** Options of one call. */
export interface CallOptions {
  /** How long to wait for the answer, in milliseconds (default: 60 s; changes, which may ask the user, 180 s). */
  timeoutMs?: number;
}
