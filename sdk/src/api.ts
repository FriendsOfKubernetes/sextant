// The parameters and results of the extension API (Sextant's `src-tauri/src/extensions/api.rs` reads the parameters
// strictly: an unknown field is `invalid`). `clusterId` may be left out: it is the cluster of the frame's context.
import type { ClusterId } from "./generated/ClusterId";
import type { ConnectionState } from "./generated/ConnectionState";
import type { ForwardInfo } from "./generated/ForwardInfo";
import type { KindRef } from "./generated/KindRef";
import type { MetricAnswer } from "./generated/MetricAnswer";
import type { MetricQueryRange } from "./generated/MetricQueryRange";
import type { ObjectRef } from "./generated/ObjectRef";
import type { PatchType } from "./generated/PatchType";
import type { ResourceKind } from "./generated/ResourceKind";
import type { JsonValue } from "./generated/serde_json/JsonValue";
import type { WatchUpdate } from "./generated/WatchUpdate";
import type { HostContext } from "./protocol";

export type {
  ClusterId,
  ConnectionState,
  ForwardInfo,
  JsonValue,
  KindRef,
  MetricAnswer,
  MetricQueryRange,
  ObjectRef,
  PatchType,
  ResourceKind,
  WatchUpdate,
};

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

/** Up to 50 named objects in one call (`resources.getMany`). */
export interface GetManyParams extends OnCluster {
  refs: RefInput[];
}

/** Each object in its place: the object, or why it could not be read (`notFound`, …). */
export interface GetManyResult<T = KubeObject> {
  items: ({ object: T } | { error: { code: string; message: string } })[];
}

/** Runs a command of the manifest by id in `namespace` (`exec.run`, since Sextant 0.29). */
export interface ExecParams extends OnCluster {
  id: string;
  namespace: string;
  /** A value for each of its parameters. */
  params?: Record<string, string>;
}

export interface ExecResult {
  /** The pod it ran in. */
  pod: string;
  stdout: string;
  stderr: string;
  /** `null` when it did not end in time. */
  exitCode: number | null;
  /** stdout or stderr went past 256 KiB and was cut. */
  truncated: boolean;
  timedOut: boolean;
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
  /**
   * `status`: the status subresource of a custom kind the manifest lists in `permissions.statusPatches` (sextantApi 4,
   * since Sextant 0.30).
   */
  subresource?: "status";
}

/** A port forward to a Pod or Service (`portForward.start`, sextantApi 4 with the `portForward` permission). */
export interface ForwardStartParams extends OnCluster {
  namespace: string;
  kind: "Pod" | "Service";
  name: string;
  /** The port of the pod or service. */
  port: number;
  /** A local port of 127.0.0.1; a free one when left out. */
  localPort?: number;
}

/** A running forward of the extension, with `address` (`127.0.0.1:<local port>`) when just started. */
export type ForwardResult = ForwardInfo & { address?: string };

/** One request to a service of the manifest (`service.request`, sextantApi 4, since Sextant 0.30). */
export interface ServiceRequestParams extends OnCluster {
  namespace: string;
  /** The id of one of the manifest's `contributes.services`. */
  service: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** A plain absolute path: no query (that goes in `query`), `#`, `.` or `..` segment. */
  path: string;
  /** Encoded by Sextant. */
  query?: Record<string, string>;
  /** JSON. A string value exactly `{{secret:<name>/<key>}}` is that key of a Secret of `namespace`, put in by Sextant. */
  body?: JsonValue;
  /** `session`: Sextant adds the token it keeps for this service (see `capture`). */
  auth?: "session";
  /** A field path of the JSON answer holding a token: Sextant keeps it as the session, the answer shows `<hidden>`. */
  capture?: string;
}

/** The service's answer: any status (a 401 is an answer, not an error), JSON or text, Secrets in it emptied. */
export interface ServiceAnswer<T = JsonValue> {
  status: number;
  body: T;
}

/** What `ui.openLogs` opens in Sextant's logs tab: one pod (and container), or the pods a label selector picks. */
export type OpenLogsParams =
  | { namespace: string; pod: string; container?: string }
  | { namespace: string; labelSelector: string };

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

export interface MetricQueryParams extends OnCluster {
  /** The id of one of the manifest's `contributes.metricQueries`. */
  id: string;
  /** A value for each of the query's parameters, by name. */
  params?: Record<string, string>;
  /** Over the last `minutes`, a point every `step`; the manifest's `range.maxHours` allows it. Default: now only. */
  range?: MetricQueryRange;
}

/** Every method: its parameters and its result. */
export interface Methods {
  "context.get": { params: undefined; result: HostContext };
  "ui.openDetails": { params: RefInput; result: null };
  "ui.navigate": { params: { page: string }; result: null };
  "ui.notify": { params: { text: string }; result: null };
  "ui.close": { params: undefined; result: null };
  "ui.openLogs": { params: OpenLogsParams; result: null };
  "ui.openUrl": { params: { url: string }; result: { opened: boolean } };
  "ui.signIn": { params: { clusterId?: ClusterId; namespace: string; service: string }; result: { signedIn: boolean } };
  "resources.unwatch": { params: { stream: string | number }; result: null };
  "clusters.list": { params: undefined; result: ClusterSummary[] };
  kinds: { params: { clusterId: ClusterId }; result: ResourceKind[] };
  "resources.list": { params: ListParams & { clusterId: ClusterId }; result: ListResult };
  "resources.get": { params: GetParams & { clusterId: ClusterId }; result: KubeObject };
  "resources.getMany": { params: GetManyParams & { clusterId: ClusterId }; result: GetManyResult };
  "resources.watch": { params: WatchParams & { clusterId: ClusterId }; result: { stream: string | number } };
  "resources.apply": { params: ApplyParams & { clusterId: ClusterId }; result: ObjectRef[] };
  "resources.patch": { params: PatchParams & { clusterId: ClusterId }; result: KubeObject };
  "resources.delete": { params: DeleteParams & { clusterId: ClusterId }; result: null };
  "logs.tail": { params: LogsParams & { clusterId: ClusterId }; result: string };
  "secret.value": { params: SecretParams & { clusterId: ClusterId }; result: string };
  "metrics.query": { params: MetricQueryParams & { clusterId: ClusterId }; result: MetricAnswer };
  "exec.run": { params: ExecParams & { clusterId: ClusterId }; result: ExecResult };
  "storage.get": { params: { key: string }; result: JsonValue };
  "storage.set": { params: { key: string; value: JsonValue }; result: null };
  "storage.remove": { params: { key: string }; result: null };
  "backend.call": { params: { method: string; params?: JsonValue }; result: JsonValue };
  "portForward.start": { params: ForwardStartParams & { clusterId: ClusterId }; result: ForwardResult };
  "portForward.list": { params: { clusterId?: ClusterId }; result: { forwards: ForwardInfo[] } };
  "portForward.stop": { params: { id: string }; result: null };
  "service.request": { params: ServiceRequestParams & { clusterId: ClusterId }; result: ServiceAnswer };
  "service.forget": { params: { clusterId: ClusterId; namespace: string; service: string }; result: null };
}

/** Options of one call. */
export interface CallOptions {
  /** How long to wait for the answer, in milliseconds (default: 60 s; changes, which may ask the user, 180 s). */
  timeoutMs?: number;
}
