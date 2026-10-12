// One function per backend command (interfaces.md, «Команды»). Argument names are the camelCase names the
// Rust commands expect. Every function rejects with `ApiError`.
import type { AppSettings } from "./generated/AppSettings";
import type { ChartHit } from "./generated/ChartHit";
import type { ChartTarget } from "./generated/ChartTarget";
import type { ClusterId } from "./generated/ClusterId";
import type { ClusterInfo } from "./generated/ClusterInfo";
import type { ConnectionState } from "./generated/ConnectionState";
import type { DrainOptions } from "./generated/DrainOptions";
import type { DrainPreview } from "./generated/DrainPreview";
import type { ForwardInfo } from "./generated/ForwardInfo";
import type { ForwardTarget } from "./generated/ForwardTarget";
import type { HelmRelease } from "./generated/HelmRelease";
import type { HelmReleaseDetail } from "./generated/HelmReleaseDetail";
import type { HelmRepo } from "./generated/HelmRepo";
import type { HelmStatus } from "./generated/HelmStatus";
import type { KubeconfigSource } from "./generated/KubeconfigSource";
import type { LogOptions } from "./generated/LogOptions";
import type { MetricsStatus } from "./generated/MetricsStatus";
import type { NodeUsage } from "./generated/NodeUsage";
import type { ObjectRef } from "./generated/ObjectRef";
import type { PodUsage } from "./generated/PodUsage";
import type { ResourceKind } from "./generated/ResourceKind";
import type { Series } from "./generated/Series";
import type { SettingsStatus } from "./generated/SettingsStatus";
import type { WatchSpec } from "./generated/WatchSpec";
import { call } from "./transport";

/** A Kubernetes object as JSON (`managedFields` already stripped by the backend). */
export type KubeObject = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export const clusters = {
  list: () => call<ClusterInfo[]>("clusters_list"),
  sources: () => call<KubeconfigSource[]>("kubeconfig_sources"),
  addFile: (path: string) => call<KubeconfigSource>("kubeconfig_add_file", { path }),
  addPasted: (text: string) => call<KubeconfigSource>("kubeconfig_add_pasted", { text }),
  removeSource: (sourceId: string) => call<void>("kubeconfig_remove", { sourceId }),
  connect: (clusterId: ClusterId) => call<void>("cluster_connect", { clusterId }),
  disconnect: (clusterId: ClusterId) => call<void>("cluster_disconnect", { clusterId }),
  state: (clusterId: ClusterId) => call<ConnectionState>("cluster_state", { clusterId }),
  kinds: (clusterId: ClusterId) => call<ResourceKind[]>("cluster_kinds", { clusterId }),
};

/** Every stream (watch, logs, terminal) gets its id from the frontend, which listens before it starts the stream. */
export const streams = {
  /** Stops every watch, log stream and terminal session (not connections or port forwards); on page load. */
  reset: () => call<void>("streams_reset"),
};

export const resources = {
  /** Starts a watch under `streamId`; updates arrive through `events.onWatch(streamId, …)`. */
  watchStart: (clusterId: ClusterId, spec: WatchSpec, streamId: string) =>
    call<void>("watch_start", { clusterId, spec, streamId }),
  watchStop: (subscriptionId: string) => call<void>("watch_stop", { subscriptionId }),
  get: (clusterId: ClusterId, ref: ObjectRef) => call<KubeObject>("resource_get", { clusterId, ref }),
  /** The whole object, Secret values included (only for editing a Secret). */
  getFull: (clusterId: ClusterId, ref: ObjectRef) => call<KubeObject>("resource_get_full", { clusterId, ref }),
  /** One value of a Secret, decoded as text. */
  secretValue: (clusterId: ClusterId, namespace: string, name: string, key: string) =>
    call<string>("secret_value", { clusterId, namespace, name, key }),
  replace: (clusterId: ClusterId, yaml: string) => call<KubeObject>("resource_replace", { clusterId, yaml }),
  apply: (clusterId: ClusterId, yaml: string) => call<ObjectRef[]>("resource_apply", { clusterId, yaml }),
  delete: (clusterId: ClusterId, ref: ObjectRef) => call<void>("resource_delete", { clusterId, ref }),
};

export const actions = {
  scale: (clusterId: ClusterId, ref: ObjectRef, replicas: number) =>
    call<void>("workload_scale", { clusterId, ref, replicas }),
  restart: (clusterId: ClusterId, ref: ObjectRef) => call<void>("workload_restart", { clusterId, ref }),
  cordon: (clusterId: ClusterId, name: string, unschedulable: boolean) =>
    call<void>("node_cordon", { clusterId, name, unschedulable }),
  drainPreview: (clusterId: ClusterId, name: string) => call<DrainPreview>("node_drain_preview", { clusterId, name }),
  drain: (clusterId: ClusterId, name: string, options: DrainOptions) =>
    call<void>("node_drain", { clusterId, name, options }),
  triggerCronJob: (clusterId: ClusterId, ref: ObjectRef) => call<ObjectRef>("cronjob_trigger", { clusterId, ref }),
  suspendCronJob: (clusterId: ClusterId, ref: ObjectRef, suspend: boolean) =>
    call<void>("cronjob_suspend", { clusterId, ref, suspend }),
};

