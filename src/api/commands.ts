// One function per backend command (interfaces.md, "Commands"). Argument names are the camelCase names the
// Rust commands expect. Every function rejects with `ApiError`.
import type { AccessPreset } from "./generated/AccessPreset";
import type { AccessRule } from "./generated/AccessRule";
import type { AppSettings } from "./generated/AppSettings";
import type { ArgoLogin } from "./generated/ArgoLogin";
import type { ArgoStatus } from "./generated/ArgoStatus";
import type { AuditEntry } from "./generated/AuditEntry";
import type { ChartHit } from "./generated/ChartHit";
import type { ChartTarget } from "./generated/ChartTarget";
import type { CloudAccounts } from "./generated/CloudAccounts";
import type { CloudCliStatus } from "./generated/CloudCliStatus";
import type { CloudCluster } from "./generated/CloudCluster";
import type { CloudImport } from "./generated/CloudImport";
import type { CloudProblem } from "./generated/CloudProblem";
import type { CloudProvider } from "./generated/CloudProvider";
import type { CloudQuery } from "./generated/CloudQuery";
import type { CloudSearch } from "./generated/CloudSearch";
import type { ClusterId } from "./generated/ClusterId";
import type { ClusterInfo } from "./generated/ClusterInfo";
import type { ConnectionState } from "./generated/ConnectionState";
import type { DrainOptions } from "./generated/DrainOptions";
import type { DrainPreview } from "./generated/DrainPreview";
import type { ExtensionInfo } from "./generated/ExtensionInfo";
import type { ForwardInfo } from "./generated/ForwardInfo";
import type { ForwardTarget } from "./generated/ForwardTarget";
import type { HelmRelease } from "./generated/HelmRelease";
import type { HelmReleaseDetail } from "./generated/HelmReleaseDetail";
import type { HelmRepo } from "./generated/HelmRepo";
import type { HelmStatus } from "./generated/HelmStatus";
import type { KubeconfigSource } from "./generated/KubeconfigSource";
import type { LogOptions } from "./generated/LogOptions";
import type { ManagedResource } from "./generated/ManagedResource";
import type { McpStatus } from "./generated/McpStatus";
import type { MetricsStatus } from "./generated/MetricsStatus";
import type { NodeUsage } from "./generated/NodeUsage";
import type { ObjectRef } from "./generated/ObjectRef";
import type { PatchType } from "./generated/PatchType";
import type { PendingInstall } from "./generated/PendingInstall";
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
  /** Forgets the backend's discovery of the cluster (a CRD was created or deleted); the next `kinds` asks again. */
  refreshKinds: (clusterId: ClusterId) => call<void>("cluster_kinds_refresh", { clusterId }),
};

/**
 * Cloud clusters (EKS, GKE, AKS) through the user's own `aws`, `gcloud` and `az`. Sextant never signs in: a problem
 * carries the command the user runs (`aws sso login --profile …`, `gcloud auth login`, `az login`).
 */
export const cloud = {
  /** The three CLIs: installed or not, version, credential plugin. */
  status: () => call<CloudCliStatus[]>("cloud_status"),
  /** AWS profiles (and regions), GCP projects or Azure subscriptions; `problem` when the CLI is missing or signed out. */
  accounts: (provider: CloudProvider) => call<CloudAccounts>("cloud_accounts", { provider }),
  /** Clusters of an account (in the chosen regions for AWS). */
  find: (query: CloudQuery) => call<CloudSearch>("cloud_find", { query }),
  /** Writes the clusters to Sextant's own `cloud-<provider>.yaml` and saves the sources; refresh the cluster list after. */
  importClusters: (clusters: CloudCluster[]) => call<CloudImport>("cloud_import", { clusters }),
  /** How to sign in again (or what to install) for a cluster whose sign-in failed; `null` if not a cloud cluster. */
  loginHint: (clusterId: ClusterId) => call<CloudProblem | null>("cloud_login_hint", { clusterId }),
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
  /**
   * Merge patch (an object) or JSON patch (a list of operations) of one object, signed by `sextant`; resolves to the
   * object as saved (a Secret without its values).
   */
  patch: (clusterId: ClusterId, ref: ObjectRef, patch: unknown, patchType: PatchType) =>
    call<KubeObject>("resource_patch", { clusterId, ref, patch, patchType }),
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
  /**
   * Local shell, session `streamId`: with `KUBECONFIG` set to the cluster, or — `clusterId` null — without any
   * `KUBECONFIG` from Sextant (e.g. to sign in to a cloud CLI).
   */
  local: (clusterId: ClusterId | null, cols: number, rows: number, streamId: string) =>
    call<void>("terminal_start", { clusterId, cols, rows, streamId }),
  /**
   * Shell on `node` through a temporary privileged pod in `kube-system` (deleted when the session ends), session
   * `streamId`. Never offered to AI agents.
   */
  nodeShell: (clusterId: ClusterId, node: string, cols: number, rows: number, streamId: string) =>
    call<void>("node_shell_start", { clusterId, node, cols, rows, streamId }),
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

/**
 * Argo CD API through a port forward to `argocd-server`. Passwords and tokens only go in (`login`); nothing the
 * backend answers carries one.
 */
export const argocd = {
  /** Whether Argo CD is signed in for the cluster (does not sign in). */
  status: (clusterId: ClusterId) => call<ArgoStatus>("argocd_status", { clusterId }),
  /** Signs in with a user name and password or an API token; `remember` saves it in the OS credential store. */
  login: (clusterId: ClusterId, login: ArgoLogin) => call<ArgoStatus>("argocd_login", { clusterId, login }),
  /** Ends the session; `forget` also deletes the saved login. */
  logout: (clusterId: ClusterId, forget: boolean) =>
    call<ArgoStatus>("argocd_logout", { clusterId, options: { forget } }),
  /**
   * Desired (Git) and live states of an Application's resources; Secret values are `""`. Signs in by itself from the
   * saved login or the standard secrets; rejects with `unauthorized` when none works (show the sign-in window).
   */
  diff: (clusterId: ClusterId, app: ObjectRef) => call<ManagedResource[]>("argocd_diff", { clusterId, app }),
};

/** AI agent access rules of a cluster (`ClusterSettings.agentAccess`). */
export const access = {
  /** The rules a preset stands for (empty for `off` and `custom`); the only source of preset rules. */
  presetRules: (preset: AccessPreset) => call<AccessRule[]>("access_preset_rules", { preset }),
};

/**
 * The built-in MCP server for AI agents: status, token, the journal of calls and the answers to confirmation requests
 * (`mcp-confirm`). The server starts and stops with `settings.mcp`.
 */
export const mcp = {
  status: () => call<McpStatus>("mcp_status"),
  /** The real token (created on first use); ask only when the user shows or copies it. */
  token: () => call<string>("mcp_token"),
  /** A new token: the old one stops working at once and agent sessions end. Resolves to the new token. */
  regenerateToken: () => call<string>("mcp_regenerate_token"),
  /** Calls of agents, newest first; one cluster's only when `clusterId` is given. */
  auditList: (clusterId: ClusterId | null = null) => call<AuditEntry[]>("mcp_audit_list", { clusterId }),
  auditClear: () => call<void>("mcp_audit_clear"),
  /** Answers an `mcp-confirm` request; rejects with `notFound` when it no longer waits. */
  confirmAnswer: (id: string, approved: boolean) => call<void>("mcp_confirm_answer", { id, approved }),
  /** Path of the running Sextant executable, for the Claude Desktop snippet. */
  binaryPath: () => call<string>("mcp_binary_path"),
};

/**
 * Installed extensions (`ExtensionInfo`), installing one after the user's consent, and the API their frames call.
 * Installing is two steps: `inspect*` checks a package and keeps it for 10 minutes under a token; `install(token)` is
 * the consent click. Changes of the list come as `events.onExtensionsChanged`.
 */
export const extensions = {
  list: () => call<ExtensionInfo[]>("extensions_list"),
  /** Checks a `.sextant-ext` / `.zip` file; installs nothing. */
  inspectFile: (path: string) => call<PendingInstall>("extension_inspect_file", { path }),
  /** Downloads a GitHub release asset (`https://github.com/…/releases/download/…`) and checks it. */
  inspectUrl: (url: string) => call<PendingInstall>("extension_inspect_url", { url }),
  /** Checks an unpacked folder (development mode: it runs from there and reloads when its files change). */
  inspectFolder: (path: string) => call<PendingInstall>("extension_inspect_folder", { path }),
  /**
   * The user's consent to what `PendingInstall.manifest` asks for: installs it and grants its permissions. The token
   * is spent only on success; an error with the code `notFound` (and only that) means it is gone (expired, used, or
   * the package changed since its check) and the package has to be chosen again — any other error can be retried.
   */
  install: (token: string) => call<ExtensionInfo>("extension_install", { token }),
  /** The user declined: the checked package is dropped at once. An unknown or used token is not an error. */
  installCancel: (token: string) => call<void>("extension_install_cancel", { token }),
  setEnabled: (id: string, enabled: boolean) => call<ExtensionInfo>("extension_set_enabled", { id, enabled }),
  /** Removes the extension, its files and its `storage` data. */
  remove: (id: string) => call<void>("extension_remove", { id }),
  /** Reads the manifest and the files again (development mode). */
  reload: (id: string) => call<ExtensionInfo>("extension_reload", { id }),
  /**
   * One API method for an extension's frame (src/extensions/protocol.ts), checked in the backend against what the
   * user granted. `streamId` is needed by `resources.watch`: its updates come as `events.onExtWatch(streamId, …)`.
   */
  call: (extensionId: string, method: string, params?: unknown, streamId?: string) =>
    call<unknown>("extension_call", { extensionId, method, params, streamId }),
  /** Stops a `resources.watch` stream of the extension; an ended one is not an error. */
  watchStop: (extensionId: string, streamId: string) => call<void>("extension_watch_stop", { extensionId, streamId }),
  /** Calls of extensions, newest first; one extension's only when `extensionId` is given. */
  auditList: (extensionId: string | null = null) => call<AuditEntry[]>("extension_audit_list", { extensionId }),
  auditClear: () => call<void>("extension_audit_clear"),
};