export const logs = {
  /** Starts a log stream under `streamId`; batches arrive through `events.onLogs(streamId, …)`. */
  start: (clusterId: ClusterId, pod: ObjectRef, opts: LogOptions, streamId: string) =>
    call<void>("logs_start", { clusterId, pod, opts, streamId }),
  stop: (streamId: string) => call<void>("logs_stop", { streamId }),
};

export const terminal = {
  /** Shell in a container, session `streamId` (output: `events.onTerm(streamId, …)`). */
  exec: (clusterId: ClusterId, pod: ObjectRef, container: string, cols: number, rows: number, streamId: string) =>
    call<void>("exec_start", { clusterId, pod, container, cols, rows, streamId }),
  /** Local shell with `KUBECONFIG` set to the cluster, session `streamId`. */
  local: (clusterId: ClusterId, cols: number, rows: number, streamId: string) =>
    call<void>("terminal_start", { clusterId, cols, rows, streamId }),
  input: (sessionId: string, data: string) => call<void>("term_input", { sessionId, data }),
  resize: (sessionId: string, cols: number, rows: number) => call<void>("term_resize", { sessionId, cols, rows }),
  stop: (sessionId: string) => call<void>("term_stop", { sessionId }),
};

export const portForward = {
  start: (clusterId: ClusterId, target: ForwardTarget, remotePort: number, localPort: number | null = null) =>
    call<ForwardInfo>("portforward_start", { clusterId, target, remotePort, localPort }),
  list: () => call<ForwardInfo[]>("portforward_list"),
  stop: (id: string) => call<void>("portforward_stop", { id }),
};

export const metrics = {
  pods: (clusterId: ClusterId, namespaces: string[] | null = null) =>
    call<PodUsage[]>("metrics_pods", { clusterId, namespaces }),
  nodes: (clusterId: ClusterId) => call<NodeUsage[]>("metrics_nodes", { clusterId }),
  status: (clusterId: ClusterId) => call<MetricsStatus>("metrics_status", { clusterId }),
  charts: (clusterId: ClusterId, chart: ChartTarget, rangeSecs: number) =>
    call<Series[]>("metrics_charts", { clusterId, chart, rangeSecs }),
};

export const helm = {
  status: () => call<HelmStatus>("helm_status"),
  releases: (clusterId: ClusterId, namespaces: string[] | null = null) =>
    call<HelmRelease[]>("helm_releases", { clusterId, namespaces }),
  releaseDetail: (clusterId: ClusterId, namespace: string, name: string, revision: number | null = null) =>
    call<HelmReleaseDetail>("helm_release_detail", { clusterId, namespace, name, revision }),
  releaseHistory: (clusterId: ClusterId, namespace: string, name: string) =>
    call<HelmRelease[]>("helm_release_history", { clusterId, namespace, name }),
  upgrade: (clusterId: ClusterId, namespace: string, release: string, chartRef: string, valuesYaml: string) =>
    call<void>("helm_upgrade", { clusterId, namespace, release, chartRef, valuesYaml }),
  rollback: (clusterId: ClusterId, namespace: string, release: string, revision: number) =>
    call<void>("helm_rollback", { clusterId, namespace, release, revision }),
  uninstall: (clusterId: ClusterId, namespace: string, release: string) =>
    call<void>("helm_uninstall", { clusterId, namespace, release }),
  install: (
    clusterId: ClusterId,
    namespace: string,
    release: string,
    chart: string,
    version: string | null,
    valuesYaml: string,
  ) => call<void>("helm_install", { clusterId, namespace, release, chart, version, valuesYaml }),
  repos: () => call<HelmRepo[]>("helm_repos"),
  repoAdd: (name: string, url: string, username?: string, password?: string) =>
    call<void>("helm_repo_add", { name, url, username, password }),
  repoRemove: (name: string) => call<void>("helm_repo_remove", { name }),
  repoUpdate: () => call<void>("helm_repo_update"),
  search: (query: string) => call<ChartHit[]>("helm_search", { query }),
  showValues: (chart: string, version: string | null = null) => call<string>("helm_show_values", { chart, version }),
};

export const settings = {
  get: () => call<AppSettings>("settings_get"),
  /** Replaces the settings; resolves to what was stored. Prefer `updateSettings` / `useSettings().update`. */
  update: (value: AppSettings) => call<AppSettings>("settings_update", { settings: value }),
  /** Whether the settings file was readable and is being saved. */
  status: () => call<SettingsStatus>("settings_status"),
};

export const files = {
  save: (path: string, contents: string) => call<void>("file_save", { path, contents }),
};
